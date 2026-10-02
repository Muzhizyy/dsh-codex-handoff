import {
  CompatibilityViewSchema,
  CreateOutcomeSchema,
  ImportIdentitySchema,
  ImportRecordSchema,
  ImportRecordReadSchema,
  PreparedImportSchema,
  type CompatibilityView,
  type CreateOutcome,
  type Diagnostic,
  type DestinationCheck,
  type ImportIdentity,
  type ImportRecord,
  type ImportRecordRead,
  type ImportFailure,
  type ImportRecoveryIntent,
  type JsonValue,
  type PreparedImport,
  type PluginSource,
  HARD_LIMITS,
  PluginSourceSchema,
  REDACTED,
  redactJson,
} from '../shared/index.js'
import type { DshSessionGateway as DshSessionGatewayPort } from '../shared/ports.js'
import { HandoffError } from '../shared/errors.js'
import { sha256Hex } from './seed.js'
import { z } from 'zod'

/** Minimal public Agent surface consumed by the gateway. */
export interface DshAgentHandle {
  readonly agent: { readonly id?: string; readonly session?: unknown }
  dispose(): Promise<void>
}

/** Deliberately structural: the Host supplies the official DSH Agent service. */
export interface DshAgentsService {
  create(options: {
    readonly sessionId: string
    readonly meta: { readonly cwd: string; readonly agentPreset?: string }
    readonly seed: readonly Record<string, unknown>[]
    readonly agentOptions?: Record<string, unknown>
    readonly setup?: (agentContext: unknown) => Promise<void> | void
    readonly signal?: AbortSignal
  }): Promise<DshAgentHandle>
}

/** Model route exposed by the official AgentDefaultModel service. */
export interface DshDefaultModelService {
  currentSelection(): { readonly provider: string; readonly model: string; readonly [key: string]: unknown }
}

/** Optional preset service; mounting is setup-scoped and never drives the Agent. */
export interface DshAgentPresetsService {
  resolve(id?: string): Promise<{ readonly id: string }>
  mount(agentContext: unknown, id?: string): Promise<void> | void
}

/** Read-only query facade used to guard adoption of a destination session. */
export interface DshSessionQueryService {
  has?(sessionId: string): Promise<boolean> | boolean
  exists?(sessionId: string): Promise<boolean> | boolean
  get?(sessionId: string): Promise<unknown> | unknown
  find?(sessionId: string): Promise<unknown> | unknown
  inspect?(sessionId: string, signal?: AbortSignal): Promise<unknown> | unknown
  readSession?(sessionId: string): Promise<unknown> | unknown
  filterSessions?(filters: readonly unknown[], signal?: AbortSignal): Promise<readonly unknown[]>
  listSessions?(signal?: AbortSignal): Promise<readonly unknown[]>
  list?(...args: readonly unknown[]): Promise<readonly unknown[]> | readonly unknown[]
}

/** Host workspace facade. Workspace entities expose attachSession themselves. */
export interface DshWorkspaceRegistry {
  resolveByPath?(path: string): Promise<{ attachSession?(sessionId: string): Promise<void> | void } | undefined>
  create?(path: string, title?: string): Promise<{ attachSession?(sessionId: string): Promise<void> | void }>
  attachSession?(sessionId: string, path: string): Promise<void>
}

/** Runtime capabilities read from the DSH Host context. */
export interface DshGatewayRuntime {
  readonly agents?: DshAgentsService
  readonly agentDefaultModel?: DshDefaultModelService
  readonly agentPresets?: DshAgentPresetsService
  readonly sessionQuery?: DshSessionQueryService
  readonly sessionPersistence?: unknown
  readonly workspaceRegistry?: DshWorkspaceRegistry
  readonly storageDomain?: unknown
  readonly typert?: unknown
  readonly llm?: unknown
  readonly dshVersion?: string
  readonly observedSessionFormat?: number
}

type V2ImportRecord = ImportRecord
type CreatedRecord = Extract<V2ImportRecord, { state: 'created' }>
type CreatedUnattachedRecord = Extract<V2ImportRecord, { state: 'created_unattached' }>

function isV2Record(value: ImportRecordRead): value is V2ImportRecord {
  return value.schemaVersion === 2
}

/** A typed whole-record storage boundary owned by the plugin Host adapter. */
export interface ImportIndex {
  get(key: string, signal?: AbortSignal): Promise<ImportRecordRead | undefined>
  /** Atomic whole-record put. `expected` is the exact prior record, or undefined for expect-absent. */
  put(record: ImportRecord, expected?: ImportRecordRead, signal?: AbortSignal): Promise<void>
  list(signal?: AbortSignal): Promise<readonly ImportRecordRead[]>
}

/** The official storage-domain surface used by the import ledger. */
export interface ImportLedgerKvTable {
  get(key: string): Promise<unknown> | unknown
  put(key: string, value: unknown): Promise<void> | void
  /** Update receives the latest value while holding the table's atomic write boundary. */
  update(key: string, updater: (latest: unknown) => unknown): Promise<unknown> | unknown
}

/** Structural subset of the official ctx.storageDomain.open/domain.table API. */
export interface DshStorageDomainService {
  open(spec: DshStorageDomainSpec): Promise<DshStorageDomainHandle> | DshStorageDomainHandle
}

export interface DshStorageDomainHandle {
  table(name: string): ImportLedgerKvTable
  /** Official Domain handle lifecycle; the caller owns and closes it. */
  close?(): Promise<void> | void
}

export interface DshStorageDomainSpec {
  readonly name: string
  readonly version: number
  readonly layout: 'single' | 'per-record'
  readonly tables: Readonly<Record<string, { readonly valueSchema: unknown }>>
}

export interface ImportLedger {
  readonly schemaVersion: 1
  readonly generation: number
  readonly records: Readonly<Record<string, ImportRecordRead>>
}

const IMPORT_LEDGER_DOMAIN = 'dsh_codex_handoff'
const IMPORT_LEDGER_TABLE = 'ledgers'
const IMPORT_LEDGER_KEY = 'imports'
const IMPORT_LEDGER_MAX_RECORDS = 10_000
const IMPORT_LEDGER_MAX_JSON_BYTES = 8 * 1024 * 1024
const ledgerInitializations = new WeakMap<object, Promise<void>>()
const ImportLedgerSchema = z.object({
  schemaVersion: z.literal(1),
  generation: z.number().int().nonnegative().safe(),
  records: z.record(z.string(), ImportRecordReadSchema),
}).strict()

function ledgerBytes(value: ImportLedger): number {
  const json = JSON.stringify(value)
  if (json === undefined) throw new Error('import ledger is not JSON-serializable')
  return new TextEncoder().encode(json).byteLength
}

function validateLedger(value: unknown): ImportLedger {
  const parsed = ImportLedgerSchema.parse(value)
  const entries = Object.keys(parsed.records)
  if (entries.length > IMPORT_LEDGER_MAX_RECORDS) throw new Error('import ledger record limit exceeded')
  const ledger = parsed as ImportLedger
  if (ledgerBytes(ledger) > IMPORT_LEDGER_MAX_JSON_BYTES) throw new Error('import ledger byte limit exceeded')
  return ledger
}

function emptyImportLedger(): ImportLedger {
  return { schemaVersion: 1, generation: 0, records: {} }
}

/**
 * Storage-domain import index backed by one atomic KvTable row. The table is
 * opened by the Host as `dsh_codex_handoff/ledgers`; this class intentionally
 * does not invent a lock or a synthetic CAS method. `update` is the official
 * per-row atomic boundary and receives the latest complete ledger.
 */
export class StorageDomainImportIndex implements ImportIndex {
  private initialized = false
  private initialization: Promise<void> | undefined
  private closed = false

  constructor(
    private readonly table: ImportLedgerKvTable,
    readonly domain = IMPORT_LEDGER_DOMAIN,
    readonly tableName = IMPORT_LEDGER_TABLE,
    private readonly closeDomain?: () => Promise<void> | void,
  ) {}

  get ledgerKey(): string { return IMPORT_LEDGER_KEY }

  /** Call before publishing the gateway service; missing state is initialized once. */
  async initialize(): Promise<void> {
    if (this.initialized) return
    if (this.initialization !== undefined) return await this.initialization
    const shared = ledgerInitializations.get(this.table as object)
    if (shared !== undefined) {
      this.initialization = shared
    } else {
      this.initialization = this.initializeOnce()
      ledgerInitializations.set(this.table as object, this.initialization)
    }
    try {
      await this.initialization
      this.initialized = true
    } finally {
      if (ledgerInitializations.get(this.table as object) === this.initialization) ledgerInitializations.delete(this.table as object)
      this.initialization = undefined
    }
  }

  private async initializeOnce(): Promise<void> {
    const raw = await this.table.get(IMPORT_LEDGER_KEY)
    if (raw === undefined) {
      // Initialization is the only put outside update. Host composition calls
      // this before publishing the service, so a missing row cannot race a
      // gateway transition in the supported single-host writer boundary.
      await this.table.put(IMPORT_LEDGER_KEY, emptyImportLedger())
      const after = await this.table.get(IMPORT_LEDGER_KEY)
      if (after === undefined) throw new Error('import ledger initialization was not durable')
      validateLedger(after)
      return
    }
    validateLedger(raw)
  }

  private async readLedger(): Promise<ImportLedger> {
    this.assertInitialized()
    const raw = await this.table.get(IMPORT_LEDGER_KEY)
    if (raw === undefined) throw new Error('import ledger disappeared after initialization')
    return validateLedger(raw)
  }

  async get(key: string): Promise<ImportRecordRead | undefined> {
    const ledger = await this.readLedger()
    const record = ledger.records[key]
    return record === undefined ? undefined : ImportRecordReadSchema.parse(structuredClone(record))
  }

