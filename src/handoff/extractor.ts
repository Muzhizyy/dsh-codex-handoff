import { HARD_LIMITS } from '../shared/limits.js'
import { AnalysisClaimsSchema } from '../shared/schemas.js'
import type { AnalysisClaims, EvidenceBundle, ManifestText, NormalizedEvent, NormalizedSession, WorkItem } from '../shared/types.js'
import type { ConversationAnalyzer } from '../shared/ports.js'
import { evidenceProvenance, redactAnalysisClaims } from './evidence.js'
import { boundedUtf8, sourceId, stableId } from './util.js'

export interface DeterministicExtractorOptions {
  readonly now?: () => Date
}

function itemSource(kind: 'conversation' | 'tool-result', event: NormalizedEvent): string {
  return sourceId(`${kind}\0${event.source.locator || event.id}`)
}

function textItem(text: string, sourceIds: readonly string[], confidence: 'high' | 'medium' | 'low' = 'medium'): ManifestText {
  return { text: boundedUtf8(text.trim(), HARD_LIMITS.normalizedTextBytes), sourceIds: [...new Set(sourceIds)].slice(0, HARD_LIMITS.provenanceRecords), confidence }
}

function work(text: string, sourceIds: readonly string[], status: WorkItem['status'], order: number): WorkItem {
  return { ...textItem(text, sourceIds, status === 'completed' ? 'high' : 'medium'), id: stableId('work', `${status}\0${order}\0${text}`), status }
}

function eventEvidenceId(event: NormalizedEvent): string {
  return sourceId(`${event.kind === 'tool-result' ? 'tool-result' : 'conversation'}\0${event.source.locator || event.id}`)
}

/** Deterministic extraction reads only the already-redacted evidence view. */
function textOf(event: NormalizedEvent, bySource: ReadonlyMap<string, string>): string {
  return bySource.get(eventEvidenceId(event)) ?? ''
}

function isPass(value: string): boolean {
  return /\b(?:pass(?:ed|ing)?|success(?:ful)?|ok|clean|green)\b/i.test(value) && !/\b(?:fail(?:ed|ure|ing)?|error|exception)\b/i.test(value)
}

function isFailure(value: string): boolean {
  return /\b(?:fail(?:ed|ure|ing)?|error|exception|broken|regression|cannot|could not|not found)\b/i.test(value)
}

