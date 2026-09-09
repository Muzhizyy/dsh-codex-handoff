import { HARD_LIMITS } from '../shared/limits.js'
import { redactDiagnostic, redactJson } from '../shared/redaction.js'
import { AgentHandoffManifestSchema, type JsonValue } from '../shared/schemas.js'
import type { AgentHandoffManifest, AnalysisClaims, Diagnostic, ManifestText, NormalizedSession, RepositoryState } from '../shared/types.js'
import type { StateReconciler } from '../shared/ports.js'
import { redactAnalysisClaims } from './evidence.js'
import { boundedUtf8, diagnostic, provenance, sourceId } from './util.js'

export interface ReconcilerOptions {
  readonly now?: () => Date
  readonly analyzer?: 'dsh-model' | 'deterministic-fallback'
}

function repoSource(kind: string, locator: string): string {
  return sourceId(`repo:${kind}:${locator}`)
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function cloneBoundaryJson(value: unknown, stack = new WeakSet<object>()): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value
  if (value === undefined || typeof value !== 'object') return '[REDACTED]'
  if (stack.has(value)) return '[REDACTED]'
  stack.add(value)
  if (Array.isArray(value)) {
    const output = value.map(item => cloneBoundaryJson(item, stack))
    stack.delete(value)
    return output
  }
  const output: Record<string, JsonValue> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item !== undefined) output[key] = cloneBoundaryJson(item, stack)
  }
  stack.delete(value)
  return output
}

function withoutScope<T extends object>(value: T): Omit<T, 'scope' | 'order' | 'timestamp'> {
  // Recency metadata belongs to the v2 analysis input only.  The persisted
  // manifest is still the stable v1 handoff contract, so never leak it into
  // strict ManifestText schemas.
  const { scope: _scope, order: _order, timestamp: _timestamp, ...rest } = value as T & { scope?: unknown; order?: unknown; timestamp?: unknown }
  return rest as Omit<T, 'scope' | 'order' | 'timestamp'>
}

function text(value: string, sourceIds: readonly string[], confidence: 'high' | 'medium' | 'low' = 'medium'): ManifestText {
  return { text: boundedUtf8(value, HARD_LIMITS.normalizedTextBytes), sourceIds: unique(sourceIds), confidence }
}

function claimScope(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const scope = (value as { scope?: unknown }).scope
  return typeof scope === 'string' && scope.trim() !== '' ? scope.trim() : undefined
}

function compareRecency(left: { readonly at?: string | undefined; readonly timestamp?: string | undefined; readonly order?: number | undefined }, right: { readonly at?: string | undefined; readonly timestamp?: string | undefined; readonly order?: number | undefined }): number {
  const leftTime = Date.parse(left.timestamp ?? left.at ?? '')
  const rightTime = Date.parse(right.timestamp ?? right.at ?? '')
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime
  if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) return Number.isFinite(leftTime) ? 1 : -1
  return (left.order ?? 0) - (right.order ?? 0)
}