  async put(record: ImportRecord, expected?: ImportRecordRead): Promise<void> {
    const validated = ImportRecordSchema.parse(record)
    this.assertInitialized()
    await this.table.update(IMPORT_LEDGER_KEY, latest => {
      const ledger = validateLedger(latest)
      const current = ledger.records[validated.key]
      if (!recordsEqual(current, expected)) throw new Error('import ledger CAS mismatch: expected prior record differs')
      assertImportTransition(current, validated)
      const records = { ...ledger.records, [validated.key]: structuredClone(validated) }
      const next = { schemaVersion: 1 as const, generation: ledger.generation + 1, records }
      validateLedger(next)
      return next
    })
  }

  async list(): Promise<readonly ImportRecordRead[]> {
    const ledger = await this.readLedger()
    return Object.values(ledger.records).slice(0, IMPORT_LEDGER_MAX_RECORDS)
      .map(record => ImportRecordReadSchema.parse(structuredClone(record)))
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.closeDomain?.()
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('import ledger adapter must be initialized before use')
  }
}

export const IMPORT_LEDGER = Object.freeze({
  domain: IMPORT_LEDGER_DOMAIN,
  table: IMPORT_LEDGER_TABLE,
  key: IMPORT_LEDGER_KEY,
  maxRecords: IMPORT_LEDGER_MAX_RECORDS,
  maxJsonBytes: IMPORT_LEDGER_MAX_JSON_BYTES,
})

/** Official storage-domain declaration used by the production adapter factory. */
export const IMPORT_LEDGER_DOMAIN_SPEC: DshStorageDomainSpec = Object.freeze({
  name: IMPORT_LEDGER_DOMAIN,
  version: 1,
  layout: 'single',
  tables: Object.freeze({
    [IMPORT_LEDGER_TABLE]: Object.freeze({ valueSchema: ImportLedgerSchema }),
  }),
})

/** Open the official domain/table, initialize before publication, then expose the durable index. */
export async function createStorageDomainImportIndex(storageDomain: DshStorageDomainService): Promise<StorageDomainImportIndex> {
  const domain = await storageDomain.open(IMPORT_LEDGER_DOMAIN_SPEC)
  try {
    const table = domain.table(IMPORT_LEDGER_TABLE)
    const index = new StorageDomainImportIndex(table, IMPORT_LEDGER_DOMAIN, IMPORT_LEDGER_TABLE, domain.close?.bind(domain))
    await index.initialize()
    return index
  } catch (error) {
    try { await domain.close?.() } catch { /* preserve the initialization failure */ }
    throw error
  }
}

/** Optional source re-read seam used for TOCTOU checks immediately before create. */
export type ImportFingerprintReader = (request: PreparedImport, signal: AbortSignal) => Promise<string>
export type CwdIdentityReader = (cwd: string, signal: AbortSignal) => Promise<{ readonly device: string; readonly inode: string }>

export interface DshGatewayOptions {
  readonly index: ImportIndex
  readonly now?: () => Date
  readonly attemptId?: (identity: ImportIdentity) => string
  readonly fingerprint?: ImportFingerprintReader
  /** Stable directory identity captured during authorization and rechecked at TOCTOU boundaries. */
  readonly cwdIdentity?: CwdIdentityReader
  /** Source re-read seam used by startup migration/recovery (there is no seed request at startup). */
  readonly fingerprintRecord?: (record: ImportRecordRead, signal: AbortSignal) => Promise<string>
  /** Rebuild a bounded PreparedImport from the opaque restart intent. */
  readonly rebuildRecord?: (record: ImportRecordRead, signal: AbortSignal) => Promise<PreparedImport>
  readonly compilerSchema?: string
}

const COMPILER_SCHEMA = '1.0.0'
const IMPORT_INDEX_SCHEMA = 2 as const
const INDEX_NAMESPACE = 'dsh-codex-handoff/imports'

function recordsEqual(left: ImportRecordRead | undefined, right: ImportRecordRead | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function recoveryIntent(request: PreparedImport): ImportRecoveryIntent {
  const serialized = JSON.stringify(request.seed)
  if (serialized === undefined) {
    throw new HandoffError({ code: 'DSH_SEED_INVALID', message: 'The prepared handoff seed is not JSON-serializable.', recoverable: false })
  }
  const seedBytes = new TextEncoder().encode(serialized).byteLength
  if (request.mode === 'smart' && seedBytes > HARD_LIMITS.recoveryArtifactBytes) {
    throw new HandoffError({ code: 'DSH_SEED_INVALID', message: 'The Smart recovery artifact exceeds the durable restart limit.', recoverable: false })
  }
  return {
    source: request.source.expectedFingerprint === undefined
      ? { ...request.source, expectedFingerprint: request.sourceFingerprint }
      : request.source,
    seedDigest: sha256Hex(serialized),
    seedBytes,
    ...(request.mode === 'smart' ? {
      // Smart seeds are already redacted by the compiler and are the exact
      // deterministic artifact to replay after a crash. Never rerun an LLM or
      // re-inspect a mutable repository merely to guess the same result.
      seed: [...request.seed],
      ...(request.targetTokens === undefined ? {} : { targetTokens: request.targetTokens }),
      ...(request.useModel === undefined ? {} : { useModel: request.useModel }),
    } : {}),
    ...(request.cwdIdentity === undefined ? {} : { cwdIdentity: request.cwdIdentity }),
  }
}

function sameRecoverySource(left: ImportRecoveryIntent['source'], right: ImportRecoveryIntent['source']): boolean {
  return left.source === right.source
    && left.sessionId === right.sessionId
    && left.rolloutRevisionId === right.rolloutRevisionId
    && left.expectedFingerprint === right.expectedFingerprint
    && left.archived === right.archived
}

/** Once the destination is verified, only provenance/checksum metadata is
 * needed for attach recovery; never retain the replay artifact in the ledger. */
function compactRecoveryIntent(intent: ImportRecoveryIntent | undefined): ImportRecoveryIntent | undefined {
  if (intent === undefined) return undefined
  const { seed: _seed, ...withoutSeed } = intent
  return withoutSeed
}

/** Reject arbitrary state edits at the storage boundary; saga transitions are explicit. */
function assertImportTransition(current: ImportRecordRead | undefined, next: ImportRecord): void {
  if (current === undefined) {
    if (next.state !== 'prepared') throw new Error('import index must start in prepared state')
    return
  }
  if (current.schemaVersion === 1) return
  if (recordsEqual(current, next)) return
  const allowed: Record<ImportRecord['state'], readonly ImportRecord['state'][]> = {
    // A retry may refresh attempt/timestamps while remaining prepared after a
    // creating row was proven absent; it still uses the same expected record.
    prepared: ['prepared', 'creating', 'orphaned'],
    creating: ['prepared', 'created', 'failed', 'orphaned'],
    created: ['created', 'created_unattached', 'orphaned'],
    created_unattached: ['created', 'orphaned'],
    failed: [],
    // Only a later, exact destination verification may repair an orphaned
    // create record. The create path enforces that narrower transition.
    orphaned: ['created'],
  }
  if (!allowed[current.state].includes(next.state)) {
    throw new Error(`illegal import state transition ${current.state} -> ${next.state}`)
  }
}

function asRecord(value: JsonValue): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new HandoffError({ code: 'DSH_SEED_INVALID', message: 'The imported DSH seed is not an event object.', recoverable: false })
  }
  return value as Record<string, unknown>
}

function asJson<T>(value: T): JsonValue {
  return value as unknown as JsonValue
}

/**
 * Re-redact a prepared seed at the DSH boundary without losing the opaque
 * identity carried by compiler-created plugin provenance.  The exception is
 * intentionally narrow: the event must be a user/message, its source must
 * pass the strict PluginSource schema, and its identity must match this
 * already-validated import request. Arbitrary JSON keys never bypass redactJson.
 */
function redactPreparedSeedEvent(event: JsonValue, request: PreparedImport): JsonValue {
  const redacted = redactJson(event)
  if (request.mode !== 'full' && request.mode !== 'smart') return redacted
  const rawEvent = objectValue(event)
  if (rawEvent?.type !== 'user/message') return redacted
  const rawData = objectValue(rawEvent.data)
  if (rawData === undefined) return redacted
  const parsedSource = PluginSourceSchema.safeParse(rawData.source)
  if (!parsedSource.success) return redacted
  const source = parsedSource.data as PluginSource
  const expectedForm = request.mode === 'full' ? 'notice' : 'snapshot'
  if (
    source.form !== expectedForm
    || source.mode !== request.mode
    || source.sourceSessionId !== request.source.sessionId
    || source.rolloutRevisionId !== request.source.rolloutRevisionId
    || source.fingerprint !== request.sourceFingerprint
  ) return redacted

  const redactedEvent = objectValue(redacted)
  const redactedData = redactedEvent === undefined ? undefined : objectValue(redactedEvent.data)
  const redactedSource = objectValue(redactJson(asJson(source)))
  if (redactedEvent === undefined || redactedData === undefined || redactedSource === undefined) return redacted
  return asJson({
    ...redactedEvent,
    data: {
      ...redactedData,
      source: {
        ...redactedSource,
        sourceSessionId: source.sourceSessionId,
        rolloutRevisionId: source.rolloutRevisionId,
      },
    },
  })
}

function diagnostic(code: Diagnostic['code'], message: string, severity: Diagnostic['severity'] = 'warning'): Diagnostic {
  return { code, severity, message: message.slice(0, 8192), recoverable: severity !== 'error' }
}

function nowIso(now: () => Date): string {
  const date = now()
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString()
}

function abortIfNeeded(signal: AbortSignal): void {
  if (!signal.aborted) return
  throw new HandoffError({ code: 'CANCELLED', message: 'The handoff operation was cancelled.', recoverable: true })
}

function isCallable(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === 'function'
}

