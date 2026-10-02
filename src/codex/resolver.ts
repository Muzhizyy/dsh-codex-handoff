import path from 'node:path'
import { promises as fs, createReadStream } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { codexRoots, resolveCodexHome, type CodexHomeOptions, type CodexRoots } from './home.js'
import { effectiveParseLimits, normalizeLogicalRecords, parseRolloutFile, truncateUtf8, type ParsedRollout, type RolloutMetadata, type RolloutRecord } from './parser.js'
import { HandoffError } from '../shared/errors.js'
import { DEFAULT_LIMITS, HARD_LIMITS, utf8ByteLength } from '../shared/limits.js'
import { redactDiagnostic, redactSessionPreview, redactText } from '../shared/redaction.js'
import type { Diagnostic, DiscoverQuery, ExternalSessionRef, ExternalSessionSummary, NormalizedEvent, NormalizedSession, ParseLimits, SessionPage, SessionPreview } from '../shared/types.js'

export interface RolloutDescriptor {
  readonly path: string
  readonly revisionId: string
  readonly sessionId?: string
  readonly archived: boolean
  readonly representation: 'jsonl' | 'jsonl.zst'
  readonly byteSize: number
  readonly mtimeMs: number
  readonly metadata?: RolloutMetadata
  readonly parsed?: ParsedRollout
}

export interface ResolverOptions {
  readonly roots: CodexRoots
  readonly limits?: Partial<ParseLimits>
  readonly now?: () => Date
}

export interface ResolvedLogicalRollout {
  readonly session: NormalizedSession
  readonly descriptors: readonly RolloutDescriptor[]
  readonly diagnostics: readonly Diagnostic[]
}

interface ChainResult {
  readonly rawRecords: RolloutRecord[]
  readonly lineage: NormalizedSession['lineage']
  readonly diagnostics: Diagnostic[]
  readonly completeness: NormalizedSession['completeness']
  readonly health: 'complete' | 'partial' | 'corrupt' | 'unsupported'
  readonly descriptors: RolloutDescriptor[]
  readonly decompressedBytes: number
  readonly records: number
  readonly head: ParsedRollout
}

interface ChainBudget {
  readonly files: number
  readonly records: number
  readonly decompressedBytes: number
}

interface InventoryEntry {
  readonly descriptor: RolloutDescriptor
  readonly sessionId: string
  readonly fingerprint: string
  readonly title?: string
  readonly searchText?: string
  readonly parseHealth: ExternalSessionSummary['parseHealth']
  readonly session: NormalizedSession
  readonly ambiguousRepresentation?: boolean
  readonly updatedAt: string
  readonly handle: string
}

const runtimeProcess = (globalThis as unknown as { process?: { readonly env: Record<string, string | undefined> } }).process
const runtimeBuffer = (globalThis as unknown as { Buffer: { from(value: string, encoding: string): { toString(encoding: string): string } } }).Buffer