function latestStatus(claims: AnalysisClaims): 'passing' | 'failing' | 'mixed' | 'unknown' {
  const records = [
    ...claims.testsPassed.map((item, order) => ({ state: 'passing' as const, item, order })),
    ...claims.testsFailed.map((item, order) => ({ state: 'failing' as const, item, order })),
  ]
  if (records.length === 0) return 'unknown'
  const bySubject = new Map<string, typeof records>()
  for (const record of records) {
    const subject = (record.item.name ?? record.item.text ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
    const prior = bySubject.get(subject) ?? []
    prior.push(record)
    bySubject.set(subject, prior)
  }
  const selected: ('passing' | 'failing')[] = []
  for (const subjectRecords of bySubject.values()) {
    const byScope = new Map<string, typeof subjectRecords>()
    for (const record of subjectRecords) {
      const scope = claimScope(record.item) ?? '(unknown-scope)'
      const prior = byScope.get(scope) ?? []
      prior.push(record)
      byScope.set(scope, prior)
    }
    for (const [scope, scoped] of byScope) {
      const states = new Set(scoped.map(record => record.state))
      // Unknown scope cannot safely establish ordering/provenance. Preserve
      // pass+fail as ambiguous instead of guessing from transcript order.
      if (scope === '(unknown-scope)' && states.size > 1) return 'mixed'
      const latest = [...scoped].sort((left, right) => compareRecency(
        { at: left.item.at, timestamp: (left.item as { timestamp?: string }).timestamp, order: (left.item as { order?: number }).order ?? left.order },
        { at: right.item.at, timestamp: (right.item as { timestamp?: string }).timestamp, order: (right.item as { order?: number }).order ?? right.order },
      )).at(-1)
      if (latest !== undefined) selected.push(latest.state)
    }
  }
  return new Set(selected).size === 1 ? (selected[0] ?? 'unknown') : selected.length === 0 ? 'unknown' : 'mixed'
}

function latestBuildStatus(claims: AnalysisClaims): 'passing' | 'failing' | 'unknown' {
  const builds = claims.commandsRun.filter(item => /\b(?:build|compile|typecheck)\b/i.test(item.commandSummary))
  const scopedStates = new Map<string, Set<'passing' | 'failing'>>()
  for (const item of builds) {
    if (item.result === 'unknown') continue
    const key = `${claimScope(item) ?? '(unknown-scope)'}\u0000${item.commandSummary.trim().replace(/\s+/g, ' ').toLowerCase()}`
    const states = scopedStates.get(key) ?? new Set<'passing' | 'failing'>()
    states.add(item.result === 'passed' ? 'passing' : 'failing')
    scopedStates.set(key, states)
  }
  if ([...scopedStates.entries()].some(([key, states]) => key.startsWith('(unknown-scope)\u0000') && states.size > 1)) return 'unknown'
  const selected = [...scopedStates.keys()].map(scope => builds.map((item, order) => ({ item, order })).filter(({ item }) => `${claimScope(item) ?? '(unknown-scope)'}\u0000${item.commandSummary.trim().replace(/\s+/g, ' ').toLowerCase()}` === scope).sort((left, right) => compareRecency({ at: left.item.at, timestamp: (left.item as { timestamp?: string }).timestamp, order: (left.item as { order?: number }).order ?? left.order }, { at: right.item.at, timestamp: (right.item as { timestamp?: string }).timestamp, order: (right.item as { order?: number }).order ?? right.order })).at(-1)?.item).filter((item): item is NonNullable<typeof item> => item !== undefined)
  const states = new Set(selected.map(item => item.result === 'passed' ? 'passing' : 'failing'))
  if (states.size > 1) return 'unknown'
  const latest = selected.sort((left, right) => compareRecency({ at: left.at, timestamp: (left as { timestamp?: string }).timestamp, order: (left as { order?: number }).order }, { at: right.at, timestamp: (right as { timestamp?: string }).timestamp, order: (right as { order?: number }).order })).at(-1)
  if (latest === undefined || latest.result === 'unknown') return 'unknown'
  return latest.result === 'passed' ? 'passing' : 'failing'
}

function allGitPaths(repository: RepositoryState): Set<string> {
  const paths = new Set<string>()
  const git = repository.git
  if (git === undefined) return paths
  for (const item of [...git.modified, ...git.added, ...git.deleted, ...git.untracked]) paths.add(item.path.replaceAll('\\', '/'))
  for (const item of git.renamed) { paths.add(item.path.replaceAll('\\', '/')); if (item.oldPath !== undefined) paths.add(item.oldPath.replaceAll('\\', '/')) }
  for (const item of [...git.staged, ...git.unstaged]) paths.add(item.replaceAll('\\', '/'))
  return paths
}

function repositoryChanges(repository: RepositoryState) {
  const git = repository.git
  return {
    modified: git?.modified.map(item => item.path.replaceAll('\\', '/')) ?? [],
    added: git?.added.map(item => item.path.replaceAll('\\', '/')) ?? [],
    deleted: git?.deleted.map(item => item.path.replaceAll('\\', '/')) ?? [],
    renamed: git?.renamed.map(item => ({ from: (item.oldPath ?? '').replaceAll('\\', '/'), to: item.path.replaceAll('\\', '/') })) ?? [],
    untracked: git?.untracked.map(item => item.path.replaceAll('\\', '/')) ?? [],
    staged: git?.staged.map(item => item.replaceAll('\\', '/')) ?? [],
    unstaged: git?.unstaged.map(item => item.replaceAll('\\', '/')) ?? [],
  }
}

function mentionedPaths(value: string): string[] {
  const matches = value.match(/(?:^|[\s"'`([{])((?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|md|json|yaml|yml|toml))(?=$|[\s"'`\])},:;])/g) ?? []
  return [...new Set(matches.map(item => item.trim().replace(/^[\s"'`([{]+/, '').replace(/[\\.,;:!?]+$/g, '')))]
}

/**
 * Reconciles candidate claims against current repository observations.  The
 * candidate side may be model-produced, but every repository field is written
 * here from the injected RepositoryState only.
 */
export class DeterministicStateReconciler implements StateReconciler {
  readonly now: () => Date
  readonly analyzer: 'dsh-model' | 'deterministic-fallback'
  constructor(options: ReconcilerOptions = {}) {
    this.now = options.now ?? (() => new Date())
    this.analyzer = options.analyzer ?? 'deterministic-fallback'
  }

  reconcile(session: NormalizedSession, claims: AnalysisClaims, repository: RepositoryState): AgentHandoffManifest {
    // Re-redact at the Host boundary even when a caller bypasses the normal
    // evidence/analyzer pipeline. Raw claims must never reach the manifest or
    // compiler payload.
    claims = redactAnalysisClaims(claims, { rebuildIds: true })
    const generatedAt = this.now().toISOString()
    const records = new Map<string, (typeof claims.provenance)[number]>()
    for (const record of claims.provenance) records.set(record.id, record)
    const diagnostics: Diagnostic[] = [...session.diagnostics, ...claims.diagnostics, ...repository.diagnostics].map(item => redactDiagnostic(item))
    const repoCwdId = repoSource('cwd', repository.cwd.canonical)
    records.set(repoCwdId, provenance(repoCwdId, 'filesystem', repository.cwd.canonical, 'high', false, repository.observedAt))
    const git = repository.git
    if (git !== undefined) {
      const gitId = repoSource('git', `${git.repoRoot}:${git.head}`)
      records.set(gitId, provenance(gitId, 'git', `${git.repoRoot}:${git.head}`, 'high', false, repository.observedAt))
      for (const path of allGitPaths(repository)) {
        const id = repoSource('git-path', path)
        records.set(id, provenance(id, 'git', path, 'high', false, repository.observedAt))
      }
    }
    const observations = new Map(repository.relevantPaths.map(item => [item.path.replaceAll('\\', '/'), item]))
    const currentGitPaths = allGitPaths(repository)
    for (const item of repository.relevantPaths) {
      const id = repoSource('path', item.path)
      records.set(id, provenance(id, 'filesystem', item.path, 'high', false, item.observedAt))
    }
    const fallbackId = sourceId('inference:missing-objective')
    records.set(fallbackId, provenance(fallbackId, 'inferred', 'missing-objective', 'low', false, generatedAt))
    const validSource = (ids: readonly string[], fallback = fallbackId): string[] => {
      const result = unique(ids.filter(id => records.has(id)))
      return result.length === 0 ? [fallback] : result
    }
    const addRepo = (ids: readonly string[], path?: string): string[] => {
      const repoId = path === undefined ? repoCwdId : repoSource('path', path)
      return unique([...validSource(ids), ...(records.has(repoId) ? [repoId] : [])])
    }
    const objective = claims.objective === undefined
      ? text('Continue the unfinished work described by the imported session.', [fallbackId], 'low')
      : { ...withoutScope(claims.objective), sourceIds: validSource(claims.objective.sourceIds) }
    const currentProblems = claims.currentProblems.map(item => ({ ...withoutScope(item), sourceIds: validSource(item.sourceIds) }))
    const claimedFiles = claims.relevantFiles.map(item => {
      const path = item.path.replaceAll('\\', '/')
      const observation = observations.get(path)
      const exists = observation?.exists ?? false
      const sourceIds = addRepo(item.sourceIds, path)
      const change = item.change === undefined
        ? undefined
        : currentGitPaths.has(path)
          ? item.change
          : 'Historical attempt no longer present in current repository.'
      return {
        ...withoutScope(item),
        text: item.text,
        sourceIds,
        confidence: item.confidence,
        path,
        exists,
        ...(change === undefined ? {} : { change }),
        scope: claimScope(item),
      }
    })
    const observedFiles = repository.relevantPaths.map(item => ({
      ...text(`${item.path}: ${item.exists ? 'present' : 'missing'} in the current filesystem.`, [repoSource('path', item.path)], 'high'),
      path: item.path.replaceAll('\\', '/'),
      exists: item.exists,
    }))
    const fileMap = new Map(claimedFiles.map(item => [`${item.path}\u0000${item.scope ?? ''}`, item]))
    for (const observed of observedFiles) {
      const key = `${observed.path}\u0000`
      const prior = fileMap.get(key)
      fileMap.set(key, prior === undefined ? { ...observed, scope: undefined } : {
        ...prior,
        ...observed,
        sourceIds: unique([...prior.sourceIds, ...observed.sourceIds]),
        ...(prior.change === undefined ? {} : { change: prior.change }),
      })
    }
    const relevantFiles = [...fileMap.values()].map(item => {
      return withoutScope(item)
    })
    if (claims.relevantFiles.some(item => observations.get(item.path.replaceAll('\\', '/'))?.exists === false)) {
      diagnostics.push(diagnostic('CODEX_PARTIAL_PARSE', 'A historical file mention is not present in the current repository.', true))
    }
    const source = {
      agent: 'codex' as const,
      sessionId: session.source.sessionId,
      rolloutRevisionId: session.source.rolloutRevisionId,
      fingerprint: session.source.fingerprint,
      ...(session.source.startedAt === undefined ? {} : { startedAt: session.source.startedAt }),
      ...(session.source.updatedAt === undefined ? {} : { updatedAt: session.source.updatedAt }),
    }
    const failedAttemptsWithPresence = claims.failedAttempts.map(item => {
      const paths = mentionedPaths(item.text)
      const observationsForPaths = paths.map(path => observations.get(path.replaceAll('\\', '/'))).filter((value): value is NonNullable<typeof value> => value !== undefined)
      const presence = currentGitPaths.size > 0 && paths.some(path => currentGitPaths.has(path.replaceAll('\\', '/')))
        ? true
        : observationsForPaths.length > 0 && observationsForPaths.every(value => !value.exists)
          ? false
          : item.currentRepoPresence
      return { ...withoutScope(item), currentRepoPresence: presence }
    })
    const reconciledDecisions = claims.decisions.map(item => ({
      ...withoutScope(item),
      // A current objective does not invalidate historical plans. Only an
      // explicit completion/replacement statement or an already-superseded
      // source record can close a decision here.
      // Free text is not a conflict protocol. Only an explicit structured
      // status from the source may supersede a decision.
      status: item.status,
      sourceIds: validSource(item.sourceIds),
    }))
    const manifest: AgentHandoffManifest = {
      schemaVersion: '1.0.0',
      generatedAt,
      mode: 'smart',
      source,
      objective,
      workspace: {
        cwd: repository.cwd.canonical,
        ...(git === undefined ? {} : { repoRoot: git.repoRoot, ...(git.branch === undefined ? {} : { branch: git.branch }), detached: git.detached, head: git.head, dirty: git.dirty }),
      },
      progress: {
        completed: claims.completed.map(item => ({ ...withoutScope(item), sourceIds: validSource(item.sourceIds) })),
        inProgress: claims.inProgress.map(item => ({ ...withoutScope(item), sourceIds: validSource(item.sourceIds) })),
        blocked: claims.blocked.map(item => ({ ...withoutScope(item), sourceIds: validSource(item.sourceIds) })),
      },
      decisions: reconciledDecisions,
      failedAttempts: failedAttemptsWithPresence.map(item => ({ ...item, sourceIds: validSource(item.sourceIds) })),
      currentProblems,
      relevantFiles,
      repositoryChanges: repositoryChanges(repository),
      verification: {
        commandsRun: claims.commandsRun.map(item => ({ ...withoutScope(item), sourceIds: validSource(item.sourceIds) })),
        testsPassed: claims.testsPassed.map(item => ({ ...withoutScope(item), sourceIds: validSource(item.sourceIds) })),
        testsFailed: claims.testsFailed.map(item => ({ ...withoutScope(item), sourceIds: validSource(item.sourceIds) })),
        latestStatus: latestStatus(claims),
        buildStatus: latestBuildStatus(claims),
      },
      constraints: claims.constraints.map(item => ({ ...withoutScope(item), sourceIds: validSource(item.sourceIds) })),
      openQuestions: claims.openQuestions.map(item => ({ ...withoutScope(item), sourceIds: validSource(item.sourceIds) })),
      nextActions: claims.nextActions.map(item => ({ ...withoutScope(item), sourceIds: validSource(item.sourceIds) })),
      provenance: [...records.values()].slice(0, HARD_LIMITS.provenanceRecords),
      completeness: { ...session.completeness, analyzer: this.analyzer, omittedByBudget: {} },
      diagnostics: diagnostics.slice(0, HARD_LIMITS.diagnostics),
    }
    // Repository paths, provenance locators and all diagnostic metadata are
    // also untrusted at this boundary.  Apply one deep JSON-safe pass after
    // composition so fields added by reconciliation cannot bypass redaction.
    return AgentHandoffManifestSchema.parse(redactJson(cloneBoundaryJson(manifest)))
  }
}

export const reconcileState = (session: NormalizedSession, claims: AnalysisClaims, repository: RepositoryState, options?: ReconcilerOptions): AgentHandoffManifest => new DeterministicStateReconciler(options).reconcile(session, claims, repository)