function getCapability(target: unknown, name: string): boolean {
  if (target === null || typeof target !== 'object') return false
  return isCallable((target as Record<string, unknown>)[name])
}

function requiredCapabilities(runtime: DshGatewayRuntime): CompatibilityView['required'] {
  return {
    agents: getCapability(runtime.agents, 'create'),
    agentDefaultModel: getCapability(runtime.agentDefaultModel, 'currentSelection'),
    sessionQuery: runtime.sessionQuery !== undefined && (
      getCapability(runtime.sessionQuery, 'has')
      || getCapability(runtime.sessionQuery, 'exists')
      || getCapability(runtime.sessionQuery, 'get')
      || getCapability(runtime.sessionQuery, 'find')
      || getCapability(runtime.sessionQuery, 'inspect')
      || getCapability(runtime.sessionQuery, 'readSession')
      || getCapability(runtime.sessionQuery, 'filterSessions')
      || getCapability(runtime.sessionQuery, 'listSessions')
      || getCapability(runtime.sessionQuery, 'list')
    ),
    sessionPersistence: runtime.sessionPersistence !== undefined,
    workspaceRegistry: runtime.workspaceRegistry !== undefined && (
      getCapability(runtime.workspaceRegistry, 'resolveByPath')
      || getCapability(runtime.workspaceRegistry, 'create')
      || getCapability(runtime.workspaceRegistry, 'attachSession')
    ),
    storageDomain: getCapability(runtime.storageDomain, 'open'),
    typert: runtime.typert !== undefined,
  }
}

function optionalCapabilities(runtime: DshGatewayRuntime): CompatibilityView['optional'] {
  return {
    llm: runtime.llm !== undefined,
    agentPresets: runtime.agentPresets !== undefined && getCapability(runtime.agentPresets, 'mount'),
    conversationSessionHeaderActions: false,
    settingsSection: false,
  }
}

function stableAttemptId(identity: ImportIdentity, timestamp: string): string {
  return 'attempt-' + sha256Hex(JSON.stringify([identity.key, timestamp])).slice(0, 48)
}

function destinationFromKey(key: string): string {
  return 'session-codex-handoff-' + key.slice(0, 32)
}

interface DestinationExpectation {
  readonly cwd: string
  readonly sourceSessionId: string
  readonly sourceRolloutRevisionId: string
  readonly sourceFingerprint: string
  readonly mode: 'smart' | 'full'
}

function destinationAbsent(now: () => Date): DestinationCheck {
  return { status: 'absent', checkedAt: nowIso(now) }
}

function destinationUnknown(now: () => Date, reason: 'query-unavailable' | 'query-failed' | 'inspect-failed' | 'metadata-missing'): DestinationCheck {
  return { status: 'unknown', reason, checkedAt: nowIso(now) }
}

function destinationConflict(now: () => Date, reason: 'destination-id-reused' | 'cwd-mismatch' | 'source-mismatch', observedCwd?: string): DestinationCheck {
  return {
    status: 'conflict',
    checkedAt: nowIso(now),
    reason,
    ...(observedCwd === undefined ? {} : { observedCwd }),
  }
}

function destinationVerified(now: () => Date, via: 'agent-create-handle' | 'session-query', expected: DestinationExpectation): DestinationCheck {
  return {
    status: 'verified',
    checkedAt: nowIso(now),
    via,
    cwd: expected.cwd,
    sourceSessionId: expected.sourceSessionId,
    sourceRolloutRevisionId: expected.sourceRolloutRevisionId,
    sourceFingerprint: expected.sourceFingerprint,
    mode: expected.mode,
    compilerSchema: COMPILER_SCHEMA,
  }
}