function diagnostic(code: string, message: string, recoverable: boolean, record?: { line?: number | undefined; ordinal?: number | undefined; type?: string | undefined }): Diagnostic {
  const normalizedRecord = record === undefined ? undefined : {
    ...(record.line === undefined ? {} : { line: record.line }),
    ...(record.ordinal === undefined ? {} : { ordinal: record.ordinal }),
    ...(record.type === undefined ? {} : { type: record.type }),
  }
  return { code, severity: code.endsWith('CORRUPT') || code === 'CODEX_METADATA_MISSING' ? 'error' : 'warning', message, ...(normalizedRecord === undefined ? {} : { record: normalizedRecord }), recoverable }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function revisionIdFor(filePath: string): string {
  const base = path.basename(filePath)
  const stem = base.replace(/\.jsonl(?:\.zst)?$/i, '').replace(/^rollout-/, '')
  // Official rollout paths end in a UUID.  Keep that immutable id when it is
  // available; synthetic/older fixtures may use an arbitrary suffix and keep
  // the complete stem as their deterministic locator.
  const uuid = stem.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  return uuid?.[0] ?? stem
}

function representationPath(filePath: string): string {
  return filePath.replace(/\.zst$/i, '')
}

function parseTimestamp(descriptor: RolloutDescriptor): number {
  const updated = descriptor.parsed?.updatedAt
  const parsedUpdated = updated === undefined ? Number.NaN : Date.parse(updated)
  if (Number.isFinite(parsedUpdated)) return parsedUpdated
  const timestamp = descriptor.metadata?.timestamp
  const fromMeta = timestamp === undefined ? Number.NaN : Date.parse(timestamp)
  return Number.isFinite(fromMeta) ? fromMeta : descriptor.mtimeMs
}

function isoUpdated(descriptor: RolloutDescriptor): string {
  const parsedUpdatedAt = descriptor.parsed?.updatedAt
  if (parsedUpdatedAt !== undefined && Number.isFinite(Date.parse(parsedUpdatedAt))) return new Date(parsedUpdatedAt).toISOString()
  const timestamp = descriptor.metadata?.timestamp
  if (timestamp !== undefined && Number.isFinite(Date.parse(timestamp))) return new Date(timestamp).toISOString()
  return new Date(descriptor.mtimeMs).toISOString()
}

function asLimits(limits: Partial<ParseLimits> | undefined): Partial<ParseLimits> {
  return limits ?? DEFAULT_LIMITS
}

/** Filesystem resolver for immutable Codex rollout representations. */
export class CodexLogicalThreadResolver {
  readonly roots: CodexRoots
  readonly limits: Partial<ParseLimits>
  private descriptors: RolloutDescriptor[] = []
  private byRevision = new Map<string, RolloutDescriptor>()

  constructor(options: ResolverOptions | CodexRoots) {
    this.roots = 'roots' in options ? options.roots : options
    this.limits = 'roots' in options ? asLimits(options.limits) : DEFAULT_LIMITS
  }

  async inventory(signal?: AbortSignal): Promise<readonly RolloutDescriptor[]> {
    const files = await enumerateRolloutFiles(this.roots, this.limits.filesScanned ?? DEFAULT_LIMITS.filesScanned, signal)
    const grouped = new Map<string, RolloutDescriptor[]>()
    for (const file of files) {
      if (signal?.aborted) throw new HandoffError({ code: 'CANCELLED', message: 'The operation was cancelled.', recoverable: true })
      let stat
      try { stat = await fs.stat(file.path) } catch { continue }
      let parsed: ParsedRollout | undefined
      try {
        parsed = await parseRolloutFile(file.path, { revisionId: file.revisionId, representation: file.representation, archived: file.archived, limits: this.limits, ...(signal === undefined ? {} : { signal }), normalize: false })
      } catch (error) {
        // Keep an unreadable file in inventory as corrupt, but never expose its path.
        const code = error instanceof HandoffError ? error.code : 'CODEX_ACCESS_DENIED'
        parsed = { revisionId: file.revisionId, representation: file.representation, archived: file.archived, records: [], timeline: [], diagnostics: [diagnostic(code, 'The Codex rollout could not be read.', true)], completeness: { malformedLines: 0, unknownRecords: 0, droppedEncryptedBlocks: 0, danglingToolCalls: 0, orphanToolResults: 0, truncatedRecords: 0 }, health: 'corrupt', byteSize: stat.size }
      }
      const descriptor: RolloutDescriptor = { ...file, byteSize: stat.size, mtimeMs: stat.mtimeMs, ...(parsed.metadata === undefined ? {} : { sessionId: parsed.metadata.id, metadata: parsed.metadata }), parsed }
      const key = representationPath(file.path)
      const sibling = grouped.get(key) ?? []
      sibling.push(descriptor)
      grouped.set(key, sibling)
    }
    const selected: RolloutDescriptor[] = []
    for (const variants of grouped.values()) {
      // During compression transitions both files represent one revision.  A
      // complete plain snapshot wins; a valid zstd snapshot is the fallback
      // when plain is truncated or otherwise incomplete.
      variants.sort((left, right) => representationHealthRank(left) - representationHealthRank(right) || (left.representation === 'jsonl' ? -1 : right.representation === 'jsonl' ? 1 : 0) || right.mtimeMs - left.mtimeMs)
      selected.push(variants[0] as RolloutDescriptor)
    }
    selected.sort((left, right) => parseTimestamp(right) - parseTimestamp(left))
    this.descriptors = selected
    this.byRevision = new Map()
    for (const item of selected) {
      const prior = this.byRevision.get(item.revisionId)
      if (prior === undefined || (prior.archived && !item.archived) || (prior.archived === item.archived && parseTimestamp(item) > parseTimestamp(prior))) this.byRevision.set(item.revisionId, item)
    }
    return selected
  }

  get cachedInventory(): readonly RolloutDescriptor[] { return this.descriptors }

  async resolveByRevision(revisionId: string, signal?: AbortSignal): Promise<ResolvedLogicalRollout> {
    if (this.descriptors.length === 0) await this.inventory(signal)
    const descriptor = this.byRevision.get(revisionId)
    if (descriptor === undefined) throw new HandoffError({ code: 'SOURCE_STALE', message: 'The selected Codex rollout is no longer available.', recoverable: true })
    return this.resolveDescriptor(descriptor, signal)
  }

  async resolveLogicalThread(sessionId: string, signal?: AbortSignal): Promise<ResolvedLogicalRollout> {
    if (this.descriptors.length === 0) await this.inventory(signal)
    const candidates = this.descriptors.filter(item => item.sessionId === sessionId)
    if (candidates.length === 0) throw new HandoffError({ code: 'SOURCE_STALE', message: 'The selected Codex session is no longer available.', recoverable: true })
    candidates.sort((left, right) => {
      if (left.archived !== right.archived) return left.archived ? 1 : -1
      return parseTimestamp(right) - parseTimestamp(left)
    })
    return this.resolveDescriptor(candidates[0] as RolloutDescriptor, signal)
  }

  async resolveDescriptor(descriptor: RolloutDescriptor, signal?: AbortSignal, limitsOverride?: Partial<ParseLimits>): Promise<ResolvedLogicalRollout> {
    const limits = effectiveParseLimits(limitsOverride ?? this.limits)
    const chain = await this.readChain(descriptor, signal, new Set<string>(), 0, undefined, limits, { files: limits.chainFiles, records: limits.records, decompressedBytes: limits.chainDecompressedBytes })
    const parsed = chain.head
    const metadata = parsed.metadata
    const fingerprint = fingerprintChain(chain.descriptors)
    const diagnostics = chain.diagnostics.slice(0, HARD_LIMITS.diagnostics)
    const completeness = { ...chain.completeness }
    const logical = normalizeLogicalRecords(chain.rawRecords, descriptor.revisionId, limits, diagnostics, completeness, { forceUnsupportedIfRollback: chain.health !== 'complete' })
    const session: NormalizedSession = {
      schemaVersion: 2,
      source: {
        agent: 'codex',
        sessionId: metadata?.id ?? descriptor.sessionId ?? `unknown-${descriptor.revisionId}`,
        rolloutRevisionId: descriptor.revisionId,
        fingerprint,
        ...(metadata?.cwd === undefined ? {} : { cwd: metadata.cwd }),
        ...(metadata?.cliVersion === undefined ? {} : { cliVersion: metadata.cliVersion }),
        ...(metadata?.timestamp === undefined ? {} : { startedAt: metadata.timestamp }),
        ...(parsed.updatedAt === undefined ? {} : { updatedAt: parsed.updatedAt }),
        archived: descriptor.archived,
      },
      lineage: chain.lineage,
      timeline: logical.timeline,
      diagnostics: diagnostics.slice(0, HARD_LIMITS.diagnostics).map(redactDiagnostic),
      completeness,
    }
    return { session, descriptors: chain.descriptors, diagnostics: session.diagnostics }
  }

  private async readChain(descriptor: RolloutDescriptor, signal: AbortSignal | undefined, visited: Set<string>, depth: number, maxOrdinalExclusive: number | undefined, limits: ReturnType<typeof effectiveParseLimits>, budget: ChainBudget): Promise<ChainResult> {
    if (depth >= limits.chainDepth) {
      return emptyChain(diagnostic('CODEX_HISTORY_PARTIAL', 'History-base recursion depth limit was reached before reading the referenced rollout.', true))
    }
    if (visited.has(descriptor.revisionId)) {
      return emptyChain(diagnostic('CODEX_HISTORY_CORRUPT', 'A cycle was detected in rollout history-base references.', false))
    }
    if (budget.files <= 0 || budget.records <= 0 || budget.decompressedBytes <= 0) {
      return emptyChain(diagnostic('CODEX_HISTORY_PARTIAL', 'History-base aggregate budget was exhausted before reading the referenced rollout.', true))
    }
    const nextVisited = new Set(visited)
    nextVisited.add(descriptor.revisionId)
    const fileLimits = effectiveParseLimits({ ...limits, records: Math.min(limits.records, budget.records), sourceFileBytes: Math.min(limits.sourceFileBytes, budget.decompressedBytes) })
    const parsed = await parseRolloutFile(descriptor.path, { revisionId: descriptor.revisionId, representation: descriptor.representation, archived: descriptor.archived, limits: fileLimits, ...(signal === undefined ? {} : { signal }), normalize: false })
    const currentDescriptor = descriptorWithParsed(descriptor, parsed)
    const base = parsed.metadata?.historyBase
    const diagnostics: Diagnostic[] = []
    let prefix: ChainResult | undefined
    let cutoff: number | undefined
    if (base !== undefined) {
      cutoff = base.endOrdinalExclusive
      if (cutoff !== undefined && cutoff <= 0) diagnostics.push(diagnostic('CODEX_HISTORY_CORRUPT', 'History-base cutoff must be positive.', false))
      if (cutoff !== undefined && maxOrdinalExclusive !== undefined && cutoff > maxOrdinalExclusive) diagnostics.push(diagnostic('CODEX_HISTORY_CORRUPT', 'History-base cutoffs overlap or decrease chronology.', false))
      const normalizedBaseId = base.rolloutId.replace(/^rollout-/, '').replace(/\.jsonl(?:\.zst)?$/i, '')
      const shortBaseId = revisionIdFor(base.rolloutId)
      const baseDescriptor = this.byRevision.get(base.rolloutId) ?? this.byRevision.get(normalizedBaseId) ?? this.byRevision.get(shortBaseId) ?? this.descriptors.find(item => item.revisionId === base.rolloutId || item.revisionId === normalizedBaseId || item.revisionId === shortBaseId || item.sessionId === base.rolloutId)
      if (baseDescriptor === undefined) {
        diagnostics.push(diagnostic('CODEX_HISTORY_PARTIAL', 'The referenced history-base rollout is missing.', true))
      } else {
        const consumedRecords = parsed.records.length
        const consumedBytes = parsed.decompressedBytes ?? parsed.byteSize
        const remainingBudget = { files: budget.files - 1, records: Math.max(0, budget.records - consumedRecords), decompressedBytes: Math.max(0, budget.decompressedBytes - consumedBytes) }
        prefix = remainingBudget.files <= 0 || remainingBudget.records <= 0 || remainingBudget.decompressedBytes <= 0
          ? emptyChain(diagnostic('CODEX_HISTORY_PARTIAL', 'History-base aggregate budget was exhausted before reading the referenced rollout.', true))
          : await this.readChain(baseDescriptor, signal, nextVisited, depth + 1, cutoff, limits, remainingBudget)
      }
    }
    const ownLower = base?.endOrdinalExclusive
    const ownRecords = filterRecords(parsed.records, ownLower, maxOrdinalExclusive)
    const rawRecords = [...(prefix?.rawRecords ?? []), ...ownRecords].map((record, index) => ({ ...record, chainOrder: index }))
    const inheritedLineage: NormalizedSession['lineage'] = (prefix?.lineage ?? []).map(item => ({ ...item, relation: 'history-base' as const }))
    if (cutoff !== undefined && inheritedLineage.length > 0) {
      const last = inheritedLineage.length - 1
      const lastItem = inheritedLineage[last]
      if (lastItem !== undefined) inheritedLineage[last] = { ...lastItem, endOrdinalExclusive: cutoff }
    }
    const lineage: NormalizedSession['lineage'] = [ ...inheritedLineage, { rolloutRevisionId: descriptor.revisionId, relation: 'head', representation: descriptor.representation } ]
    const completeness = mergeCompleteness(parsed.completeness, prefix?.completeness)
    const aggregateBytes = (prefix?.decompressedBytes ?? 0) + (parsed.decompressedBytes ?? parsed.byteSize)
    const aggregateRecords = (prefix?.records ?? 0) + ownRecords.length
    if (aggregateBytes > limits.chainDecompressedBytes) diagnostics.push(diagnostic('CODEX_LIMIT_EXCEEDED', 'The logical history decompressed-byte limit was reached; older history was omitted.', true))
    let boundedDescriptors = [...(prefix?.descriptors ?? []), currentDescriptor]
    let boundedRecords = rawRecords
    if (aggregateBytes > limits.chainDecompressedBytes) {
      // Keep the currently selected head usable while refusing to expose a
      // potentially incomplete inherited prefix.
      boundedRecords = ownRecords.map((record, index) => ({ ...record, chainOrder: index }))
      boundedDescriptors = [currentDescriptor]
    }
    if (aggregateRecords > limits.records) {
      diagnostics.push(diagnostic('CODEX_LIMIT_EXCEEDED', 'The logical history record limit was reached; older history was omitted.', true))
      boundedRecords = boundedRecords.slice(Math.max(0, boundedRecords.length - limits.records)).map((record, index) => ({ ...record, chainOrder: index }))
    }
    const health = diagnostics.some(item => item.code.endsWith('CORRUPT')) || prefix?.health === 'corrupt' ? 'corrupt' : diagnostics.length > 0 || prefix?.health === 'partial' || parsed.health === 'partial' ? 'partial' : parsed.health === 'unsupported' || prefix?.health === 'unsupported' ? 'unsupported' : 'complete'
    return { rawRecords: boundedRecords, lineage, diagnostics: [...(prefix?.diagnostics ?? []), ...parsed.diagnostics, ...diagnostics], completeness, health, descriptors: boundedDescriptors, decompressedBytes: aggregateBytes, records: aggregateRecords, head: parsed }
  }
}

function representationHealthRank(descriptor: RolloutDescriptor): number {
  if (descriptor.parsed?.diagnostics.some(diag => diag.code === 'CODEX_COMPRESSED_INVALID') === true) return 3
  switch (descriptor.parsed?.health) {
    case 'complete': return 0
    case 'partial': return 1
    case 'unsupported': return 2
    case 'corrupt': return 3
    default: return 3
  }
}

function emptyChain(diag: Diagnostic): ChainResult {
  const head: ParsedRollout = { revisionId: 'empty', representation: 'jsonl', archived: false, records: [], timeline: [], diagnostics: [diag], completeness: { malformedLines: 0, unknownRecords: 0, droppedEncryptedBlocks: 0, danglingToolCalls: 0, orphanToolResults: 0, truncatedRecords: 0 }, health: diag.code.endsWith('CORRUPT') ? 'corrupt' : 'partial', byteSize: 0 }
  return { rawRecords: [], lineage: [], diagnostics: [diag], completeness: { malformedLines: 0, unknownRecords: 0, droppedEncryptedBlocks: 0, danglingToolCalls: 0, orphanToolResults: 0, truncatedRecords: 0 }, health: diag.code.endsWith('CORRUPT') ? 'corrupt' : 'partial', descriptors: [], decompressedBytes: 0, records: 0, head }
}

function descriptorWithParsed(descriptor: RolloutDescriptor, parsed: ParsedRollout): RolloutDescriptor {
  const { sessionId: _sessionId, metadata: _metadata, ...stable } = descriptor
  return {
    ...stable,
    byteSize: parsed.byteSize,
    ...(parsed.metadata === undefined ? {} : { sessionId: parsed.metadata.id, metadata: parsed.metadata }),
    parsed,
  }
}

function filterRecords(records: readonly RolloutRecord[], lowerExclusive: number | undefined, upperExclusive: number | undefined): RolloutRecord[] {
  return records.filter(record => {
    const ordinal = record.ordinal
    if (ordinal === undefined) return lowerExclusive === undefined && upperExclusive === undefined
    if (lowerExclusive !== undefined && ordinal < lowerExclusive) return false
    if (upperExclusive !== undefined && ordinal >= upperExclusive) return false
    return true
  })
}

function mergeCompleteness(a: NormalizedSession['completeness'], b: NormalizedSession['completeness'] | undefined): NormalizedSession['completeness'] {
  if (b === undefined) return { ...a }
  return {
    malformedLines: a.malformedLines + b.malformedLines,
    unknownRecords: a.unknownRecords + b.unknownRecords,
    droppedEncryptedBlocks: a.droppedEncryptedBlocks + b.droppedEncryptedBlocks,
    danglingToolCalls: a.danglingToolCalls + b.danglingToolCalls,
    orphanToolResults: a.orphanToolResults + b.orphanToolResults,
    truncatedRecords: a.truncatedRecords + b.truncatedRecords,
  }
}

function fingerprintChain(descriptors: readonly RolloutDescriptor[]): string {
  const hash = createHash('sha256')
  for (const descriptor of descriptors) {
    const fingerprint = descriptor.parsed?.fingerprint ?? ''
    hash.update(`${descriptor.revisionId}\0${descriptor.representation}\0${fingerprint}\0${descriptor.archived ? '1' : '0'}\n`)
  }
  return hash.digest('hex')
}

interface EnumeratedFile { readonly path: string; readonly revisionId: string; readonly archived: boolean; readonly representation: 'jsonl' | 'jsonl.zst' }

async function enumerateRolloutFiles(roots: CodexRoots, maxFiles: number, signal?: AbortSignal): Promise<EnumeratedFile[]> {
  const output: EnumeratedFile[] = []
  let canonicalHome: string
  try { canonicalHome = await fs.realpath(roots.home) } catch { return output }
  const rootsToScan: Array<{ root: string; archived: boolean }> = [{ root: roots.sessions, archived: false }, { root: roots.archivedSessions, archived: true }]
  for (const rootInfo of rootsToScan) {
    let canonicalRoot: string
    try { canonicalRoot = await fs.realpath(rootInfo.root) } catch { continue }
    if (!isInside(canonicalHome, canonicalRoot)) continue
    await walk(canonicalRoot, canonicalRoot, rootInfo.archived, output, maxFiles, signal)
    if (output.length >= maxFiles) break
  }
  return output
}

async function walk(root: string, directory: string, archived: boolean, output: EnumeratedFile[], maxFiles: number, signal?: AbortSignal): Promise<void> {
  if (output.length >= maxFiles) return
  if (signal?.aborted) throw new HandoffError({ code: 'CANCELLED', message: 'The operation was cancelled.', recoverable: true })
  let entries
  try { entries = await fs.readdir(directory, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (output.length >= maxFiles) return
    const candidate = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      // Do not recurse through symlink/junction directories.  A rollout link
      // itself is checked by realpath below and remains read-only.
      await walk(root, candidate, archived, output, maxFiles, signal)
      continue
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue
    if (!/^rollout-.+\.jsonl(?:\.zst)?$/i.test(entry.name)) continue
    let real
    try { real = await fs.realpath(candidate) } catch { continue }
    if (!isInside(root, real)) continue
    const representation = entry.name.endsWith('.zst') ? 'jsonl.zst' : 'jsonl'
    output.push({ path: real, revisionId: revisionIdFor(entry.name), archived, representation })
  }
}

function tokenSearchText(entry: InventoryEntry): string {
  return `${entry.title ?? ''}\n${entry.sessionId}\n${entry.descriptor.metadata?.cwd ?? ''}\n${path.basename(entry.descriptor.metadata?.cwd ?? '')}\n${entry.searchText ?? ''}`.toLocaleLowerCase()
}

/** Discovery/source facade with opaque, inventory-bound handles. */
export class CodexSessionSource {
  readonly kind = 'codex' as const
  readonly resolver: CodexLogicalThreadResolver
  private readonly secret: Uint8Array
  private generation = 0
  private inventorySignature = ''
  private entries: InventoryEntry[] = []
  private indexTitles = new Map<string, string>()
  private readonly now: () => Date

  constructor(options: CodexHomeOptions | ResolverOptions | CodexRoots) {
    if ('roots' in options || 'sessions' in options) {
      this.resolver = new CodexLogicalThreadResolver(options)
      this.now = () => new Date()
    } else {
      // Resolver roots are resolved asynchronously by create; this branch uses
      // the supplied absolute home synchronously for convenient construction.
      const configuredHome = options.codexHome ?? options.config?.codexHome
      const environmentHome = options.env?.CODEX_HOME ?? runtimeProcess?.env.CODEX_HOME
      const home = configuredHome ?? (environmentHome !== undefined && environmentHome.trim() !== '' ? environmentHome : path.join(options.homeDirectory ?? runtimeProcess?.env.USERPROFILE ?? runtimeProcess?.env.HOME ?? '.', '.codex'))
      if (!path.isAbsolute(home)) throw new HandoffError({ code: 'CODEX_HOME_NOT_FOUND', message: 'The configured CODEX_HOME must be an absolute path.', recoverable: false })
      this.resolver = new CodexLogicalThreadResolver(codexRoots(home))
      this.now = () => new Date()
    }
    this.secret = randomBytes(32)
  }

  static async create(options: CodexHomeOptions = {}, limits?: Partial<ParseLimits>): Promise<CodexSessionSource> {
    const home = await resolveCodexHome(options)
    return new CodexSessionSource({ roots: codexRoots(home.path), ...(limits === undefined ? {} : { limits }) })
  }

  async discover(query: DiscoverQuery, signal: AbortSignal = new AbortController().signal): Promise<SessionPage> {
    const effectiveQuery: DiscoverQuery = {
      archived: query.archived ?? 'all',
      limit: query.limit ?? DEFAULT_LIMITS.discoverPageResults,
      includeMessageIndex: query.includeMessageIndex ?? false,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.search === undefined ? {} : { search: query.search }),
    }
    const descriptors = await this.resolver.inventory(signal)
    // Keep an inventory generation stable across pages.  A nextCursor from
    // page N must remain valid for page N+1, while a changed representation or
    // source file starts a new generation and invalidates old opaque handles.
    const signature = createHash('sha256').update(descriptors.map(item => `${item.revisionId}\0${item.archived ? '1' : '0'}\0${item.parsed?.fingerprint ?? ''}`).join('\n')).digest('hex')
    if (signature !== this.inventorySignature) {
      this.inventorySignature = signature
      this.generation += 1
    }
    this.indexTitles = await readSessionIndex(this.resolver.roots.sessionIndex, this.resolver.roots.home, signal)
    const bySession = new Map<string, RolloutDescriptor>()
    for (const descriptor of descriptors) {
      const sessionId = descriptor.sessionId ?? `unknown-${descriptor.revisionId}`
      const existing = bySession.get(sessionId)
      if (existing === undefined || (existing.archived && !descriptor.archived) || (existing.archived === descriptor.archived && parseTimestamp(descriptor) > parseTimestamp(existing))) bySession.set(sessionId, descriptor)
    }
    const entries: InventoryEntry[] = []
    for (const descriptor of bySession.values()) {
      const sessionId = descriptor.sessionId ?? `unknown-${descriptor.revisionId}`
      const resolved = await this.resolver.resolveDescriptor(descriptor, signal)
      const fingerprint = resolved.session.source.fingerprint
      const indexedTitle = this.indexTitles.get(sessionId)
      const firstUser = resolved.session.timeline.find(item => item.kind === 'message' && item.role === 'user')
      const rawTitle = indexedTitle ?? (firstUser?.kind === 'message' ? firstUser.text : undefined)
      const title = rawTitle === undefined ? undefined : truncateUtf8(redactText(rawTitle), 200)
      const searchText = effectiveQuery.includeMessageIndex === true ? resolved.session.timeline.map(eventText).filter(Boolean).join('\n').slice(0, 256 * 1024) : undefined
      const ambiguousRepresentation = descriptors.some(item => item.sessionId === sessionId && item.archived !== descriptor.archived)
      const entryData = { descriptor, sessionId, fingerprint, ...(title === undefined ? {} : { title }), ...(searchText === undefined ? {} : { searchText }), updatedAt: isoUpdated(descriptor), parseHealth: ambiguousRepresentation ? 'partial' as const : healthFromSession(resolved.session), session: resolved.session, ...(ambiguousRepresentation ? { ambiguousRepresentation: true } : {}) }
      const handle = this.encodeHandle({ generation: this.generation, sessionId, revisionId: descriptor.revisionId, fingerprint })
      entries.push({ ...entryData, handle })
    }
    entries.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    const search = query.search?.trim().toLocaleLowerCase()
    const filtered = entries.filter(entry => (effectiveQuery.archived === 'all' || (effectiveQuery.archived === 'archived') === entry.descriptor.archived) && (search === undefined || tokenSearchText(entry).includes(search)))
    this.entries = entries
    const offset = effectiveQuery.cursor === undefined ? 0 : this.decodeCursor(effectiveQuery.cursor)
    const limit = Math.min(effectiveQuery.limit, HARD_LIMITS.discoverPageResults)
    const pageEntries = filtered.slice(offset, offset + limit)
    const items = pageEntries.map(entry => summaryOf(entry))
    const nextOffset = offset + pageEntries.length
    return { items, ...(nextOffset < filtered.length ? { nextCursor: this.encodeCursor(nextOffset) } : {}), scannedAt: this.now().toISOString() }
  }

  async load(ref: ExternalSessionRef, limits: ParseLimits = { ...DEFAULT_LIMITS }, signal: AbortSignal = new AbortController().signal): Promise<NormalizedSession> {
    const entry = this.resolveHandle(ref)
    const resolved = await this.resolver.resolveDescriptor(entry.descriptor, signal, limits)
    if (resolved.session.source.fingerprint !== entry.fingerprint || (ref.expectedFingerprint !== undefined && resolved.session.source.fingerprint !== ref.expectedFingerprint)) throw new HandoffError({ code: 'SOURCE_CHANGED', message: 'The selected Codex rollout changed; preview it again.', recoverable: true })
    return resolved.session
  }

  async preview(ref: ExternalSessionRef, limits: ParseLimits = { ...DEFAULT_LIMITS }, signal: AbortSignal = new AbortController().signal): Promise<SessionPreview> {
    const session = await this.load(ref, limits, signal)
    const entry = this.resolveHandle(ref)
    const source = summaryOf(entry)
    const snippets = session.timeline
      .filter(item => item.kind === 'message' || item.kind === 'reasoning-summary')
      .slice(0, 100)
      .map(item => {
        const rawText = item.text
        const safeText = redactText(rawText)
        return {
          source: item.source,
          role: item.kind === 'message' ? item.role : 'assistant' as const,
          text: truncateUtf8(safeText, limits.previewSnippetBytes),
          redacted: safeText !== rawText,
        }
      })
    const largestRecords = session.timeline.map(item => ({ kind: item.kind === 'tool-result' ? 'tool-result' as const : item.kind === 'message' ? 'message' as const : item.kind === 'reasoning-summary' ? 'reasoning' as const : 'other' as const, bytes: item.kind === 'tool-result' ? utf8ByteLength(item.content) : item.kind === 'message' || item.kind === 'reasoning-summary' ? utf8ByteLength(item.text) : 0, source: item.source })).sort((a, b) => b.bytes - a.bytes).slice(0, 100)
    const estimatedTokens = Math.min(HARD_LIMITS.estimatedTokens, Math.ceil(session.timeline.reduce((sum, item) => sum + eventTextLength(item), 0) / 4))
    return redactSessionPreview({ source, estimatedTokens, estimator: 'fallback', largestRecords, snippets, completeness: session.completeness, diagnostics: session.diagnostics })
  }

  private resolveHandle(ref: ExternalSessionRef): InventoryEntry {
    const entry = this.entries.find(item => item.handle === ref.discoveryId)
    if (entry === undefined) throw new HandoffError({ code: 'SOURCE_STALE', message: 'The selected Codex session handle is stale.', recoverable: true })
    const decoded = this.decodeHandle(entry.handle)
    if (decoded.generation !== this.generation || decoded.sessionId !== ref.sessionId || decoded.revisionId !== ref.rolloutRevisionId || (ref.archived !== undefined && ref.archived !== entry.descriptor.archived)) throw new HandoffError({ code: 'SOURCE_STALE', message: 'The selected Codex session handle is stale.', recoverable: true })
    return entry
  }

  private encodeHandle(value: { generation: number; sessionId: string; revisionId: string; fingerprint: string }): string {
    const body = runtimeBuffer.from(JSON.stringify(value), 'utf8').toString('base64url')
    const signature = createHash('sha256').update(this.secret).update(body).digest('base64url')
    return `cx1.${body}.${signature}`
  }

  private decodeHandle(handle: string): { generation: number; sessionId: string; revisionId: string; fingerprint: string } {
    const pieces = handle.split('.')
    if (pieces.length !== 3 || pieces[0] !== 'cx1') throw new HandoffError({ code: 'SOURCE_STALE', message: 'The selected Codex session handle is invalid.', recoverable: true })
    const signature = createHash('sha256').update(this.secret).update(pieces[1] as string).digest('base64url')
    if (signature !== pieces[2]) throw new HandoffError({ code: 'SOURCE_STALE', message: 'The selected Codex session handle is invalid.', recoverable: true })
    try {
      const value = JSON.parse(runtimeBuffer.from(pieces[1] as string, 'base64url').toString('utf8')) as { generation: number; sessionId: string; revisionId: string; fingerprint: string }
      if (!Number.isSafeInteger(value.generation) || typeof value.sessionId !== 'string' || typeof value.revisionId !== 'string' || typeof value.fingerprint !== 'string') throw new Error('invalid')
      return value
    } catch { throw new HandoffError({ code: 'SOURCE_STALE', message: 'The selected Codex session handle is invalid.', recoverable: true }) }
  }

  private encodeCursor(offset: number): string {
    const body = runtimeBuffer.from(JSON.stringify({ generation: this.generation, offset }), 'utf8').toString('base64url')
    const signature = createHash('sha256').update(this.secret).update(body).digest('base64url')
    return `cur1.${body}.${signature}`
  }

  private decodeCursor(cursor: string): number {
    const pieces = cursor.split('.')
    if (pieces.length !== 3 || pieces[0] !== 'cur1') throw new HandoffError({ code: 'SOURCE_STALE', message: 'The discovery cursor is invalid or stale.', recoverable: true })
    const signature = createHash('sha256').update(this.secret).update(pieces[1] as string).digest('base64url')
    if (signature !== pieces[2]) throw new HandoffError({ code: 'SOURCE_STALE', message: 'The discovery cursor is invalid or stale.', recoverable: true })
    const value = JSON.parse(runtimeBuffer.from(pieces[1] as string, 'base64url').toString('utf8')) as { generation: number; offset: number }
    if (value.generation !== this.generation || !Number.isSafeInteger(value.offset) || value.offset < 0) throw new HandoffError({ code: 'SOURCE_STALE', message: 'The discovery cursor is stale.', recoverable: true })
    return value.offset
  }
}

function summaryOf(entry: InventoryEntry): ExternalSessionSummary {
  const timeline = entry.session.timeline
  return {
    discoveryId: entry.handle,
    source: 'codex',
    sessionId: entry.sessionId,
    rolloutRevisionId: entry.descriptor.revisionId,
    fingerprint: entry.fingerprint,
    ...(entry.title === undefined ? {} : { title: redactText(entry.title) }),
    ...(entry.descriptor.metadata?.cwd === undefined ? {} : { cwd: entry.descriptor.metadata.cwd }),
    ...(entry.descriptor.metadata?.timestamp === undefined ? {} : { startedAt: entry.descriptor.metadata.timestamp }),
    updatedAt: entry.updatedAt,
    archived: entry.descriptor.archived,
    ...(entry.descriptor.metadata?.cliVersion === undefined ? {} : { cliVersion: entry.descriptor.metadata.cliVersion }),
    messageCount: timeline.filter(item => item.kind === 'message').length,
    toolCallCount: timeline.filter(item => item.kind === 'tool-call').length,
    byteSize: entry.descriptor.byteSize,
    parseHealth: entry.parseHealth,
  }
}

function eventTextLength(item: NormalizedEvent): number {
  switch (item.kind) {
    case 'message':
    case 'reasoning-summary':
      return item.text.length
    case 'tool-call':
      return item.argumentsText.length
    case 'tool-result':
      return item.content.length
    case 'compacted':
    case 'annotation':
      return item.kind === 'compacted' ? item.summary.length : item.text.length
    case 'lifecycle':
      return JSON.stringify(item.lifecycle).length
  }
}

function healthFromSession(session: NormalizedSession): ExternalSessionSummary['parseHealth'] {
  if (session.source.sessionId.startsWith('unknown-')) return 'corrupt'
  if (session.diagnostics.some(item => item.code === 'CODEX_HISTORY_CORRUPT')) return 'corrupt'
  if (session.diagnostics.some(item => item.code === 'CODEX_FORMAT_UNSUPPORTED')) return 'unsupported'
  const incomplete = Object.values(session.completeness).some(value => value > 0)
  if (session.diagnostics.length > 0 || incomplete) return 'partial'
  return 'complete'
}

function eventText(item: NormalizedEvent): string {
  switch (item.kind) {
    case 'message':
    case 'reasoning-summary':
      return item.text
    case 'tool-call':
      return `${item.name} ${item.argumentsText}`
    case 'tool-result':
      return item.content
    case 'compacted':
      return item.summary
    case 'annotation':
      return item.text
    case 'lifecycle':
      return JSON.stringify(item.lifecycle)
  }
}

async function readSessionIndex(indexPath: string, homeRoot: string, signal?: AbortSignal): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  const timestamps = new Map<string, number>()
  try {
    const canonicalHome = await fs.realpath(homeRoot)
    const canonicalIndex = await fs.realpath(indexPath)
    if (!isInside(canonicalHome, canonicalIndex)) return titles
  } catch {
    return titles
  }
  let stat
  try { stat = await fs.stat(indexPath) } catch { return titles }
  if (typeof stat.isFile === 'function' && !stat.isFile()) return titles
  if (stat.size > 16 * 1024 * 1024) return titles
  const stream = createReadStream(indexPath, { highWaterMark: 64 * 1024 })
  const decoder = new TextDecoder()
  let pending = ''
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    if (signal?.aborted) throw new HandoffError({ code: 'CANCELLED', message: 'The operation was cancelled.', recoverable: true })
    pending += decoder.decode(chunk, { stream: true })
    let at: number
    while ((at = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, at); pending = pending.slice(at + 1)
      applyIndexRow(line, titles, timestamps)
    }
  }
  pending += decoder.decode()
  applyIndexRow(pending, titles, timestamps)
  return titles
}