function candidatePaths(text: string): string[] {
  const matches = text.match(/(?:^|[\s"'`([{])((?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|md|json|yaml|yml|toml))(?=$|[\s"'`\])},:;])/g) ?? []
  return [...new Set(matches.map(value => value.trim().replace(/^[\s"'`([{]+/, '').replace(/[\\.,;:!?]+$/g, '')).filter(value => value.length > 1 && !/^https?:/i.test(value) && !/\.env(?:\.|$)/i.test(value)))]
}

/** Pure fallback extractor. Transcript text is data and is never executed or treated as policy. */
export class DeterministicConversationAnalyzer implements ConversationAnalyzer {
  readonly now: () => Date
  constructor(options: DeterministicExtractorOptions = {}) { this.now = options.now ?? (() => new Date()) }

  async analyze(session: NormalizedSession, evidence: EvidenceBundle, signal: AbortSignal): Promise<AnalysisClaims> {
    if (signal.aborted) throw new Error('analysis cancelled')
    return extractDeterministicClaims(session, evidence, this.now())
  }
}

export function extractDeterministicClaims(session: NormalizedSession, evidence: EvidenceBundle, now = new Date()): AnalysisClaims {
  const provenanceRecords = evidenceProvenance(evidence, now.toISOString())
  const provenanceIds = new Set(provenanceRecords.map(item => item.id))
  const evidenceTextBySource = new Map(evidence.items.map(item => [item.sourceId, item.text]))
  const events = session.timeline.filter(event => event.kind !== 'lifecycle' && evidenceTextBySource.has(eventEvidenceId(event)))
  const userEvents = events.filter((event): event is Extract<NormalizedEvent, { kind: 'message' }> => event.kind === 'message' && event.role === 'user')
  const modelNarrative = events.filter((event): event is Extract<NormalizedEvent, { kind: 'message' }> | Extract<NormalizedEvent, { kind: 'reasoning-summary' }> => (event.kind === 'message' && event.role === 'assistant') || event.kind === 'reasoning-summary')
  const objectiveEvent = userEvents[0]
  const objective = objectiveEvent === undefined ? undefined : textItem(textOf(objectiveEvent, evidenceTextBySource), [itemSource('conversation', objectiveEvent)], 'high')
  const completed: WorkItem[] = []
  const inProgress: WorkItem[] = []
  const blocked: WorkItem[] = []
  if (objectiveEvent !== undefined) inProgress.push(work(textOf(objectiveEvent, evidenceTextBySource), [itemSource('conversation', objectiveEvent)], 'in-progress', objectiveEvent.order))
  const latestUser = userEvents.at(-1)
  if (latestUser !== undefined && latestUser !== objectiveEvent && /\b(?:continue|next|implement|fix|finish|please|todo|remaining)\b/i.test(textOf(latestUser, evidenceTextBySource))) {
    inProgress.push(work(textOf(latestUser, evidenceTextBySource), [itemSource('conversation', latestUser)], 'in-progress', latestUser.order))
  }
  for (const event of modelNarrative) {
    const safeText = textOf(event, evidenceTextBySource)
    if (/\b(?:implemented|fixed|completed|done|passing|verified)\b/i.test(safeText)) completed.push(work(safeText, [itemSource('conversation', event)], 'completed', event.order))
    else if (isFailure(safeText)) blocked.push(work(safeText, [itemSource('conversation', event)], 'blocked', event.order))
  }

  const decisions = modelNarrative.filter(event => /\b(?:decided|decision|plan(?:ned)?|will use|using|choose|chose|selected)\b/i.test(textOf(event, evidenceTextBySource))).map(event => ({
    ...textItem(textOf(event, evidenceTextBySource), [itemSource('conversation', event)], 'medium'),
    id: stableId('decision', `${event.order}\0${textOf(event, evidenceTextBySource)}`),
    status: 'active' as const,
  }))
  const constraints = userEvents.filter(event => /\b(?:must|should|need to|required|never|do not|don't|only)\b/i.test(textOf(event, evidenceTextBySource))).map(event => textItem(textOf(event, evidenceTextBySource), [itemSource('conversation', event)], 'high'))

  const commandsRun: Array<AnalysisClaims['commandsRun'][number]> = []
  const testsPassed: Array<AnalysisClaims['testsPassed'][number]> = []
  const testsFailed: Array<AnalysisClaims['testsFailed'][number]> = []
  const failedAttempts: Array<AnalysisClaims['failedAttempts'][number]> = []
  const currentProblems: Array<AnalysisClaims['currentProblems'][number]> = []
  const pendingCalls = new Map<string, Extract<NormalizedEvent, { kind: 'tool-call' }>>()
  for (const event of events) {
    if (event.kind === 'tool-call') pendingCalls.set(event.callId, event)
    if (event.kind !== 'tool-result') continue
    const call = pendingCalls.get(event.callId)
    const sources = [itemSource('tool-result', event), ...(call === undefined ? [] : [itemSource('conversation', call)])]
    const resultText = textOf(event, evidenceTextBySource)
    const failed = event.failed === true || isFailure(resultText)
    const safeCallText = call === undefined ? 'historical tool operation' : textOf(call, evidenceTextBySource)
    commandsRun.push({ ...textItem(safeCallText, sources, 'high'), commandSummary: boundedUtf8(safeCallText, 4096), result: failed ? 'failed' : isPass(resultText) ? 'passed' : 'unknown', ...(event.at === undefined ? {} : { at: event.at }) })
    if (/\b(?:test|tests|build|check|lint|typecheck|verification)\b/i.test(`${safeCallText} ${resultText}`)) {
      const name = boundedUtf8(safeCallText, 1024)
      const item = { ...textItem(name, sources, 'high'), name, ...(event.at === undefined ? {} : { at: event.at }) }
      if (failed) testsFailed.push(item)
      else if (isPass(resultText)) testsPassed.push(item)
    }
    if (failed) {
      failedAttempts.push({ ...textItem(safeCallText || 'Historical tool attempt failed.', sources, 'high'), id: stableId('attempt', event.id), reason: boundedUtf8(resultText, HARD_LIMITS.normalizedTextBytes), currentRepoPresence: 'unknown' as const })
      currentProblems.push({ ...textItem(resultText || 'A historical tool operation failed.', sources, 'high'), id: stableId('problem', event.id), severity: 'unknown' as const })
    }
  }

  // Path extraction is conversation-derived; repository reconciliation later
  // supplies the authoritative exists/change fields. Keep only bounded names.
  const relevantFiles: AnalysisClaims['relevantFiles'] = []
  for (const event of events) {
    for (const candidate of candidatePaths(textOf(event, evidenceTextBySource))) {
      const source = itemSource(event.kind === 'tool-result' ? 'tool-result' : 'conversation', event)
      const historicalChange = /\b(?:modif(?:y|ied|ication)|edit(?:ed|ing)?|changed|updated|implemented)\b/i.test(textOf(event, evidenceTextBySource))
        ? 'Historical transcript reports a change to this path.'
        : undefined
      relevantFiles.push({ ...textItem(candidate, [source], 'medium'), path: candidate, exists: false, ...(historicalChange === undefined ? {} : { change: historicalChange }) })
    }
  }
  const dedupedFiles = [...new Map(relevantFiles.map(item => [item.path, item])).values()]
  const nextActions = (latestUser === undefined ? [] : [latestUser]).filter(event => /\b(?:continue|next|implement|fix|finish|remaining|todo)\b/i.test(textOf(event, evidenceTextBySource))).map(event => ({ ...textItem(textOf(event, evidenceTextBySource), [itemSource('conversation', event)], 'high'), id: stableId('action', `${event.order}\0${textOf(event, evidenceTextBySource)}`), priority: 10, requiresVerification: true }))
  const diagnostics = [...session.diagnostics, ...evidence.diagnostics]
  // Evidence and claims share source ids; filtering here prevents an invalid
  // provenance edge if a caller supplies a bounded custom evidence bundle.
  const clean = (ids: readonly string[]) => ids.filter(id => provenanceIds.has(id))
  const cleanItems = <T extends { sourceIds: readonly string[] }>(items: readonly T[]): T[] => items
    .map(item => ({ ...item, sourceIds: clean(item.sourceIds) }))
    .filter(item => item.sourceIds.length > 0) as T[]
  const cleanObjective = objective === undefined ? undefined : { ...objective, sourceIds: clean(objective.sourceIds) }
  const baseClaims = {
    schemaVersion: 2 as const,
    ...(cleanObjective === undefined || cleanObjective.sourceIds.length === 0 ? {} : { objective: cleanObjective }),
    completed: cleanItems(completed),
    inProgress: cleanItems(inProgress),
    blocked: cleanItems(blocked),
    decisions: cleanItems(decisions),
    failedAttempts: cleanItems(failedAttempts),
    currentProblems: cleanItems(currentProblems),
    relevantFiles: cleanItems(dedupedFiles),
    commandsRun: cleanItems(commandsRun),
    testsPassed: cleanItems(testsPassed),
    testsFailed: cleanItems(testsFailed),
    constraints: cleanItems(constraints),
    openQuestions: [],
    nextActions: cleanItems(nextActions),
    provenance: provenanceRecords,
    diagnostics: diagnostics.slice(0, HARD_LIMITS.diagnostics),
  }
  let claimOrder = 0
  const timestampBySource = new Map(evidence.items.map(item => [item.sourceId, item.assertedAt ?? now.toISOString()]))
  const withRecency = <T extends { readonly sourceIds: readonly string[] }>(item: T): T & { readonly scope: string; readonly order: number; readonly timestamp: string } => ({
    ...item,
    scope: item.sourceIds[0] ?? 'unknown',
    order: claimOrder++,
    timestamp: timestampBySource.get(item.sourceIds[0] ?? '') ?? now.toISOString(),
  })
  const claims = {
    ...baseClaims,
    ...(baseClaims.objective === undefined ? {} : { objective: withRecency(baseClaims.objective) }),
    completed: baseClaims.completed.map(withRecency),
    inProgress: baseClaims.inProgress.map(withRecency),
    blocked: baseClaims.blocked.map(withRecency),
    decisions: baseClaims.decisions.map(withRecency),
    failedAttempts: baseClaims.failedAttempts.map(withRecency),
    currentProblems: baseClaims.currentProblems.map(withRecency),
    relevantFiles: baseClaims.relevantFiles.map(withRecency),
    commandsRun: baseClaims.commandsRun.map(withRecency),
    testsPassed: baseClaims.testsPassed.map(withRecency),
    testsFailed: baseClaims.testsFailed.map(withRecency),
    constraints: baseClaims.constraints.map(withRecency),
    openQuestions: baseClaims.openQuestions.map(withRecency),
    nextActions: baseClaims.nextActions.map(withRecency),
  }
  return AnalysisClaimsSchema.parse(redactAnalysisClaims(claims as unknown as AnalysisClaims)) as unknown as AnalysisClaims
}