function importFailure(
  phase: ImportFailure['phase'],
  code: string,
  now: () => Date,
  recoverable: boolean,
): ImportFailure {
  return { phase, code: code.slice(0, 128), at: nowIso(now), recoverable }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function observationOf(value: unknown): { header?: Record<string, unknown>; events?: readonly unknown[] } | undefined {
  const record = objectValue(value)
  if (record === undefined) return undefined
  const header = objectValue(record.header) ?? objectValue(record.session)
    ?? ('id' in record && 'isSeeded' in record ? record : undefined)
  let events = Array.isArray(record.events) ? record.events : Array.isArray(record.sessionEvents) ? record.sessionEvents : undefined
  if (events === undefined && isCallable(record.snapshotEvents)) {
    try {
      const snapshot = record.snapshotEvents()
      events = Array.isArray(snapshot) ? snapshot : undefined
    } catch {
      // The caller converts missing/failed inspection into an unknown result.
    }
  }
  return { ...(header === undefined ? {} : { header }), ...(events === undefined ? {} : { events }) }
}

function sourceOfEvent(value: unknown): Record<string, unknown> | undefined {
  const record = objectValue(value)
  if (record === undefined) return undefined
  const data = objectValue(record.data)
  if (data === undefined) return undefined
  const direct = objectValue(data.source)
  if (direct !== undefined) return direct
  const message = objectValue(data.message)
  return message === undefined ? undefined : objectValue(message.source)
}

function verifiedFromObservation(value: unknown, expectation: DestinationExpectation, now: () => Date, via: 'agent-create-handle' | 'session-query'): DestinationCheck {
  if (value === undefined || value === null || value === false) return destinationAbsent(now)
  if (value === true) return destinationUnknown(now, 'metadata-missing')
  const direct = objectValue(value)
  if (direct?.status === 'verified') {
    if (direct.cwd !== expectation.cwd) return destinationConflict(now, 'cwd-mismatch', typeof direct.cwd === 'string' ? direct.cwd : undefined)
    if (
      direct.sourceSessionId !== expectation.sourceSessionId
      || direct.sourceRolloutRevisionId !== expectation.sourceRolloutRevisionId
      || direct.sourceFingerprint !== expectation.sourceFingerprint
      || direct.mode !== expectation.mode
      || direct.compilerSchema !== COMPILER_SCHEMA
    ) return destinationConflict(now, 'source-mismatch')
    return destinationVerified(now, via, expectation)
  }
  if (direct?.status === 'absent') return destinationAbsent(now)
  if (direct?.status === 'unknown') return destinationUnknown(now, 'query-failed')
  if (direct?.status === 'conflict') return destinationConflict(now, direct.reason === 'cwd-mismatch' ? 'cwd-mismatch' : 'source-mismatch', typeof direct.observedCwd === 'string' ? direct.observedCwd : undefined)
  const observation = observationOf(value)
  if (observation === undefined) return destinationUnknown(now, 'metadata-missing')
  const cwd = observation.header?.cwd
  if (typeof cwd !== 'string') return destinationUnknown(now, 'metadata-missing')
  if (cwd !== expectation.cwd) return destinationConflict(now, 'cwd-mismatch', cwd)
  if (observation.events === undefined) return destinationUnknown(now, 'metadata-missing')
  const pluginSources = observation.events.map(sourceOfEvent).filter((source): source is Record<string, unknown> => source !== undefined)
    .filter(source => source.kind === 'plugin' && source.plugin === 'dsh-codex-handoff' && (
      source.form === 'notice' && typeof source.summary === 'string' && source.summary.length > 0
      || source.form === 'snapshot' && Array.isArray(source.sections)
    ))
  if (pluginSources.length === 0) return destinationUnknown(now, 'metadata-missing')
  const matching = pluginSources.find(source => (
    (
      source.sourceSessionId === expectation.sourceSessionId
      && source.rolloutRevisionId === expectation.sourceRolloutRevisionId
      // DSH may sanitize UUID-like opaque identifiers while materializing a
      // seeded message. Both identifiers must be sanitized together, while
      // the immutable fingerprint/mode/compiler checks remain exact.
      || source.sourceSessionId === REDACTED
      && source.rolloutRevisionId === REDACTED
    )
    && source.fingerprint === expectation.sourceFingerprint
    && source.mode === expectation.mode
    && source.compilerSchema === COMPILER_SCHEMA
  ))
  if (matching === undefined) return destinationConflict(now, 'source-mismatch')
  return destinationVerified(now, via, expectation)
}

/**
 * Compute the immutable import identity. The key includes every source and
 * destination fact that can change the resulting DSH history.
 */
export function computeImportIdentity(request: Pick<PreparedImport, 'source' | 'mode' | 'cwd'> & { readonly sourceFingerprint?: string }): ImportIdentity {
  const source = request.source
  const key = sha256Hex(JSON.stringify([
    'codex',
    source.sessionId,
    source.rolloutRevisionId,
    request.sourceFingerprint ?? source.expectedFingerprint ?? '',
    request.mode,
    request.cwd,
    COMPILER_SCHEMA,
  ]))
  return ImportIdentitySchema.parse({ key, destinationSessionId: destinationFromKey(key) })
}

/** In-memory adapter for unit tests; production wiring must provide a durable storage-domain adapter. */
export class MemoryImportIndex implements ImportIndex {
  private readonly records = new Map<string, ImportRecordRead>()

  async get(key: string): Promise<ImportRecordRead | undefined> {
    const record = this.records.get(key)
    return record === undefined ? undefined : ImportRecordReadSchema.parse(structuredClone(record))
  }

  async put(record: ImportRecord, expected?: ImportRecordRead): Promise<void> {
    const validated = ImportRecordSchema.parse(record)
    const current = this.records.get(validated.key)
    if (!recordsEqual(current, expected)) {
      throw new Error('import index CAS mismatch: expected prior record differs')
    }
    assertImportTransition(current, validated)
    this.records.set(validated.key, structuredClone(validated))
  }

  async list(): Promise<readonly ImportRecordRead[]> {
    return [...this.records.values()].map(record => ImportRecordReadSchema.parse(structuredClone(record)))
  }
}

/**
 * Host-side session gateway. It only uses the public Agent factory and a
 * plugin-owned whole-record index; it never writes DSH JSONL or drives an
 * imported historical turn.
 */
export class DshSessionGateway implements DshSessionGatewayPort {
  private readonly inflight = new Map<string, Promise<CreateOutcome>>()
  private readonly handles = new Map<string, DshAgentHandle>()
  private readonly now: () => Date

  constructor(
    private readonly runtime: DshGatewayRuntime,
    private readonly options: DshGatewayOptions,
  ) {
    this.now = options.now ?? (() => new Date())
  }

  /** Probe the Host without activating any session, persistence writer, or workspace. */
  compatibility(): CompatibilityView {
    const required = requiredCapabilities(this.runtime)
    const optional = optionalCapabilities(this.runtime)
    const diagnostics: Diagnostic[] = []
    for (const [name, present] of Object.entries(required)) {
      if (!present) diagnostics.push(diagnostic('DSH_INCOMPATIBLE', `Required DSH capability is unavailable: ${name}.`, 'error'))
    }
    if (this.runtime.observedSessionFormat !== undefined && this.runtime.observedSessionFormat !== 2) {
      diagnostics.push(diagnostic('DSH_INCOMPATIBLE', 'The observed DSH session format is not the supported v2 format.', 'error'))
    }
    const view = {
      compatible: Object.values(required).every(Boolean)
        && (this.runtime.observedSessionFormat === undefined || this.runtime.observedSessionFormat === 2),
      ...(this.runtime.dshVersion === undefined ? {} : { dshVersion: this.runtime.dshVersion }),
      ...(this.runtime.observedSessionFormat === undefined ? {} : { observedSessionFormat: this.runtime.observedSessionFormat }),
      required,
      optional,
      diagnostics: diagnostics.slice(0, 10_000),
      checkedAt: nowIso(this.now),
    }
    return CompatibilityViewSchema.parse(view)
  }

  async find(identity: ImportIdentity, signal: AbortSignal = new AbortController().signal): Promise<string | undefined> {
    abortIfNeeded(signal)
    const validIdentity = ImportIdentitySchema.parse(identity)
    const record = await this.indexGet(validIdentity.key, signal)
    if (record === undefined || record.schemaVersion !== 2 || (record.state !== 'created' && record.state !== 'created_unattached')) return undefined
    if (this.handles.has(record.destinationSessionId)) return record.destinationSessionId
    const check = await this.inspectDestination(record.destinationSessionId, this.expectation(record), signal)
    return check.status === 'verified' ? record.destinationSessionId : undefined
  }

  /** Create once per import key; concurrent callers join the same promise. */
  async create(request: PreparedImport, signal: AbortSignal = new AbortController().signal): Promise<CreateOutcome> {
    const prepared = this.parsePrepared(request)
    abortIfNeeded(signal)
    this.assertCreateCompatible()
    const key = prepared.identity.key
    const running = this.inflight.get(key)
    if (running !== undefined) return await running
    const operation = this.createOnce(prepared, signal)
    this.inflight.set(key, operation)
    try {
      return await operation
    } finally {
      if (this.inflight.get(key) === operation) this.inflight.delete(key)
    }
  }

  /** Dispose every live Agent handle owned by this Host composition. */
  async disposeAll(): Promise<void> {
    const live = [...this.handles.entries()]
    this.handles.clear()
    const failures: unknown[] = []
    for (const [, handle] of live) {
      try {
        await handle.dispose()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new HandoffError({
        code: 'INTERNAL',
        message: 'One or more DSH Agent handles could not be disposed.',
        recoverable: false,
        details: { count: failures.length },
        cause: failures[0],
      })
    }
  }

  /** Recover bounded nonterminal rows after a Host crash without deleting either side. */
  async recover(signal: AbortSignal = new AbortController().signal): Promise<readonly ImportRecord[]> {
    const rows = await this.indexList(signal)
    const recovered: ImportRecord[] = []
    for (const row of rows.slice(0, 10_000)) {
      abortIfNeeded(signal)
      if (!isV2Record(row)) {
        recovered.push(await this.migrateLegacy(row, signal))
        continue
      }
      if (row.state === 'failed' || row.state === 'orphaned') {
        recovered.push(row)
        continue
      }
      // A committed destination is terminal and immutable. Startup must keep
      // the audit record without querying the source or destination again:
      // the source may legitimately have changed since the import completed,
      // and a query can be unavailable while the committed record remains
      // valid.
      if (row.state === 'created' && row.workspaceAttachedAt !== undefined) {
        // Older v2 rows could retain the Smart replay artifact after the
        // marker commit. Compact those rows opportunistically without ever
        // re-reading source or destination state.
        recovered.push(row.recovery?.seed === undefined
          ? row
          : await this.toWorkspaceAttached(row, signal))
        continue
      }
      // Older v2 rows have no restart intent. They are readable for audit and
      // normal explicit create idempotency, but startup must never guess a
      // source path or replay a seed without an opaque source ref.
      if (row.recovery === undefined && (row.state === 'prepared' || row.state === 'creating')) {
        const check = await this.inspectDestination(row.destinationSessionId, this.expectation(row), signal)
        recovered.push(await this.toOrphaned(row, check, 'RECOVERY_INTENT_UNAVAILABLE', 'source-before-create', signal))
        continue
      }
      const check = await this.inspectDestination(row.destinationSessionId, this.expectation(row), signal)
      // A verified destination is immutable. Only nonterminal rows need a
      // fresh source read; later source edits must not orphan an already
      // committed import or its created_unattached retry marker.
      const fingerprint = row.state === 'prepared' || row.state === 'creating'
        ? await this.readLegacyFingerprint(row, signal)
        : row.sourceFingerprint
      if ((row.state === 'prepared' || row.state === 'creating')
        && (fingerprint === undefined || fingerprint !== row.sourceFingerprint)) {
        recovered.push(await this.toOrphaned(
          row,
          check,
          fingerprint === undefined ? 'SOURCE_FINGERPRINT_UNAVAILABLE' : 'SOURCE_CHANGED',
          'source-before-create',
          signal,
        ))
        continue
      }
      if (check.status === 'verified') {
        let adopted: CreatedRecord | CreatedUnattachedRecord
        if (row.state === 'created' || row.state === 'created_unattached') adopted = row
        else if (row.state === 'creating') adopted = await this.toCreated(row, check, fingerprint ?? row.sourceFingerprint, signal)
        else {
          // A prepared row has no recorded create attempt. An existing
          // destination cannot be adopted without violating the saga.
          recovered.push(await this.toOrphaned(row, check, 'IMPORT_ID_CONFLICT', 'destination-query', signal))
          continue
        }
        try {
          // Recovery records carry the directory identity captured at
          // authorization time.  Never attach a durable destination to a
          // same-path replacement (or to an old v2 row with no identity).
          await this.assertRecordCwdIdentity(row, signal)
          await this.attachWorkspace(row.cwd, row.destinationSessionId)
          recovered.push(adopted.state === 'created_unattached'
            ? await this.toCreatedFromUnattached(adopted, check, fingerprint ?? row.sourceFingerprint, signal)
            : await this.toWorkspaceAttached(adopted, signal))
        } catch (error) {
          abortIfNeeded(signal)
          if (error instanceof HandoffError && error.code === 'CWD_NOT_FOUND') {
            recovered.push(adopted.state === 'created_unattached'
              ? adopted
              : await this.toCreatedUnattached(adopted, check, 'CWD_NOT_FOUND', signal))
            continue
          }
          if (error instanceof HandoffError && error.details?.phase === 'index-commit') {
            // Destination and workspace attachment may already have succeeded;
            // retain the unmarked created row for the next restart instead of
            // inventing a failed/unattached destination state.
            recovered.push(adopted)
            continue
          }
          recovered.push(adopted.state === 'created_unattached'
            ? adopted
            : await this.toCreatedUnattached(adopted, check, 'WORKSPACE_ATTACH_FAILED', signal))
        }
      } else if (check.status === 'absent' && (row.state === 'creating' || row.state === 'prepared')) {
        if (this.options.rebuildRecord === undefined) {
          recovered.push(await this.toOrphaned(row, check, 'RECOVERY_REBUILD_UNAVAILABLE', 'source-before-create', signal))
          continue
        }
        try {
          await this.assertRecordCwdIdentity(row, signal)
          const rebuilt = await this.options.rebuildRecord(row, signal)
          const expectedIdentity = computeImportIdentity(rebuilt)
          if (expectedIdentity.key !== row.key || expectedIdentity.destinationSessionId !== row.destinationSessionId) {
            throw new HandoffError({ code: 'SOURCE_CHANGED', message: 'The durable recovery identity no longer matches the source.', recoverable: true })
          }
          const rebuiltIntent = recoveryIntent(rebuilt)
          if (row.recovery === undefined
            || rebuiltIntent.seedDigest !== row.recovery.seedDigest
            || rebuiltIntent.seedBytes !== row.recovery.seedBytes
            || rebuiltIntent.targetTokens !== row.recovery.targetTokens
            || rebuiltIntent.useModel !== row.recovery.useModel
            || JSON.stringify(rebuiltIntent.cwdIdentity) !== JSON.stringify(row.recovery.cwdIdentity)
            || !sameRecoverySource(rebuiltIntent.source, row.recovery.source)) {
            throw new HandoffError({ code: 'SOURCE_CHANGED', message: 'The rebuilt recovery seed no longer matches the durable intent.', recoverable: true })
          }
          const rebuiltFingerprint = await this.readFingerprint(rebuilt, signal)
          this.assertFingerprint(rebuilt, rebuiltFingerprint)
          await this.create(rebuilt, signal)
          const latest = await this.indexGet(row.key, signal)
          if (latest === undefined || !isV2Record(latest)) throw new Error('recovery did not leave a durable import record')
          recovered.push(latest)
        } catch (error) {
          abortIfNeeded(signal)
          const latest = await this.indexGet(row.key, signal)
          // A post-create index commit failure deliberately leaves `creating`.
          // Keep that marker for the next restart so a durable destination can
          // be adopted; never convert it to a guessed new attempt here.
          if (latest !== undefined && isV2Record(latest) && latest.state === 'creating'
            && error instanceof HandoffError && error.details?.phase === 'index-commit') {
            recovered.push(latest)
            continue
          }
          const code = error instanceof HandoffError && (error.code === 'SOURCE_CHANGED' || error.code === 'SOURCE_STALE' || error.code === 'CWD_NOT_FOUND')
            ? error.code
            : 'RECOVERY_REBUILD_FAILED'
          recovered.push(await this.toOrphaned(row, check, code, 'source-before-create', signal))
        }
      } else if ((row.state === 'created' || row.state === 'created_unattached') && check.status === 'unknown') {
        // Query uncertainty must not destroy a successfully-created
        // destination. Keep the partial marker for a later explicit retry.
        recovered.push(row)
      } else if (check.status === 'absent') {
        // A terminal destination record that disappeared is not recreated during
        // recovery; preserve the audit trail as an orphan instead.
        recovered.push(await this.toOrphaned(row, check, 'SESSION_NOT_VISIBLE', 'destination-query', signal))
      } else {
        recovered.push(await this.toOrphaned(row, check, check.status === 'conflict' ? 'IMPORT_ID_CONFLICT' : 'SESSION_NOT_VISIBLE', 'destination-query', signal))
      }
    }
    return recovered
  }

  private parsePrepared(request: PreparedImport): PreparedImport {
    try {
      const parsed = PreparedImportSchema.parse(request)
      const safeSeed = parsed.seed.map(event => redactPreparedSeedEvent(event, parsed))
      const seedJson = JSON.stringify(safeSeed)
      if (seedJson === undefined) throw new Error('seed is not JSON-serializable')
      const seedBytes = new TextEncoder().encode(seedJson).byteLength
      const { seedBytes: _seedBytes, totalBytes: _totalBytes, ...withoutByteHints } = parsed
      const prepared = PreparedImportSchema.parse({
        ...withoutByteHints,
        seed: safeSeed,
        seedBytes,
        totalBytes: seedBytes,
      })
      const expectedIdentity = computeImportIdentity(prepared)
      if (
        prepared.identity.key !== expectedIdentity.key
        || prepared.identity.destinationSessionId !== expectedIdentity.destinationSessionId
      ) {
        throw new Error('destination identity does not match import key')
      }
      return prepared
    } catch (error) {
      if (error instanceof HandoffError) throw error
      throw new HandoffError({
        code: 'DSH_SEED_INVALID',
        message: 'The prepared handoff payload is invalid.',
        recoverable: false,
        cause: error,
      })
    }
  }

  private async createOnce(request: PreparedImport, signal: AbortSignal): Promise<CreateOutcome> {
    abortIfNeeded(signal)
    const existing = await this.indexGet(request.identity.key, signal)
    const expectation = this.expectation(request)
    const destination = await this.inspectDestination(request.identity.destinationSessionId, expectation, signal)
    if (existing === undefined && (destination.status === 'verified' || destination.status === 'conflict')) {
      throw new HandoffError({ code: 'IMPORT_ID_CONFLICT', message: 'The deterministic DSH destination identity is already in use.', recoverable: false })
    }
    let prior: V2ImportRecord | undefined
    if (existing !== undefined && !isV2Record(existing)) {
      prior = await this.migrateLegacyForRequest(existing, request, destination, signal)
      if (prior.state === 'created' || prior.state === 'created_unattached') {
        if (destination.status !== 'verified') throw this.destinationFailure(destination)
        if (prior.state === 'created' && prior.workspaceAttachedAt !== undefined) return this.outcome('existing', prior.destinationSessionId, true, [])
        return await this.finalizeRequestAttachment(request, prior, destination, request.sourceFingerprint, signal, 'existing')
      }
      if (prior.state === 'failed' || prior.state === 'orphaned') {
        throw new HandoffError({ code: 'SESSION_NOT_VISIBLE', message: 'This migrated import record is terminal and cannot be retried.', recoverable: false })
      }
      await this.assertRecordCwdIdentity(prior, signal)
    } else if (existing !== undefined) {
      const current = existing
      prior = current
      if (current.state === 'created' || current.state === 'created_unattached') {
        if (destination.status === 'verified') {
          if (current.state === 'created' && current.workspaceAttachedAt !== undefined) return this.outcome('existing', current.destinationSessionId, true, [])
          if (current.state === 'created') {
            return await this.finalizeRequestAttachment(request, current, destination, request.sourceFingerprint, signal, 'existing')
          }
          let retryFingerprint: string
          try {
            retryFingerprint = await this.readFingerprint(request, signal)
            this.assertFingerprint(request, retryFingerprint)
          } catch (error) {
            await this.toOrphaned(current, destination, error instanceof HandoffError ? error.code : 'DSH_SEED_INVALID', 'source-before-create', signal)
            if (error instanceof HandoffError) throw error
            throw new HandoffError({ code: 'DSH_SEED_INVALID', message: 'The source fingerprint could not be verified for workspace retry.', recoverable: true, cause: error })
          }
          return await this.finalizeRequestAttachment(request, current, destination, retryFingerprint, signal, 'existing')
        }
        await this.toOrphaned(current, destination, destination.status === 'conflict' ? 'IMPORT_ID_CONFLICT' : 'SESSION_NOT_VISIBLE', 'destination-query', signal)
        throw this.destinationFailure(destination)
      } else if (current.state === 'prepared' || current.state === 'creating') {
        await this.assertRecordCwdIdentity(current, signal)
        if (destination.status === 'verified') {
          if (current.state !== 'creating') throw new HandoffError({ code: 'IMPORT_ID_CONFLICT', message: 'A prepared import cannot adopt an existing destination without a create attempt.', recoverable: true })
          let fingerprintAfter: string
          try {
            fingerprintAfter = await this.readFingerprint(request, signal)
            this.assertFingerprint(request, fingerprintAfter)
          } catch (error) {
            await this.toOrphaned(current, destination, error instanceof HandoffError ? error.code : 'DSH_SEED_INVALID', 'source-after-create', signal)
            if (error instanceof HandoffError) throw error
            throw new HandoffError({ code: 'DSH_SEED_INVALID', message: 'The source fingerprint could not be verified during recovery.', recoverable: true, cause: error })
          }
          const adopted = await this.toCreated(current, destination, fingerprintAfter, signal)
          return await this.finalizeRequestAttachment(request, adopted, destination, fingerprintAfter, signal, 'existing')
        }
        if (destination.status !== 'absent') {
          await this.toOrphaned(current, destination, destination.status === 'conflict' ? 'IMPORT_ID_CONFLICT' : 'SESSION_NOT_VISIBLE', 'destination-query', signal)
          throw this.destinationFailure(destination)
        }
        prior = current.state === 'creating' ? await this.toPrepared(current, signal) : current
      } else if (
        current.state === 'orphaned'
        && current.failure.recoverable
        && current.failure.code === 'IMPORT_ID_CONFLICT'
        && (
          current.failure.phase === 'destination-verify'
          || current.failure.phase === 'destination-query' && current.createStartedAt !== undefined
        )
        && destination.status === 'verified'
      ) {
        // The destination can outlive a verification failure. Re-adopt it
        // only after the current source, durable workspace identity, and the
        // destination's immutable provenance all verify again.
        await this.assertRecordCwdIdentity(current, signal)
        const fingerprintAfter = await this.readFingerprint(request, signal)
        this.assertFingerprint(request, fingerprintAfter)
        const adopted = await this.toCreatedFromOrphaned(current, destination, fingerprintAfter, signal)
        return await this.finalizeRequestAttachment(request, adopted, destination, fingerprintAfter, signal, 'existing')
      } else {
        throw new HandoffError({ code: 'IMPORT_ID_CONFLICT', message: 'This import key is terminal and cannot be retried.', recoverable: false })
      }
    }
    if (destination.status === 'unknown') throw this.destinationFailure(destination)

    const fingerprintBefore = await this.readFingerprint(request, signal)
    this.assertFingerprint(request, fingerprintBefore)
    const attemptId = this.options.attemptId?.(request.identity) ?? stableAttemptId(request.identity, nowIso(this.now))
    const preparedAt = nowIso(this.now)
    const base = ImportRecordSchema.parse({
      schemaVersion: IMPORT_INDEX_SCHEMA,
      key: request.identity.key,
      sourceSessionId: request.source.sessionId,
      sourceRolloutRevisionId: request.source.rolloutRevisionId,
      sourceFingerprint: request.sourceFingerprint,
      mode: request.mode,
      cwd: request.cwd,
      destinationSessionId: request.identity.destinationSessionId,
      state: 'prepared',
      sourceFingerprintBefore: fingerprintBefore,
      attemptId,
      createdAt: preparedAt,
      updatedAt: preparedAt,
      recovery: recoveryIntent(request),
    }) as Extract<ImportRecord, { state: 'prepared' }>
    try {
      await this.persist(base, prior, signal)
    } catch (error) {
      if (error instanceof HandoffError && error.details?.phase === 'index-commit') {
        const adopted = await this.adoptCompeting(request, signal)
        if (adopted !== undefined) return adopted
      }
      throw error
    }
    let creating: Extract<ImportRecord, { state: 'creating' }>
    try {
      creating = await this.toCreating(base, signal)
    } catch (error) {
      if (error instanceof HandoffError && error.details?.phase === 'index-commit') {
        const adopted = await this.adoptCompeting(request, signal)
        if (adopted !== undefined) return adopted
      }
      throw error
    }
    let handle: DshAgentHandle | undefined
    let createdRecord: Extract<ImportRecord, { state: 'created' }> | undefined
    let adoptedAfterCreateFailure = false
    let terminalized = false
    let failurePhase: ImportFailure['phase'] = 'agent-create'
    try {
      abortIfNeeded(signal)
      const selection = this.runtime.agentDefaultModel?.currentSelection()
      const presetService = this.runtime.agentPresets !== undefined
        && getCapability(this.runtime.agentPresets, 'resolve')
        && getCapability(this.runtime.agentPresets, 'mount')
        ? this.runtime.agentPresets
        : undefined
      const preset = presetService === undefined ? undefined : await presetService.resolve()
      const seed = request.seed.map(asRecord)
      const createOptions: Parameters<DshAgentsService['create']>[0] = {
        sessionId: request.identity.destinationSessionId,
        // Imported replay is deliberately not a DSH fork. Keep this metadata minimal.
        meta: {
          cwd: request.cwd,
          ...(preset === undefined ? {} : { agentPreset: preset.id }),
        },
        seed,
        ...(selection === undefined ? {} : { agentOptions: { ...selection } }),
        ...(preset === undefined || presetService === undefined ? {} : {
          setup: async (agentContext: unknown) => {
            await presetService.mount(agentContext, preset.id)
          },
        }),
        signal,
      }
      // Re-read immediately before the irreversible Agent.create call. The
      // preset lookup/setup boundary may have yielded to another writer or a
      // source replacement, so the earlier prepared fingerprint is not enough.
      const fingerprintBeforeCreate = await this.readFingerprint(request, signal)
      this.assertFingerprint(request, fingerprintBeforeCreate)
      await this.assertCwdIdentity(request, signal)
      handle = await this.requireAgents().create(createOptions)
      if (handle === undefined || typeof handle.dispose !== 'function') {
        throw new Error('DSH Agent factory returned no disposable handle')
      }
      let check = this.inspectHandle(handle, expectation)
      failurePhase = 'destination-verify'
      if (check.status !== 'verified') check = await this.inspectDestination(request.identity.destinationSessionId, expectation, signal)
      if (check.status !== 'verified') {
        await this.toOrphaned(creating, check, check.status === 'conflict' ? 'IMPORT_ID_CONFLICT' : 'SESSION_NOT_VISIBLE', 'destination-verify', signal)
        terminalized = true
        throw this.destinationFailure(check)
      }
      abortIfNeeded(signal)
      failurePhase = 'source-after-create'
      const fingerprintAfter = await this.readFingerprint(request, signal)
      this.assertFingerprint(request, fingerprintAfter)
      failurePhase = 'index-commit'
      const created = await this.toCreated(creating, check, fingerprintAfter, signal)
      this.handles.set(request.identity.destinationSessionId, handle)
      createdRecord = created
    } catch (error) {
      if (handle === undefined) {
        const check = await this.inspectDestination(request.identity.destinationSessionId, expectation, signal)
        if (check.status === 'verified') {
          // Another Host may have won the Agent.create race just as this
          // process received a collision/error. Exact metadata verification
          // permits adoption; never orphan a destination that is ours.
          try {
            const fingerprintAfter = await this.readFingerprint(request, signal)
            this.assertFingerprint(request, fingerprintAfter)
            createdRecord = await this.toCreated(creating, check, fingerprintAfter, signal)
            adoptedAfterCreateFailure = true
          } catch (adoptionError) {
            await this.toOrphaned(creating, check, this.failureCode(adoptionError), 'source-after-create', signal)
          }
        } else if (check.status === 'absent') await this.toFailed(creating, check, this.failureCode(error), 'agent-create', signal)
        else await this.toOrphaned(creating, check, this.failureCode(error), 'destination-query', signal)
      } else if (error instanceof HandoffError && error.details?.phase === 'index-commit') {
        // The DSH session may already be durable. Keep the creating row as an
        // explicit recovery marker; a failed index commit cannot prove either
        // side's final state, and dispose only unloads the live handle.
        this.handles.delete(request.identity.destinationSessionId)
        if (typeof handle.dispose === 'function') await handle.dispose().catch(() => undefined)
      } else {
        if (!terminalized) {
          const check = this.inspectHandle(handle, expectation)
          await this.toOrphaned(creating, check, this.failureCode(error), failurePhase, signal)
        }
        this.handles.delete(request.identity.destinationSessionId)
        if (typeof handle.dispose === 'function') await handle.dispose().catch(() => undefined)
      }
      if (adoptedAfterCreateFailure) {
        // Continue through the common idempotent workspace-attach/marker path
        // below; the original Agent.create error has been superseded by a
        // verified competing destination.
      } else {
        if (error instanceof HandoffError) throw error
        throw new HandoffError({
          code: 'DSH_SEED_INVALID',
          message: 'The imported history could not be accepted by DSH.',
          recoverable: true,
          cause: error,
        })
      }
    }
    if (createdRecord === undefined) {
      throw new HandoffError({ code: 'INTERNAL', message: 'The DSH destination commit was not completed.', recoverable: false })
    }

    return await this.finalizeRequestAttachment(
      request,
      createdRecord,
      createdRecord.destination,
      request.sourceFingerprint,
      signal,
      adoptedAfterCreateFailure ? 'existing' : 'created',
      // A destination created by this call was just checked against the
      // request identity at the irreversible boundary. Durable recovery and
      // adoption paths keep the strict ledger identity check below.
      adoptedAfterCreateFailure,
    )
  }

  private requireAgents(): DshAgentsService {
    if (this.runtime.agents === undefined || !getCapability(this.runtime.agents, 'create')) {
      throw new HandoffError({ code: 'DSH_INCOMPATIBLE', message: 'The DSH Agent factory is unavailable.', recoverable: false })
    }
    return this.runtime.agents
  }

  /**
   * A second Host process may lose the ledger CAS after the first process has
   * already published the durable destination. Re-read the latest row and
   * destination for a bounded interval; exact metadata match adopts it as an
   * existing result instead of surfacing a spurious duplicate-submit error.
   */
  private async adoptCompeting(request: PreparedImport, signal: AbortSignal): Promise<CreateOutcome | undefined> {
    const expected = this.expectation(request)
    for (let attempt = 0; attempt < 40; attempt += 1) {
      abortIfNeeded(signal)
      const current = await this.indexGet(request.identity.key, signal)
      if (current !== undefined && isV2Record(current)) {
        const sameImport = current.sourceSessionId === request.source.sessionId
          && current.sourceRolloutRevisionId === request.source.rolloutRevisionId
          && current.sourceFingerprint === request.sourceFingerprint
          && current.mode === request.mode
          && current.cwd === request.cwd
          && current.destinationSessionId === request.identity.destinationSessionId
        if (!sameImport || current.state === 'failed' || current.state === 'orphaned') return undefined
        const check = await this.inspectDestination(current.destinationSessionId, expected, signal)
        if (check.status === 'verified') {
          if (current.state === 'created' && current.workspaceAttachedAt !== undefined) return this.outcome('existing', current.destinationSessionId, true, [])
          try {
            let adopted: CreatedRecord | CreatedUnattachedRecord
            let fingerprint = request.sourceFingerprint
            if (current.state === 'creating') {
              fingerprint = await this.readFingerprint(request, signal)
              this.assertFingerprint(request, fingerprint)
              adopted = await this.toCreated(current, check, fingerprint, signal)
            } else if (current.state === 'created' || current.state === 'created_unattached') {
              adopted = current
              if (current.state === 'created_unattached') {
                fingerprint = await this.readFingerprint(request, signal)
                this.assertFingerprint(request, fingerprint)
              }
            } else {
              return undefined
            }
            return await this.finalizeRequestAttachment(request, adopted, check, fingerprint, signal, 'existing')
          } catch (error) {
            if (!(error instanceof HandoffError && error.details?.phase === 'index-commit')) return undefined
          }
        } else if (check.status === 'conflict') return undefined
      }
      await new Promise<void>(resolve => setTimeout(resolve, 5))
    }
    return undefined
  }

  private assertCreateCompatible(): void {
    const view = this.compatibility()
    if (!view.compatible) {
      throw new HandoffError({
        code: 'DSH_INCOMPATIBLE',
        message: 'The installed DSH host does not expose the required v2 session capabilities.',
        recoverable: false,
      })
    }
  }

  private async readFingerprint(request: PreparedImport, signal: AbortSignal): Promise<string> {
    abortIfNeeded(signal)
    return this.options.fingerprint === undefined
      ? request.sourceFingerprint
      : await this.options.fingerprint(request, signal)
  }

  private assertFingerprint(request: PreparedImport, actual: string): void {
    if (actual !== request.sourceFingerprint || request.source.expectedFingerprint !== undefined && actual !== request.source.expectedFingerprint) {
      throw new HandoffError({ code: 'SOURCE_CHANGED', message: 'The Codex source changed during import; preview it again.', recoverable: true })
    }
  }

  private async assertCwdIdentity(request: PreparedImport, signal: AbortSignal): Promise<void> {
    if (request.cwdIdentity === undefined || this.options.cwdIdentity === undefined) return
    const current = await this.options.cwdIdentity(request.cwd, signal)
    if (current.device !== request.cwdIdentity.device || current.inode !== request.cwdIdentity.inode) {
      throw new HandoffError({ code: 'CWD_NOT_FOUND', message: 'The selected workspace directory was replaced.', recoverable: true })
    }
  }

  /**
   * Restart/adoption boundary for durable rows.  A v2 record without the
   * captured identity is deliberately not attachable: continuing would turn
   * an old path-only record into an authorization to attach a replacement
   * directory.
   */
  private async assertRecordCwdIdentity(record: ImportRecordRead, signal: AbortSignal): Promise<void> {
    const expected = record.schemaVersion === 2 ? record.recovery?.cwdIdentity : undefined
    if (expected === undefined) {
      throw new HandoffError({ code: 'CWD_NOT_FOUND', message: 'The durable workspace identity is unavailable; attachment is blocked.', recoverable: true })
    }
    // A durable row is never attachable without a current identity reader.
    // Retaining only the captured strings would authorize a same-path
    // replacement after restart.
    if (this.options.cwdIdentity === undefined) {
      throw new HandoffError({ code: 'CWD_NOT_FOUND', message: 'The runtime cannot revalidate the durable workspace identity; attachment is blocked.', recoverable: true })
    }
    const current = await this.options.cwdIdentity(record.cwd, signal)
    if (current.device !== expected.device || current.inode !== expected.inode) {
      throw new HandoffError({ code: 'CWD_NOT_FOUND', message: 'The durable workspace directory was replaced.', recoverable: true })
    }
  }

  private expectation(value: PreparedImport | ImportRecordRead): DestinationExpectation {
    const sourceSessionId = 'sourceSessionId' in value ? value.sourceSessionId : value.source.sessionId
    const sourceRolloutRevisionId = 'sourceRolloutRevisionId' in value ? value.sourceRolloutRevisionId : value.source.rolloutRevisionId
    const sourceFingerprint = value.sourceFingerprint
    return {
      cwd: value.cwd,
      sourceSessionId,
      sourceRolloutRevisionId,
      sourceFingerprint,
      mode: value.mode,
    }
  }

  private inspectHandle(handle: DshAgentHandle, expectation: DestinationExpectation): DestinationCheck {
    try {
      const agent = objectValue((handle as unknown as { agent?: unknown }).agent)
      const session = objectValue(agent?.session)
      if (session === undefined) return destinationUnknown(this.now, 'metadata-missing')
      const snapshotEvents = session.snapshotEvents
      let events: readonly unknown[] | undefined
      if (isCallable(snapshotEvents)) {
        const value = snapshotEvents.call(session)
        events = Array.isArray(value) ? value : undefined
      }
      return verifiedFromObservation({ header: session.header, events }, expectation, this.now, 'agent-create-handle')
    } catch {
      return destinationUnknown(this.now, 'inspect-failed')
    }
  }

  private async inspectDestination(sessionId: string, expectation: DestinationExpectation, signal: AbortSignal): Promise<DestinationCheck> {
    abortIfNeeded(signal)
    const query = this.runtime.sessionQuery
    if (query === undefined) return destinationUnknown(this.now, 'query-unavailable')
    try {
      let value: unknown
      // The fixed DSH SessionQuery may expose a throwing readSession shim even
      // when the destination is absent. Enumerate by id first; an empty
      // filter/list is authoritative absence, while a hit is then expanded by
      // readSession for provenance/event verification.
      const match = (rows: readonly unknown[]): unknown => rows.find(row => {
        if (typeof row === 'string') return row === sessionId
        const record = objectValue(row)
        const header = record === undefined ? undefined : objectValue(record.header)
        return header?.id === sessionId || record?.id === sessionId
      })
      if (isCallable(query.filterSessions)) {
        const rows = await query.filterSessions([{ kind: 'id', values: [sessionId] }], signal)
        const found = match(rows)
        if (found === undefined) return destinationAbsent(this.now)
        value = isCallable(query.readSession) ? await query.readSession(sessionId) : found
      } else if (isCallable(query.listSessions)) {
        const rows = await query.listSessions(signal)
        const found = match(rows)
        if (found === undefined) return destinationAbsent(this.now)
        value = isCallable(query.readSession) ? await query.readSession(sessionId) : found
      } else if (isCallable(query.list)) {
        const rows = await query.list()
        const found = match(rows)
        if (found === undefined) return destinationAbsent(this.now)
        value = isCallable(query.readSession) ? await query.readSession(sessionId) : found
      } else if (isCallable(query.inspect)) value = await query.inspect(sessionId, signal)
      else if (isCallable(query.readSession)) value = await query.readSession(sessionId)
      else if (isCallable(query.get)) value = await query.get(sessionId)
      else if (isCallable(query.find)) value = await query.find(sessionId)
      else if (isCallable(query.has)) value = await query.has(sessionId)
      else if (isCallable(query.exists)) value = await query.exists(sessionId)
      else return destinationUnknown(this.now, 'query-unavailable')
      return verifiedFromObservation(value, expectation, this.now, 'session-query')
    } catch {
      return destinationUnknown(this.now, 'query-failed')
    }
  }

  private async indexGet(key: string, signal: AbortSignal): Promise<ImportRecordRead | undefined> {
    abortIfNeeded(signal)
    try {
      return await this.options.index.get(key, signal)
    } catch (error) {
      if (error instanceof HandoffError) throw error
      throw new HandoffError({
        code: 'DSH_INCOMPATIBLE',
        message: 'The import ledger could not be read safely.',
        recoverable: true,
        cause: error,
      })
    }
  }

  private async indexList(signal: AbortSignal): Promise<readonly ImportRecordRead[]> {
    abortIfNeeded(signal)
    try {
      return await this.options.index.list(signal)
    } catch (error) {
      if (error instanceof HandoffError) throw error
      throw new HandoffError({
        code: 'DSH_INCOMPATIBLE',
        message: 'The import ledger could not be read safely.',
        recoverable: true,
        cause: error,
      })
    }
  }

  private async persist(next: ImportRecord, expected: ImportRecordRead | undefined, signal: AbortSignal): Promise<ImportRecord> {
    abortIfNeeded(signal)
    try {
      await this.options.index.put(next, expected, signal)
      return next
    } catch (error) {
      throw new HandoffError({
        code: 'IMPORT_ID_CONFLICT',
        message: 'The import index changed concurrently; retry the handoff.',
        recoverable: true,
        details: { phase: 'index-commit' },
        cause: error,
      })
    }
  }

  private async toPrepared(record: ImportRecord, signal: AbortSignal): Promise<Extract<ImportRecord, { state: 'prepared' }>> {
    const common = this.commonRecordFields(record)
    return await this.persist(ImportRecordSchema.parse({ ...common, state: 'prepared', updatedAt: nowIso(this.now) }), record, signal) as Extract<ImportRecord, { state: 'prepared' }>
  }

  private async toCreating(record: Extract<ImportRecord, { state: 'prepared' }>, signal: AbortSignal): Promise<Extract<ImportRecord, { state: 'creating' }>> {
    return await this.persist(ImportRecordSchema.parse({ ...record, state: 'creating', createStartedAt: nowIso(this.now), updatedAt: nowIso(this.now) }), record, signal) as Extract<ImportRecord, { state: 'creating' }>
  }

  private async toCreated(record: Extract<ImportRecord, { state: 'creating' }>, destination: Extract<DestinationCheck, { status: 'verified' }>, sourceFingerprintAfter: string, signal: AbortSignal): Promise<Extract<ImportRecord, { state: 'created' }>> {
    const recovery = compactRecoveryIntent(record.recovery)
    return await this.persist(ImportRecordSchema.parse({
      ...record,
      state: 'created',
      sourceFingerprintAfter,
      destination,
      updatedAt: nowIso(this.now),
      ...(recovery === undefined ? {} : { recovery }),
    }), record, signal) as Extract<ImportRecord, { state: 'created' }>
  }

  private async toCreatedFromOrphaned(record: Extract<ImportRecord, { state: 'orphaned' }>, destination: Extract<DestinationCheck, { status: 'verified' }>, sourceFingerprintAfter: string, signal: AbortSignal): Promise<Extract<ImportRecord, { state: 'created' }>> {
    const recovery = compactRecoveryIntent(record.recovery)
    return await this.persist(ImportRecordSchema.parse({
      ...this.commonRecordFields(record),
      state: 'created',
      // destination-verify proves Agent.create ran even for older rows that
      // dropped createStartedAt while becoming orphaned.
      createStartedAt: record.createStartedAt ?? record.createdAt,
      sourceFingerprintAfter,
      destination,
      updatedAt: nowIso(this.now),
      ...(recovery === undefined ? {} : { recovery }),
    }), record, signal) as Extract<ImportRecord, { state: 'created' }>
  }

  private async toWorkspaceAttached(record: CreatedRecord, signal: AbortSignal): Promise<CreatedRecord> {
    const { recovery: _recovery, ...withoutRecovery } = record
    return await this.persist(ImportRecordSchema.parse({
      ...withoutRecovery,
      state: 'created',
      workspaceAttachedAt: nowIso(this.now),
      updatedAt: nowIso(this.now),
    }), record, signal) as CreatedRecord
  }

  private async toCreatedFromUnattached(record: CreatedUnattachedRecord, destination: Extract<DestinationCheck, { status: 'verified' }>, sourceFingerprintAfter: string, signal: AbortSignal): Promise<CreatedRecord> {
    const { recovery: _recovery, ...common } = this.commonRecordFields(record)
    return await this.persist(ImportRecordSchema.parse({
      ...common,
      state: 'created',
      createStartedAt: record.createStartedAt,
      sourceFingerprintAfter,
      workspaceAttachedAt: nowIso(this.now),
      destination,
      updatedAt: nowIso(this.now),
    }), record, signal) as CreatedRecord
  }

  private async toCreatedUnattached(record: Extract<ImportRecord, { state: 'created' }>, destination: Extract<DestinationCheck, { status: 'verified' }>, code: string, signal: AbortSignal): Promise<Extract<ImportRecord, { state: 'created_unattached' }>> {
    return await this.persist(ImportRecordSchema.parse({ ...record, state: 'created_unattached', destination, failure: importFailure('workspace-attach', code, this.now, true), updatedAt: nowIso(this.now) }), record, signal) as Extract<ImportRecord, { state: 'created_unattached' }>
  }

  private async toFailed(record: Extract<ImportRecord, { state: 'creating' }>, destination: Extract<DestinationCheck, { status: 'absent' }>, code: string, phase: ImportFailure['phase'], signal: AbortSignal): Promise<Extract<ImportRecord, { state: 'failed' }>> {
    return await this.persist(ImportRecordSchema.parse({ ...record, state: 'failed', destination, failure: importFailure(phase, code, this.now, true), updatedAt: nowIso(this.now) }), record, signal) as Extract<ImportRecord, { state: 'failed' }>
  }

  private async toOrphaned(record: ImportRecord, destination: DestinationCheck, code: string, phase: ImportFailure['phase'], signal: AbortSignal): Promise<Extract<ImportRecord, { state: 'orphaned' }>> {
    const common = this.commonRecordFields(record)
    return await this.persist(ImportRecordSchema.parse({
      ...common,
      state: 'orphaned',
      destination,
      failure: importFailure(phase, code, this.now, true),
      updatedAt: nowIso(this.now),
      ...('createStartedAt' in record && record.createStartedAt !== undefined ? { createStartedAt: record.createStartedAt } : {}),
      ...('sourceFingerprintAfter' in record && record.sourceFingerprintAfter !== undefined ? { sourceFingerprintAfter: record.sourceFingerprintAfter } : {}),
    }), record, signal) as Extract<ImportRecord, { state: 'orphaned' }>
  }

  private commonRecordFields(record: ImportRecord): {
    schemaVersion: 2
    key: string
    sourceSessionId: string
    sourceRolloutRevisionId: string
    sourceFingerprint: string
    mode: 'smart' | 'full'
    cwd: string
    destinationSessionId: string
    sourceFingerprintBefore: string
    attemptId: string
    createdAt: string
    recovery?: ImportRecoveryIntent
  } {
    return {
      schemaVersion: 2,
      key: record.key,
      sourceSessionId: record.sourceSessionId,
      sourceRolloutRevisionId: record.sourceRolloutRevisionId,
      sourceFingerprint: record.sourceFingerprint,
      mode: record.mode,
      cwd: record.cwd,
      destinationSessionId: record.destinationSessionId,
      sourceFingerprintBefore: record.sourceFingerprintBefore,
      attemptId: record.attemptId,
      createdAt: record.createdAt,
      ...(record.recovery === undefined ? {} : { recovery: record.recovery }),
    }
  }

  private destinationFailure(destination: DestinationCheck): HandoffError {
    return new HandoffError({
      code: destination.status === 'conflict' ? 'IMPORT_ID_CONFLICT' : 'SESSION_NOT_VISIBLE',
      message: destination.status === 'conflict' ? 'The DSH destination identity is in conflict.' : 'The DSH destination could not be verified safely.',
      recoverable: destination.status !== 'conflict',
    })
  }

  private failureCode(error: unknown): string {
    return error instanceof HandoffError ? error.code : 'DSH_SEED_INVALID'
  }

  private async migrateLegacy(record: ImportRecordRead, signal: AbortSignal): Promise<ImportRecord> {
    if (isV2Record(record)) return record
    const check = await this.inspectDestination(record.destinationSessionId, this.expectation(record), signal)
    const fingerprint = await this.readLegacyFingerprint(record, signal)
    if (fingerprint === undefined) {
      const unknown = destinationUnknown(this.now, 'metadata-missing')
      return await this.persist(ImportRecordSchema.parse({ ...record, schemaVersion: 2, state: 'orphaned', destination: unknown, failure: importFailure('source-before-create', 'SOURCE_FINGERPRINT_UNAVAILABLE', this.now, true) }), record, signal)
    }
    if (fingerprint !== record.sourceFingerprint) {
      return await this.persist(ImportRecordSchema.parse({ ...record, schemaVersion: 2, state: 'orphaned', destination: check, failure: importFailure('source-before-create', 'SOURCE_CHANGED', this.now, true) }), record, signal)
    }
    if (check.status === 'verified') {
      return await this.persist(ImportRecordSchema.parse({ ...record, schemaVersion: 2, state: 'created', createStartedAt: record.updatedAt, sourceFingerprintAfter: fingerprint, destination: check }), record, signal)
    }
    if (check.status === 'absent' && (record.state === 'prepared' || record.state === 'creating')) {
      const { state: _state, sourceFingerprintAfter: _after, ...common } = record
      return await this.persist(ImportRecordSchema.parse({ ...common, schemaVersion: 2, state: 'prepared' }), record, signal)
    }
    const { state: _state, sourceFingerprintAfter: _after, ...common } = record
    return await this.persist(ImportRecordSchema.parse({ ...common, schemaVersion: 2, state: 'orphaned', destination: check, failure: importFailure('destination-query', check.status === 'conflict' ? 'IMPORT_ID_CONFLICT' : 'SESSION_NOT_VISIBLE', this.now, true) }), record, signal)
  }

  private async readLegacyFingerprint(record: ImportRecordRead, signal: AbortSignal): Promise<string | undefined> {
    abortIfNeeded(signal)
    if (this.options.fingerprintRecord === undefined) return undefined
    try {
      const fingerprint = await this.options.fingerprintRecord(record, signal)
      abortIfNeeded(signal)
      return typeof fingerprint === 'string' && fingerprint.length > 0 ? fingerprint : undefined
    } catch {
      return undefined
    }
  }

  private async migrateLegacyForRequest(record: ImportRecordRead, request: PreparedImport, check: DestinationCheck, signal: AbortSignal): Promise<ImportRecord> {
    if (isV2Record(record)) return record
    if (
      record.sourceSessionId !== request.source.sessionId
      || record.sourceRolloutRevisionId !== request.source.rolloutRevisionId
      || record.sourceFingerprint !== request.sourceFingerprint
      || record.mode !== request.mode
      || record.cwd !== request.cwd
    ) {
      const conflict = destinationConflict(this.now, 'source-mismatch')
      return await this.persist(ImportRecordSchema.parse({
        ...record,
        schemaVersion: 2,
        state: 'orphaned',
        destination: conflict,
        failure: importFailure('destination-query', 'IMPORT_ID_CONFLICT', this.now, true),
      }), record, signal)
    }
    const fingerprint = await this.readFingerprint(request, signal)
    this.assertFingerprint(request, fingerprint)
    if (check.status === 'verified' && (record.state === 'created' || record.state === 'created_unattached')) {
      const created = ImportRecordSchema.parse({ ...record, schemaVersion: 2, state: 'created', createStartedAt: record.updatedAt, sourceFingerprintAfter: fingerprint, destination: check })
      return await this.persist(created, record, signal)
    }
    if (check.status === 'absent' && (record.state === 'prepared' || record.state === 'creating')) {
      const { state: _state, sourceFingerprintAfter: _after, ...common } = record
      return await this.persist(ImportRecordSchema.parse({ ...common, schemaVersion: 2, state: 'prepared' }), record, signal)
    }
    const { state: _state, sourceFingerprintAfter: _after, ...common } = record
    return await this.persist(ImportRecordSchema.parse({ ...common, schemaVersion: 2, state: 'orphaned', destination: check, failure: importFailure('destination-query', check.status === 'conflict' ? 'IMPORT_ID_CONFLICT' : 'SESSION_NOT_VISIBLE', this.now, true) }), record, signal)
  }

  private async attachWorkspace(cwd: string, sessionId: string, title?: string): Promise<void> {
    const registry = this.runtime.workspaceRegistry
    if (registry === undefined) throw new Error('workspace registry unavailable')
    let workspace = await registry.resolveByPath?.(cwd)
    if (workspace === undefined) {
      if (registry.create === undefined) throw new Error('workspace creation unavailable')
      workspace = await registry.create(cwd, title)
    }
    if (workspace.attachSession !== undefined) {
      await workspace.attachSession(sessionId)
      return
    }
    if (registry.attachSession !== undefined) {
      await registry.attachSession(sessionId, cwd)
      return
    }
    throw new Error('workspace attach unavailable')
  }

  /** Finish the durable destination -> workspace attachment saga. */
  private async finalizeRequestAttachment(
    request: PreparedImport,
    record: CreatedRecord | CreatedUnattachedRecord,
    destination: Extract<DestinationCheck, { status: 'verified' }>,
    sourceFingerprintAfter: string,
    signal: AbortSignal,
    outcomeState: 'created' | 'existing',
    durableIdentityRequired = true,
  ): Promise<CreateOutcome> {
    try {
      if (durableIdentityRequired) await this.assertRecordCwdIdentity(record, signal)
      await this.assertCwdIdentity(request, signal)
      await this.attachWorkspace(record.cwd, record.destinationSessionId, request.title)
    } catch (error) {
      if (error instanceof HandoffError && error.code === 'CWD_NOT_FOUND') throw error
      abortIfNeeded(signal)
      const unattached = record.state === 'created'
        ? await this.toCreatedUnattached(record, destination, 'WORKSPACE_ATTACH_FAILED', signal)
        : record
      return this.outcome('created_unattached', unattached.destinationSessionId, false, [
        diagnostic('WORKSPACE_ATTACH_FAILED', 'The DSH session exists, but its workspace could not be attached.'),
      ])
    }
    // Attachment is a second durable saga step. If this marker commit crashes,
    // the created row remains recoverable and startup will idempotently attach
    // again without creating another Agent destination.
    if (record.state === 'created') {
      await this.toWorkspaceAttached(record, signal)
    } else {
      await this.toCreatedFromUnattached(record, destination, sourceFingerprintAfter, signal)
    }
    return this.outcome(outcomeState, record.destinationSessionId, true, [])
  }

  private outcome(state: 'created' | 'existing' | 'created_unattached', sessionId: string, workspaceAttached: boolean, warnings: readonly Diagnostic[]): CreateOutcome {
    return CreateOutcomeSchema.parse({
      state,
      sessionId,
      workspaceAttached,
      warnings: [...warnings],
    })
  }
}

/** Namespace marker exported for storage-domain adapters without coupling to DSH internals. */
export const IMPORT_INDEX_NAMESPACE = INDEX_NAMESPACE