function applyIndexRow(line: string, titles: Map<string, string>, timestamps: Map<string, number>): void {
  if (line.trim() === '') return
  try {
    const row = JSON.parse(line) as Record<string, unknown>
    const id = typeof row.id === 'string' ? row.id : typeof row.session_id === 'string' ? row.session_id : undefined
    const title = typeof row.thread_name === 'string' ? row.thread_name : typeof row.title === 'string' ? row.title : undefined
    if (id !== undefined && title !== undefined) {
      const updatedAt = typeof row.updated_at === 'string' ? Date.parse(row.updated_at) : Number.NaN
      const prior = timestamps.get(id)
      // If timestamps are absent, file order is the only available recency
      // signal.  Otherwise latest valid updated_at wins regardless of order.
      if (prior === undefined || !Number.isFinite(updatedAt) || (Number.isFinite(updatedAt) && updatedAt >= prior)) {
        titles.set(id, title.slice(0, 4096))
        timestamps.set(id, Number.isFinite(updatedAt) ? updatedAt : (prior ?? 0) + 1)
      }
    }
  } catch { /* index is an optional acceleration structure */ }
}

export async function createCodexSessionSource(options: CodexHomeOptions = {}, limits?: Partial<ParseLimits>): Promise<CodexSessionSource> {
  return CodexSessionSource.create(options, limits)
}

export async function discoverCodexRollouts(options: CodexHomeOptions = {}, limits?: Partial<ParseLimits>, signal?: AbortSignal): Promise<readonly RolloutDescriptor[]> {
  const home = await resolveCodexHome(options)
  return new CodexLogicalThreadResolver({ roots: codexRoots(home.path), ...(limits === undefined ? {} : { limits }) }).inventory(signal)
}

export const scanCodexSessions = discoverCodexRollouts

export const CodexSessionResolver = CodexLogicalThreadResolver
