import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import { createZstdDecompress } from 'node:zlib'
import { Transform } from 'node:stream'
import { utf8ByteLength, DEFAULT_LIMITS, HARD_LIMITS } from '../shared/limits.js'
import { HandoffError } from '../shared/errors.js'
import type {
  Diagnostic,
  LifecyclePayload,
  NormalizedEvent,
  NormalizedSession,
  ParseLimits,
  SourceRef,
} from '../shared/types.js'

export interface RolloutParserOptions {
  readonly revisionId?: string
  readonly representation?: 'jsonl' | 'jsonl.zst'
  readonly archived?: boolean
  readonly limits?: Partial<ParseLimits>
  readonly signal?: AbortSignal
  readonly filePath?: string
  /** Resolver uses raw records and performs pairing only after history merge. */
  readonly normalize?: boolean
  /** Internal file-reader mode: stop a compressed stream at its byte/record cap. */
  readonly stopOnLimit?: boolean
}

export type RolloutInput = AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string> | Uint8Array | string

export interface RolloutRecord {
  readonly envelope: Record<string, unknown>
  readonly line: number
  readonly revisionId?: string
  readonly chainOrder?: number
  readonly ordinal?: number
  readonly type?: string
}

export interface RolloutMetadata {
  readonly id: string
  readonly cwd?: string
  readonly timestamp?: string
  readonly cliVersion?: string
  readonly source?: string
  readonly provider?: string
  readonly model?: string
  readonly historyBase?: HistoryBaseRef
  readonly fork?: Record<string, unknown>
}

export interface HistoryBaseRef {
  readonly rolloutId: string
  readonly endOrdinalExclusive?: number
  readonly threadId?: string
}

export interface ParsedRollout {
  readonly revisionId: string
  readonly representation: 'jsonl' | 'jsonl.zst'
  readonly archived: boolean
  readonly metadata?: RolloutMetadata
  readonly records: readonly RolloutRecord[]
  readonly timeline: readonly NormalizedEvent[]
  readonly diagnostics: readonly Diagnostic[]
  readonly completeness: NormalizedSession['completeness']
  readonly health: 'complete' | 'partial' | 'corrupt' | 'unsupported'
  readonly byteSize: number
  /** Bytes consumed after decompression; used for aggregate chain limits. */
  readonly decompressedBytes?: number
  readonly fingerprint?: string
  readonly updatedAt?: string
}

export interface EffectiveLimits extends ParseLimits {
  readonly [key: string]: number
}

const defaultLimits: EffectiveLimits = { ...DEFAULT_LIMITS }

export function effectiveParseLimits(patch: Partial<ParseLimits> | undefined): EffectiveLimits {
  const output = { ...defaultLimits }
  if (patch === undefined) return output
  for (const key of Object.keys(defaultLimits) as Array<keyof ParseLimits>) {
    const value = patch[key]
    if (value !== undefined && Number.isSafeInteger(value) && value > 0) {
      output[key] = Math.min(value, HARD_LIMITS[key])
    }
  }
  return output
}

const limitsOf = effectiveParseLimits

function diagnostic(code: string, message: string, recoverable: boolean, record?: { line?: number | undefined; ordinal?: number | undefined; type?: string | undefined }): Diagnostic {
  const normalizedRecord = record === undefined ? undefined : {
    ...(record.line === undefined ? {} : { line: record.line }),
    ...(record.ordinal === undefined ? {} : { ordinal: record.ordinal }),
    ...(record.type === undefined ? {} : { type: record.type }),
  }
  const candidate = {
    code,
    severity: code === 'CODEX_METADATA_MISSING' || code === 'CODEX_FORMAT_UNSUPPORTED' ? 'error' as const : 'warning' as const,
    message: message.slice(0, HARD_LIMITS.diagnosticMessageChars),
    ...(normalizedRecord === undefined ? {} : { record: normalizedRecord }),
    recoverable,
  }
  return candidate
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function isoTimestamp(value: unknown): string | undefined {
  const text = stringValue(value)
  if (text === undefined || !Number.isFinite(Date.parse(text))) return undefined
  return new Date(text).toISOString()
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function canonicalType(value: unknown): string | undefined {
  const text = stringValue(value)
  return text === undefined ? undefined : text
}

function parseHistoryBase(value: unknown): HistoryBaseRef | undefined {
  if (typeof value === 'string' && value.length > 0) return { rolloutId: value }
  const object = objectValue(value)
  if (object === undefined) return undefined
  const nested = objectValue(object.history_base) ?? objectValue(object.historyBase) ?? object
  const rolloutId = stringValue(nested.rollout_id) ?? stringValue(nested.rolloutId) ?? stringValue(nested.thread_id) ?? stringValue(nested.threadId)
  if (rolloutId === undefined || rolloutId.length === 0) return undefined
  const cutoff = numberValue(nested.end_ordinal_exclusive) ?? numberValue(nested.endOrdinalExclusive) ?? numberValue(nested.end_ordinal)
  return { rolloutId, ...(cutoff === undefined ? {} : { endOrdinalExclusive: cutoff }), ...(stringValue(nested.thread_id) === undefined ? {} : { threadId: nested.thread_id as string }) }
}

function metadataFromEnvelope(envelope: Record<string, unknown>): RolloutMetadata | undefined {
  const type = stringValue(envelope.type)
  if (type !== 'session_meta' && type !== 'sessionMeta' && type !== 'session-meta') return undefined
  const payload = objectValue(envelope.payload) ?? objectValue(envelope.meta) ?? envelope
  const id = stringValue(payload.id) ?? stringValue(payload.session_id) ?? stringValue(payload.sessionId) ?? stringValue(payload.thread_id) ?? stringValue(payload.threadId)
  if (id === undefined || id.length === 0) return undefined
  const historyBase = parseHistoryBase(payload.history_base ?? payload.historyBase)
  const fork = objectValue(payload.fork) ?? objectValue(payload.fork_metadata)
  const envelopeTimestamp = isoTimestamp(envelope.timestamp)
  return {
    id,
    ...(stringValue(payload.cwd) === undefined ? {} : { cwd: payload.cwd as string }),
    ...(isoTimestamp(payload.timestamp) ?? envelopeTimestamp ? { timestamp: (isoTimestamp(payload.timestamp) ?? envelopeTimestamp) as string } : {}),
    ...(stringValue(payload.cli_version) ?? stringValue(payload.cliVersion) ? { cliVersion: (stringValue(payload.cli_version) ?? stringValue(payload.cliVersion)) as string } : {}),
    ...(stringValue(payload.source) === undefined ? {} : { source: payload.source as string }),
    ...(stringValue(payload.provider) === undefined ? {} : { provider: payload.provider as string }),
    ...(stringValue(payload.model) ?? stringValue(payload.model_name) ? { model: (stringValue(payload.model) ?? stringValue(payload.model_name)) as string } : {}),
    ...(historyBase === undefined ? {} : { historyBase }),
    ...(fork === undefined ? {} : { fork }),
  }
}

function sourceRef(revisionId: string, line: number, ordinal: number | undefined, type: string | undefined): SourceRef {
  return {
    locator: `${revisionId}:${ordinal ?? line}`.slice(0, 512),
    line,
    ...(ordinal === undefined ? {} : { ordinal }),
    ...(type === undefined ? {} : { type: type.slice(0, 128) }),
  }
}

function eventId(kind: string, revisionId: string, line: number, suffix = ''): string {
  return `${kind}-${createHash('sha256').update(`${revisionId}\0${line}\0${suffix}`).digest('hex').slice(0, 24)}`
}

function boundedText(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (utf8ByteLength(value) <= maxBytes) return { text: value, truncated: false }
  // Slice by code points so a UTF-8 boundary can never be cut in the middle.
  let text = ''
  let bytes = 0
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    const characterBytes = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
    if (bytes + characterBytes > Math.max(0, maxBytes - 32)) break
    text += character
    bytes += characterBytes
  }
  return { text: `${text} …[truncated]`, truncated: true }
}

/** Truncate text by UTF-8 bytes without splitting a code point. */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (utf8ByteLength(value) <= maxBytes) return value
  let text = ''
  let bytes = 0
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    const characterBytes = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
    if (bytes + characterBytes > maxBytes) break
    text += character
    bytes += characterBytes
  }
  return text
}

function contentText(value: unknown, encrypted: { value: boolean }): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(item => contentText(item, encrypted)).filter(Boolean).join('\n')
  const object = objectValue(value)
  if (object === undefined) return ''
  const type = stringValue(object.type) ?? ''
  if (type === 'encrypted_content' || type === 'encrypted' || object.encrypted_content !== undefined) {
    encrypted.value = true
    return ''
  }
  const direct = stringValue(object.text) ?? stringValue(object.content) ?? stringValue(object.value) ?? stringValue(object.stdout) ?? stringValue(object.stderr) ?? stringValue(object.refusal)
  if (direct !== undefined) return direct
  const nested = object.parts ?? object.content ?? object.summary ?? object.output_text
  if (nested !== undefined) return contentText(nested, encrypted)
  try { return JSON.stringify(object) } catch { return '' }
}

function responsePayload(record: RolloutRecord): Record<string, unknown> | undefined {
  const outer = objectValue(record.envelope.payload) ?? record.envelope
  if (stringValue(record.envelope.type) === 'response_item' || stringValue(record.envelope.type) === 'responseItem') return outer
  return undefined
}

export interface RawCandidate {
  readonly kind: 'message' | 'reasoning-summary' | 'tool-call' | 'tool-result' | 'compacted' | 'unsupported'
  readonly line: number
  readonly revisionId?: string
  readonly chainOrder?: number
  readonly ordinal?: number
  readonly at?: string
  readonly role?: 'user' | 'assistant' | 'system'
  readonly phase?: 'commentary' | 'final_answer'
  readonly text?: string
  readonly callId?: string
  readonly name?: string
  readonly argumentsText?: string
  readonly failed?: boolean
  readonly type?: string
}

type EventWithoutOrder = {
  [Kind in NormalizedEvent['kind']]: Omit<Extract<NormalizedEvent, { kind: Kind }>, 'order'>
}[NormalizedEvent['kind']]

export function candidatesFor(record: RolloutRecord, encrypted: { value: boolean }): RawCandidate[] {
  const payload = responsePayload(record)
  const topType = stringValue(record.envelope.type)
  const at = isoTimestamp(record.envelope.timestamp)
  const base = { line: record.line, ...(record.revisionId === undefined ? {} : { revisionId: record.revisionId }), ...(record.chainOrder === undefined ? {} : { chainOrder: record.chainOrder }), ...(record.ordinal === undefined ? {} : { ordinal: record.ordinal }), ...(at === undefined ? {} : { at }), ...(record.type === undefined ? {} : { type: record.type }) }
  if (payload === undefined) {
    if (topType === 'compacted' || topType === 'compaction') {
      const item = objectValue(record.envelope.payload) ?? record.envelope
      const text = contentText(item.summary ?? item.message ?? item.content, encrypted)
      return text === '' ? [] : [{ ...base, kind: 'compacted', text }]
    }
    return []
  }
  const type = stringValue(payload.type) ?? ''
  if (type === 'message') {
    const roleValue = stringValue(payload.role)
    const role = roleValue === 'user' ? 'user' : roleValue === 'developer' || roleValue === 'system' ? 'system' : roleValue === 'assistant' ? 'assistant' : undefined
    if (role === undefined) return [{ ...base, kind: 'unsupported' }]
    const text = contentText(payload.content ?? payload.blocks ?? payload.message, encrypted)
    const phaseValue = stringValue(payload.phase)
    const phase = phaseValue === 'commentary' || phaseValue === 'final_answer' ? phaseValue : undefined
    return text === '' ? [] : [{ ...base, kind: 'message', role, text, ...(phase === undefined ? {} : { phase }) }]
  }
  if (type === 'reasoning') {
    const text = contentText(payload.summary ?? payload.content ?? payload.text, encrypted)
    return text === '' ? [] : [{ ...base, kind: 'reasoning-summary', text }]
  }
  const call = type === 'function_call' || type === 'custom_tool_call' || type === 'local_shell_call' || type === 'tool_call' || type === 'tool_use'
  if (call) {
    const callId = stringValue(payload.call_id) ?? stringValue(payload.callId) ?? stringValue(payload.id)
    const name = stringValue(payload.name) ?? stringValue(payload.tool_name) ?? (type === 'local_shell_call' ? 'local-shell' : type)
    if (callId === undefined) return [{ ...base, kind: 'unsupported' }]
    const args = payload.arguments
    const action = payload.command ?? payload.action ?? payload.input ?? {}
    const argumentsText = typeof args === 'string' ? args : args === undefined ? (typeof action === 'string' ? action : JSON.stringify(action)) : JSON.stringify(args)
    return [{ ...base, kind: 'tool-call', callId, name, argumentsText: argumentsText ?? '' }]
  }
  const result = type === 'function_call_output' || type === 'custom_tool_call_output' || type === 'local_shell_call_output' || type === 'tool_result' || type === 'tool_output'
  if (result) {
    const callId = stringValue(payload.call_id) ?? stringValue(payload.callId) ?? stringValue(payload.id)
    if (callId === undefined) return [{ ...base, kind: 'unsupported' }]
    const output = contentText(payload.output ?? payload.content ?? payload.result, encrypted)
    const status = stringValue(payload.status) ?? stringValue(payload.error)
    const failed = payload.is_error === true || payload.isError === true || payload.error !== undefined || (status !== undefined && status !== 'completed' && status !== 'success')
    const name = stringValue(payload.name)
    return [{ ...base, kind: 'tool-result', callId, ...(name === undefined ? {} : { name }), text: output, failed }]
  }
  if (type === 'compacted' || type === 'compaction') {
    const text = contentText(payload.summary ?? payload.content ?? payload.message, encrypted)
    return text === '' ? [] : [{ ...base, kind: 'compacted', text }]
  }
  return [{ ...base, kind: 'unsupported' }]
}

async function* chunksFrom(input: AsyncIterable<Uint8Array | string>, signal?: AbortSignal): AsyncGenerator<Uint8Array | string> {
  for await (const chunk of input) {
    if (signal?.aborted) throw new HandoffError({ code: 'CANCELLED', message: 'The operation was cancelled.', recoverable: true })
    yield chunk
  }
}

/** Parse a UTF-8 JSONL stream without materialising the whole source. */
async function asChunks(input: RolloutInput): Promise<AsyncIterable<Uint8Array | string>> {
  if (typeof input === 'string' || input instanceof Uint8Array) {
    return (async function* (): AsyncGenerator<Uint8Array | string> { yield input })()
  }
  if (Symbol.asyncIterator in Object(input)) {
    return input as AsyncIterable<Uint8Array | string>
  }
  return (async function* (): AsyncGenerator<Uint8Array | string> {
    yield* input as Iterable<Uint8Array | string>
  })()
}

export async function parseRollout(input: RolloutInput, options: RolloutParserOptions = {}): Promise<ParsedRollout> {
  const limits = limitsOf(options.limits)
  const revisionId = options.revisionId ?? 'rollout'
  const representation = options.representation ?? 'jsonl'
  const records: RolloutRecord[] = []
  const candidates: RawCandidate[] = []
  const diagnostics: Diagnostic[] = []
  const addDiagnostic = (item: Diagnostic): void => {
    if (diagnostics.length < HARD_LIMITS.diagnostics) diagnostics.push(item)
    else completeness.truncatedRecords += 1
  }
  const completeness = { malformedLines: 0, unknownRecords: 0, droppedEncryptedBlocks: 0, danglingToolCalls: 0, orphanToolResults: 0, truncatedRecords: 0 }
  const decoder = new TextDecoder('utf-8', { fatal: false })
  let pending = ''
  let line = 0
  let bytes = 0
  let overlong = false
  let inputStopped = false
  let metadata: RolloutMetadata | undefined
  let updatedAt: string | undefined
  const sourceInput = await asChunks(input)
  const stopInput = (): void => {
    const destroyable = sourceInput as AsyncIterable<Uint8Array | string> & { destroy?: () => void }
    try { destroyable.destroy?.() } catch { /* bounded stream cleanup */ }
  }
  chunkLoop: for await (const chunk of chunksFrom(sourceInput, options.signal)) {
    const part = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    bytes += typeof chunk === 'string' ? utf8ByteLength(chunk) : chunk.byteLength
    // Once a bounded parser limit is reached, keep draining the source.  This
    // is important for file readers whose hash transform must observe the
    // same complete descriptor snapshot as the parser.
    if (inputStopped) continue
    if (bytes > limits.sourceFileBytes) {
      addDiagnostic(diagnostic('CODEX_LIMIT_EXCEEDED', 'Rollout input exceeded the configured file limit.', true))
      completeness.truncatedRecords += 1
      inputStopped = true
      if (options.stopOnLimit === true) {
        stopInput()
        break chunkLoop
      }
      continue
    }
    pending += part
    while (true) {
      const newline = pending.indexOf('\n')
      if (newline < 0) {
        if (utf8ByteLength(pending) > limits.lineBytes) {
          overlong = true
          // Do not retain an unterminated attacker-controlled line.  The
          // next newline is enough to emit one bounded diagnostic and resume
          // parsing subsequent records.
          pending = ''
        }
        break
      }
      const rawLine = pending.slice(0, newline).replace(/\r$/, '')
      pending = pending.slice(newline + 1)
      line += 1
      if (overlong || utf8ByteLength(rawLine) > limits.lineBytes) {
        addDiagnostic(diagnostic('CODEX_LIMIT_EXCEEDED', 'A rollout record exceeded the line limit and was skipped.', true, { line }))
        completeness.truncatedRecords += 1
        overlong = false
        continue
      }
      if (rawLine.trim() === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(rawLine)
      } catch {
        completeness.malformedLines += 1
        addDiagnostic(diagnostic('CODEX_PARTIAL_PARSE', 'A malformed rollout record was skipped.', true, { line }))
        continue
      }
      const envelope = objectValue(parsed)
      if (envelope === undefined) {
        completeness.malformedLines += 1
        addDiagnostic(diagnostic('CODEX_PARTIAL_PARSE', 'A rollout record was not a JSON object.', true, { line }))
        continue
      }
      const ordinal = numberValue(envelope.ordinal)
      const type = canonicalType(envelope.type)
      const record: RolloutRecord = { envelope, line, revisionId, ...(ordinal === undefined ? {} : { ordinal }), ...(type === undefined ? {} : { type }) }
      if (records.length >= limits.records) {
        addDiagnostic(diagnostic('CODEX_LIMIT_EXCEEDED', 'The rollout record limit was reached.', true, { line, ordinal, type }))
        completeness.truncatedRecords += 1
        inputStopped = true
        if (options.stopOnLimit === true) {
          stopInput()
          break chunkLoop
        }
        break
      }
      records.push(record)
      const foundMeta = metadataFromEnvelope(envelope)
      if (foundMeta !== undefined) {
        if (metadata === undefined) metadata = foundMeta
        else addDiagnostic(diagnostic('CODEX_PARTIAL_PARSE', 'A later session metadata record was ignored; the first metadata record is canonical.', true, { line, ordinal, type }))
        const metaPayload = objectValue(envelope.payload) ?? envelope
        if ((metaPayload.history_base !== undefined || metaPayload.historyBase !== undefined) && foundMeta.historyBase === undefined) addDiagnostic(diagnostic('CODEX_HISTORY_CORRUPT', 'The session history-base reference is malformed.', false, { line, ordinal, type }))
      }
      updatedAt = isoTimestamp(envelope.timestamp) ?? updatedAt
      const encrypted = { value: false }
      const extracted = candidatesFor(record, encrypted)
      if (encrypted.value) completeness.droppedEncryptedBlocks += 1
      for (const candidate of extracted) candidates.push(candidate)
      if (extracted.some(candidate => candidate.kind === 'unsupported')) {
        completeness.unknownRecords += 1
        addDiagnostic(diagnostic('CODEX_FORMAT_UNSUPPORTED', 'An unsupported rollout response item was skipped.', true, { line, ordinal, type }))
      } else if (topLevelKnown(type) === false) {
        completeness.unknownRecords += 1
        addDiagnostic(diagnostic('CODEX_PARTIAL_PARSE', 'An unknown rollout record was skipped.', true, { line, ordinal, type }))
      }
    }
  }
  pending += decoder.decode()
  if (!inputStopped && pending.trim() !== '' && overlong) {
    line += 1
    completeness.truncatedRecords += 1
    addDiagnostic(diagnostic('CODEX_LIMIT_EXCEEDED', 'A final rollout record exceeded the line limit and was skipped.', true, { line }))
  } else if (!inputStopped && pending.trim() !== '' && records.length <= limits.records) {
    line += 1
    if (utf8ByteLength(pending) > limits.lineBytes) {
      completeness.truncatedRecords += 1
      addDiagnostic(diagnostic('CODEX_LIMIT_EXCEEDED', 'A final rollout record exceeded the line limit and was skipped.', true, { line }))
    } else {
      try {
        const envelope = objectValue(JSON.parse(pending))
        if (envelope !== undefined) {
          const ordinal = numberValue(envelope.ordinal)
          const type = canonicalType(envelope.type)
          if (records.length >= limits.records) {
            addDiagnostic(diagnostic('CODEX_LIMIT_EXCEEDED', 'The rollout record limit was reached.', true, { line, ordinal, type }))
            completeness.truncatedRecords += 1
          } else {
          const record: RolloutRecord = { envelope, line, revisionId, ...(ordinal === undefined ? {} : { ordinal }), ...(type === undefined ? {} : { type }) }
          records.push(record)
          const foundMeta = metadataFromEnvelope(envelope)
          if (foundMeta !== undefined) {
            if (metadata === undefined) metadata = foundMeta
            else addDiagnostic(diagnostic('CODEX_PARTIAL_PARSE', 'A later session metadata record was ignored; the first metadata record is canonical.', true, { line, ordinal, type }))
            const metaPayload = objectValue(envelope.payload) ?? envelope
            if ((metaPayload.history_base !== undefined || metaPayload.historyBase !== undefined) && foundMeta.historyBase === undefined) addDiagnostic(diagnostic('CODEX_HISTORY_CORRUPT', 'The session history-base reference is malformed.', false, { line, ordinal, type }))
          }
          updatedAt = isoTimestamp(envelope.timestamp) ?? updatedAt
          const encrypted = { value: false }
          const extracted = candidatesFor(record, encrypted)
          if (encrypted.value) completeness.droppedEncryptedBlocks += 1
          for (const candidate of extracted) candidates.push(candidate)
          if (extracted.some(candidate => candidate.kind === 'unsupported')) {
            completeness.unknownRecords += 1
            addDiagnostic(diagnostic('CODEX_FORMAT_UNSUPPORTED', 'An unsupported rollout response item was skipped.', true, { line, ordinal, type }))
          } else if (topLevelKnown(type) === false) {
            completeness.unknownRecords += 1
            addDiagnostic(diagnostic('CODEX_PARTIAL_PARSE', 'An unknown rollout record was skipped.', true, { line, ordinal, type }))
          }
          }
        } else {
          completeness.malformedLines += 1
          addDiagnostic(diagnostic('CODEX_PARTIAL_PARSE', 'A rollout record was not a JSON object.', true, { line }))
        }
      } catch {
        completeness.malformedLines += 1
        addDiagnostic(diagnostic('CODEX_PARTIAL_PARSE', 'A malformed final rollout record was skipped.', true, { line }))
      }
    }
  }
  const timeline = options.normalize === false ? [] : normalizeCandidates(candidates, revisionId, limits, diagnostics, completeness)
  const incomplete = completeness.malformedLines + completeness.unknownRecords + completeness.droppedEncryptedBlocks + completeness.danglingToolCalls + completeness.orphanToolResults + completeness.truncatedRecords > 0
  const health = metadata === undefined ? (timeline.length === 0 ? 'corrupt' : 'partial') : diagnostics.some(item => item.code === 'CODEX_HISTORY_CORRUPT') ? 'corrupt' : diagnostics.some(item => item.code === 'CODEX_FORMAT_UNSUPPORTED') ? 'unsupported' : diagnostics.length > 0 || incomplete ? 'partial' : 'complete'
  if (metadata === undefined) addDiagnostic(diagnostic('CODEX_METADATA_MISSING', 'The rollout has no valid session metadata.', false))
  return { revisionId, representation, archived: options.archived ?? false, ...(metadata === undefined ? {} : { metadata }), records, timeline, diagnostics, completeness, health, byteSize: bytes, ...(updatedAt === undefined ? {} : { updatedAt }) }
}

function topLevelKnown(type: string | undefined): boolean {
  return type === 'session_meta' || type === 'sessionMeta' || type === 'session-meta' || type === 'response_item' || type === 'responseItem' || type === 'turn_context' || type === 'event_msg' || type === 'world_state' || type === 'token_usage_record' || type === 'compacted' || type === 'compaction' || type === 'inter_agent_communication_metadata'
}

export function normalizeCandidates(candidates: readonly RawCandidate[], revisionId: string, limits: EffectiveLimits, diagnostics: Diagnostic[], completeness: NormalizedSession['completeness']): NormalizedEvent[] {
  const events: NormalizedEvent[] = []
  const calls = new Map<string, RawCandidate[]>()
  const paired = new Set<RawCandidate>()
  const addDiagnostic = (item: Diagnostic): void => {
    if (diagnostics.length < HARD_LIMITS.diagnostics) diagnostics.push(item)
    else completeness.truncatedRecords += 1
  }
  let order = 0
  const add = (event: EventWithoutOrder): void => {
    if (events.length >= limits.records) {
      completeness.truncatedRecords += 1
      return
    }
    events.push({ ...event, order: order++ } as NormalizedEvent)
  }
  const chronological = [...candidates].sort((left, right) => {
    if (left.chainOrder !== undefined && right.chainOrder !== undefined && left.chainOrder !== right.chainOrder) return left.chainOrder - right.chainOrder
    if (left.ordinal !== undefined && right.ordinal !== undefined && left.ordinal !== right.ordinal) return left.ordinal - right.ordinal
    return left.line - right.line
  })
  for (const candidate of chronological) {
    const candidateRevisionId = candidate.revisionId ?? revisionId
    const ref = sourceRef(candidateRevisionId, candidate.line, candidate.ordinal, candidate.type)
    if (candidate.kind === 'tool-call' && candidate.callId !== undefined) {
      const queue = calls.get(candidate.callId) ?? []
      queue.push(candidate)
      calls.set(candidate.callId, queue)
      const bounded = boundedText(candidate.argumentsText ?? '', limits.normalizedTextBytes)
      if (bounded.truncated) completeness.truncatedRecords += 1
      add({ kind: 'tool-call', id: eventId('call', candidateRevisionId, candidate.line, candidate.callId), callId: candidate.callId, name: candidate.name ?? 'tool', argumentsText: bounded.text, ...(candidate.at === undefined ? {} : { at: candidate.at }), source: ref })
      continue
    }
    if (candidate.kind === 'tool-result' && candidate.callId !== undefined) {
      const queue = calls.get(candidate.callId)
      const call = queue?.find(item => !paired.has(item))
      if (call === undefined) {
        completeness.orphanToolResults += 1
        addDiagnostic(diagnostic('CODEX_PARTIAL_PARSE', 'A tool result without a matching call was omitted.', true, { line: candidate.line, ordinal: candidate.ordinal, type: candidate.type }))
        continue
      }
      paired.add(call)
      const bounded = boundedText(candidate.text ?? '', limits.normalizedToolResultBytes)
      if (bounded.truncated) completeness.truncatedRecords += 1
      add({ kind: 'tool-result', id: eventId('result', candidateRevisionId, candidate.line, candidate.callId), callId: candidate.callId, ...(candidate.name === undefined ? {} : { name: candidate.name }), content: bounded.text, ...(candidate.failed === undefined ? {} : { failed: candidate.failed }), ...(candidate.at === undefined ? {} : { at: candidate.at }), source: ref })
      continue
    }
    if (candidate.kind === 'message' && candidate.role !== undefined) {
      const bounded = boundedText(candidate.text ?? '', limits.normalizedTextBytes)
      if (bounded.truncated) completeness.truncatedRecords += 1
      const phase = candidate.phase ?? (candidate.role === 'assistant' ? inferPhase(candidate.text ?? '') : undefined)
      add({ kind: 'message', id: eventId('message', candidateRevisionId, candidate.line), role: candidate.role, text: bounded.text, ...(phase === undefined ? {} : { phase }), ...(candidate.at === undefined ? {} : { at: candidate.at }), source: ref })
    } else if (candidate.kind === 'reasoning-summary' || candidate.kind === 'compacted') {
      const bounded = boundedText(candidate.text ?? '', limits.normalizedTextBytes)
      if (bounded.truncated) completeness.truncatedRecords += 1
      if (candidate.kind === 'compacted') add({ kind: 'compacted', id: eventId('compacted', candidateRevisionId, candidate.line), summary: bounded.text, ...(candidate.at === undefined ? {} : { at: candidate.at }), source: ref })
      else add({ kind: 'reasoning-summary', id: eventId('reasoning', candidateRevisionId, candidate.line), text: bounded.text, ...(candidate.at === undefined ? {} : { at: candidate.at }), source: ref })
    }
  }
  for (const [callId, queue] of calls) {
    for (const call of queue) {
      if (paired.has(call)) continue
      completeness.danglingToolCalls += 1
      addDiagnostic(diagnostic('CODEX_PARTIAL_PARSE', 'A historical tool call had no recorded result and was downgraded to text.', true, { line: call.line, ordinal: call.ordinal, type: call.type }))
      const callRevisionId = call.revisionId ?? revisionId
      const ref = sourceRef(callRevisionId, call.line, call.ordinal, call.type)
      add({ kind: 'annotation', id: eventId('incomplete', callRevisionId, call.line, callId), category: 'incomplete-tool', text: 'Historical tool call had no recorded result; it was not executed.', source: ref })
    }
  }
  return events
}

function inferPhase(text: string): 'commentary' | 'final_answer' | undefined {
  if (text.trim() === '') return undefined
  return /(^|\n)\s*(final answer|summary|done)\b/i.test(text) ? 'final_answer' : 'commentary'
}

export async function parseRolloutFile(filePath: string, options: RolloutParserOptions = {}): Promise<ParsedRollout> {
  const representation = options.representation ?? (filePath.endsWith('.zst') ? 'jsonl.zst' : 'jsonl')
  let statBefore
  let handle: any
  let source: any
  let hasher: any
  const hash = createHash('sha256')
  try {
    statBefore = await fs.stat(filePath)
    handle = await fs.open(filePath, 'r')
    const fdBefore = await handle.stat()
    if (statBefore.size !== fdBefore.size || statBefore.mtimeMs !== fdBefore.mtimeMs || statBefore.ino !== fdBefore.ino) throw new Error('path changed while opening')
  } catch {
    throw new HandoffError({ code: 'CODEX_ACCESS_DENIED', message: 'The Codex rollout could not be opened.', recoverable: true })
  }
  try {
    source = createReadStream(filePath, { fd: handle.fd, autoClose: false, highWaterMark: 64 * 1024 })
    hasher = new Transform({
      transform(chunk: any, _encoding: unknown, callback: (error?: Error | null, data?: any) => void): void {
        try { hash.update(chunk); callback(null, chunk) } catch (error) { callback(error as Error) }
      },
    })
    // Keep raw fingerprinting independent from the decompressor.  When the
    // compressed parser hits its hard decompressed budget, zstd is destroyed
    // immediately while this side branch continues hashing the bounded source
    // snapshot; no additional bytes are decompressed just to finish hashing.
    source.pipe(hasher)
    hasher.resume()
    const input = representation === 'jsonl.zst' ? source.pipe(createZstdDecompress()) : source
    const parsed = await parseRollout(input as AsyncIterable<Uint8Array>, { ...options, representation, filePath, ...(representation === 'jsonl.zst' ? { stopOnLimit: true } : {}) })
    await new Promise<void>((resolve, reject) => {
      if (hasher.writableFinished === true) { resolve(); return }
      hasher.once('finish', resolve)
      hasher.once('error', reject)
    })
    const statAfter = await fs.stat(filePath)
    const fdAfter = await handle.stat()
    if (statBefore.size !== statAfter.size || statBefore.mtimeMs !== statAfter.mtimeMs || statBefore.ino !== statAfter.ino || fdAfter.size !== statBefore.size || fdAfter.mtimeMs !== statBefore.mtimeMs || fdAfter.ino !== statBefore.ino) {
      throw new HandoffError({ code: 'SOURCE_CHANGED', message: 'The Codex rollout changed while it was being read.', recoverable: true })
    }
    const fingerprint = hash.digest('hex')
    const effectiveSourceLimit = effectiveParseLimits(options.limits).sourceFileBytes
    return { ...parsed, fingerprint, byteSize: statAfter.size, decompressedBytes: representation === 'jsonl.zst' ? Math.min(parsed.byteSize, effectiveSourceLimit) : parsed.byteSize }
  } catch (error) {
    if (error instanceof HandoffError) throw error
    throw new HandoffError({ code: representation === 'jsonl.zst' ? 'CODEX_COMPRESSED_INVALID' : 'CODEX_ACCESS_DENIED', message: representation === 'jsonl.zst' ? 'The compressed Codex rollout is invalid.' : 'The Codex rollout could not be read.', recoverable: true, cause: error })
  } finally {
    try { source?.destroy() } catch { /* source cleanup */ }
    try { hasher?.destroy() } catch { /* hash cleanup */ }
    try { await handle.close() } catch { /* descriptor cleanup */ }
  }
}

export function normalizeRolloutRecords(records: readonly RolloutRecord[], revisionId: string, limits: EffectiveLimits, diagnostics: Diagnostic[], completeness: NormalizedSession['completeness']): NormalizedEvent[] {
  const candidates: RawCandidate[] = []
  for (const record of records) {
    const encrypted = { value: false }
    candidates.push(...candidatesFor(record, encrypted))
    if (encrypted.value) completeness.droppedEncryptedBlocks += 1
  }
  return normalizeCandidates(candidates, revisionId, limits, diagnostics, completeness)
}

/**
 * v2 brackets require every surfaced tool call to have a result.  The legacy
 * normalizer intentionally keeps a dangling call plus an annotation so that
 * v1 consumers can see what was lost.  For the strict logical-session shape,
 * retain the diagnostic/annotation but omit the unpaired call itself.
 */
function removeUnpairedToolCalls(events: readonly NormalizedEvent[]): NormalizedEvent[] {
  const pending = new Map<string, string[]>()
  const paired = new Set<string>()
  for (const event of events) {
    if (event.kind === 'tool-call') {
      const queue = pending.get(event.callId) ?? []
      queue.push(event.id)
      pending.set(event.callId, queue)
    } else if (event.kind === 'tool-result') {
      const queue = pending.get(event.callId)
      const callId = queue?.shift()
      if (callId !== undefined) paired.add(callId)
    }
  }
  return events.filter(event => event.kind !== 'tool-call' || paired.has(event.id))
}

interface RollbackMarker {
  readonly chainOrder: number
  readonly source: SourceRef
  readonly at?: string
  readonly removedUserTurns: number
  readonly removedBoundaryIds: readonly string[]
}

interface LifecycleSignal {
  readonly kind: 'turn-start' | 'turn-complete' | 'turn-aborted'
  readonly chainOrder: number
  readonly source: SourceRef
  readonly at?: string
  readonly turnId?: string
  readonly failed?: boolean
}

interface LogicalPreparation {
  readonly records: RolloutRecord[]
  readonly rollbackMarkers: RollbackMarker[]
  readonly signals: LifecycleSignal[]
  readonly hasRollback: boolean
  readonly unsupported: boolean
}

export interface LogicalNormalizationOptions {
  /** A rollback cannot be safely represented when its required prefix is partial. */
  readonly forceUnsupportedIfRollback?: boolean
}

export interface LogicalNormalizationResult {
  readonly timeline: NormalizedEvent[]
  readonly diagnostics: Diagnostic[]
  readonly completeness: NormalizedSession['completeness']
  readonly unsupported: boolean
  readonly hasRollback: boolean
}

function recordPayload(record: RolloutRecord): Record<string, unknown> {
  const outer = objectValue(record.envelope.payload) ?? record.envelope
  return objectValue(outer.payload) ?? outer
}

function recordSemanticType(record: RolloutRecord): string | undefined {
  const top = stringValue(record.envelope.type)
  const outer = objectValue(record.envelope.payload) ?? record.envelope
  const nested = objectValue(outer.payload)
  const value = stringValue(outer.type) ?? stringValue(nested?.type) ?? stringValue(outer.event_type) ?? stringValue(outer.eventType)
  return (value ?? (top === 'compacted' || top === 'compaction' ? top : undefined))?.toLowerCase().replace(/-/g, '_')
}

function containsObjectKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some(item => containsObjectKey(item, key))
  const object = objectValue(value)
  if (object === undefined) return false
  return Object.entries(object).some(([name, child]) => name.toLowerCase() === key || containsObjectKey(child, key))
}

const contextualUserTag = /<(?:user_instructions|environment_context|environments_instructions|apps_instructions|skills_instructions|plugins_instructions|permissions_instructions|recommended_plugins|app_context|in-app-browser-context|tools|context_window|context_window_guidance|multi_agent_mode|realtime_conversation)>/i

function isContextualUserText(text: string | undefined): boolean {
  return contextualUserTag.test(text?.trim() ?? '')
}

function isContextualUser(candidate: RawCandidate): boolean {
  return candidate.role !== 'user' || isContextualUserText(candidate.text)
}

function sourceForRecord(record: RolloutRecord, revisionId: string): SourceRef {
  return sourceRef(record.revisionId ?? revisionId, record.line, record.ordinal, record.type)
}

function boundaryId(candidate: RawCandidate, revisionId: string): string {
  const candidateRevisionId = candidate.revisionId ?? revisionId
  return eventId('boundary', candidateRevisionId, candidate.line, `${candidate.ordinal ?? ''}`)
}

function controlSignals(records: readonly RolloutRecord[], revisionId: string, addUnsupported: (message: string, record?: RolloutRecord) => void): { signals: LifecycleSignal[]; rollbackIds: Set<string>; hasRollback: boolean } {
  const signals: LifecycleSignal[] = []
  const rollbackIds = new Set<string>()
  let hasRollback = false
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] as RolloutRecord
    const semanticType = recordSemanticType(record)
    const payload = recordPayload(record)
    const chainOrder = record.chainOrder ?? index
    const source = sourceForRecord(record, revisionId)
    const at = isoTimestamp(record.envelope.timestamp)
    if (semanticType === 'thread_rolled_back') {
      hasRollback = true
      const explicitId = stringValue(payload.id) ?? stringValue(payload.event_id) ?? stringValue(payload.eventId)
      const identity = explicitId ?? `${source.locator}:${source.line ?? 0}`
      if (rollbackIds.has(identity)) addUnsupported('Duplicate thread rollback records are ambiguous.', record)
      rollbackIds.add(identity)
      continue
    }
    if (semanticType === 'turn_started' || semanticType === 'task_started') {
      signals.push({ kind: 'turn-start', chainOrder, source, ...(at === undefined ? {} : { at }), ...(stringValue(payload.turn_id) ?? stringValue(payload.turnId) ? { turnId: (stringValue(payload.turn_id) ?? stringValue(payload.turnId)) as string } : {}) })
      continue
    }
    if (semanticType === 'turn_complete' || semanticType === 'task_complete') {
      const failed = payload.error !== undefined && payload.error !== null || payload.failed === true || payload.status === 'failed' || payload.status === 'error'
      signals.push({ kind: 'turn-complete', chainOrder, source, ...(at === undefined ? {} : { at }), ...(stringValue(payload.turn_id) ?? stringValue(payload.turnId) ? { turnId: (stringValue(payload.turn_id) ?? stringValue(payload.turnId)) as string } : {}), ...(failed ? { failed: true } : {}) })
      continue
    }
    if (semanticType === 'turn_aborted') {
      signals.push({ kind: 'turn-aborted', chainOrder, source, ...(at === undefined ? {} : { at }), ...(stringValue(payload.turn_id) ?? stringValue(payload.turnId) ? { turnId: (stringValue(payload.turn_id) ?? stringValue(payload.turnId)) as string } : {}) })
      continue
    }
    // The current shared v2 contract cannot prove that compaction replacement
    // history is complete, so fail closed instead of silently flattening it.
    if (semanticType === 'compacted' || semanticType === 'compaction' || semanticType === 'context_compacted' || semanticType === 'context_compaction' || containsObjectKey(record.envelope, 'replacement_history') || containsObjectKey(record.envelope, 'replacementhistory')) {
      addUnsupported('Codex compaction or replacement history cannot be verified completely.', record)
    }
    const topType = stringValue(record.envelope.type)?.toLowerCase().replace(/-/g, '_')
    if (topType?.startsWith('inter_agent') || semanticType?.startsWith('inter_agent')) addUnsupported('Structured inter-agent boundaries are unsupported for safe handoff.', record)
  }
  return { signals, rollbackIds, hasRollback }
}

function applyRollbackLedger(records: readonly RolloutRecord[], revisionId: string, addUnsupported: (message: string, record?: RolloutRecord) => void): LogicalPreparation {
  const controls = controlSignals(records, revisionId, addUnsupported)
  const signals = controls.signals
  const rollbackMarkers: RollbackMarker[] = []
  const effective: RolloutRecord[] = []
  const boundaries: Array<{ id: string; start: number }> = []
  let hasRollback = controls.hasRollback
  let unsupported = false
  // Keep the lifecycle boundary attached to the next user instruction.  A
  // rollback removes the complete turn-start envelope, not just the user
  // message, so it cannot leave an empty unknown turn before the audit event.
  let pendingTurnStart: number | undefined
  const markUnsupported = (message: string, record?: RolloutRecord): void => { unsupported = true; addUnsupported(message, record) }
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] as RolloutRecord
    const semanticType = recordSemanticType(record)
    if (semanticType === 'thread_rolled_back') {
      hasRollback = true
      const payload = recordPayload(record)
      const number = payload.num_turns ?? payload.numTurns
      if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) {
        markUnsupported('Thread rollback num_turns must be a positive safe integer.', record)
        continue
      }
      if (number > boundaries.length) {
        markUnsupported('Thread rollback does not have enough surviving user boundaries.', record)
        continue
      }
      const removed = boundaries.slice(boundaries.length - number)
      const first = removed[0]
      if (first === undefined || new Set(removed.map(item => item.id)).size !== removed.length) {
        markUnsupported('Thread rollback boundary ledger is ambiguous or duplicated.', record)
        continue
      }
      effective.splice(first.start)
      boundaries.splice(boundaries.length - number, number)
      const source = sourceForRecord(record, revisionId)
      rollbackMarkers.push({ chainOrder: record.chainOrder ?? index, source, ...(isoTimestamp(record.envelope.timestamp) === undefined ? {} : { at: isoTimestamp(record.envelope.timestamp) as string }), removedUserTurns: number, removedBoundaryIds: removed.map(item => item.id) })
      pendingTurnStart = undefined
      continue
    }
    const start = effective.length
    effective.push(record)
    if (semanticType === 'turn_started' || semanticType === 'task_started') {
      pendingTurnStart = start
      continue
    }
    if (semanticType === 'turn_complete' || semanticType === 'task_complete' || semanticType === 'turn_aborted') {
      pendingTurnStart = undefined
      continue
    }
    const encrypted = { value: false }
    const user = candidatesFor(record, encrypted).find(candidate => candidate.kind === 'message' && candidate.role === 'user' && !isContextualUser(candidate))
    if (user !== undefined) {
      boundaries.push({ id: boundaryId(user, revisionId), start: pendingTurnStart ?? start })
      pendingTurnStart = undefined
    }
  }
  const survivingLocators = new Set(effective.map(record => `${record.revisionId ?? revisionId}:${record.ordinal ?? record.line}`))
  return { records: effective, rollbackMarkers, signals: signals.filter(signal => survivingLocators.has(signal.source.locator)), hasRollback, unsupported: unsupported || controls.rollbackIds.size > 0 && rollbackMarkers.length === 0 && hasRollback }
}

function lifecycleEvent(payload: LifecyclePayload, source: SourceRef, revisionId: string, at: string | undefined): NormalizedEvent {
  const id = eventId('lifecycle', revisionId, source.line ?? 0, `${source.locator}\0${JSON.stringify(payload)}`)
  return { kind: 'lifecycle', id, order: 0, ...(at === undefined ? {} : { at }), lifecycle: payload, source }
}

function derivedTurnId(seed: string): string {
  return `turn-${createHash('sha256').update(seed).digest('hex').slice(0, 24)}`
}

function lifecycleTimeline(events: readonly NormalizedEvent[], records: readonly RolloutRecord[], markers: readonly RollbackMarker[], signals: readonly LifecycleSignal[], revisionId: string): NormalizedEvent[] {
  const orderByLocator = new Map<string, number>()
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] as RolloutRecord
    orderByLocator.set(`${record.revisionId ?? revisionId}:${record.ordinal ?? record.line}`, record.chainOrder ?? index)
  }
  const items: Array<{ chainOrder: number; priority: number; event?: NormalizedEvent; marker?: RollbackMarker; signal?: LifecycleSignal }> = []
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index] as NormalizedEvent
    items.push({ chainOrder: orderByLocator.get(event.source.locator) ?? records.length + index, priority: 1, event })
  }
  for (const signal of signals) items.push({ chainOrder: signal.chainOrder, priority: signal.kind === 'turn-start' ? 0 : 2, signal })
  for (const marker of markers) items.push({ chainOrder: marker.chainOrder, priority: 3, marker })
  items.sort((left, right) => left.chainOrder - right.chainOrder || left.priority - right.priority)
  const output: NormalizedEvent[] = []
  const usedTurnIds = new Set<string>()
  let state: { turnId: string; step: number; stepOpen: boolean; source: SourceRef; sawUser: boolean; sawAssistant: boolean; needsNextResponse: boolean; openCalls: Set<string> } | undefined
  const emit = (event: NormalizedEvent): void => { output.push(event) }
  const boundedTurnId = (turnId: string): string => turnId.length > 512 ? derivedTurnId(turnId) : turnId
  const ensureTurn = (turnId: string, source: SourceRef, at: string | undefined, evidence: 'codex-turn-started' | 'derived-user-boundary'): void => {
    if (state !== undefined) return
    const bounded = boundedTurnId(turnId)
    let safeTurnId = bounded
    let collision = 0
    while (usedTurnIds.has(safeTurnId)) {
      safeTurnId = derivedTurnId(`${bounded}\0${source.locator}\0${collision}`)
      collision += 1
    }
    usedTurnIds.add(safeTurnId)
    emit(lifecycleEvent({ type: 'turn-start', turnId: safeTurnId, evidence }, source, revisionId, at))
    state = { turnId: safeTurnId, step: 1, stepOpen: false, source, sawUser: false, sawAssistant: false, needsNextResponse: false, openCalls: new Set<string>() }
  }
  const ensureStep = (source: SourceRef, at: string | undefined): void => {
    if (state === undefined || state.stepOpen) return
    emit(lifecycleEvent({ type: 'step-start', turnId: state.turnId, step: state.step, evidence: 'derived-response-cycle' }, source, revisionId, at))
    state.stepOpen = true
  }
  type TurnOutcome = Extract<LifecyclePayload, { type: 'turn-end' }>['outcome']
  const closeWithOutcome = (source: SourceRef, at: string | undefined, outcome: TurnOutcome): void => {
    if (state === undefined) return
    if (state.stepOpen) {
      emit(lifecycleEvent({ type: 'step-end', turnId: state.turnId, step: state.step, evidence: 'derived-response-cycle' }, source, revisionId, at))
      state.stepOpen = false
    }
    emit(lifecycleEvent({ type: 'turn-end', turnId: state.turnId, outcome }, source, revisionId, at))
    state = undefined
  }
  const closeStepForNextResponse = (source: SourceRef, at: string | undefined): void => {
    if (state === undefined || !state.stepOpen || state.openCalls.size > 0) return
    emit(lifecycleEvent({ type: 'step-end', turnId: state.turnId, step: state.step, evidence: 'derived-response-cycle' }, source, revisionId, at))
    state.stepOpen = false
    state.step += 1
    state.sawAssistant = false
    state.needsNextResponse = false
  }
  for (const item of items) {
    const signal = item.signal
    if (signal?.kind === 'turn-start') {
      const turnId = boundedTurnId(signal.turnId === undefined || signal.turnId.length === 0 ? derivedTurnId(signal.source.locator) : signal.turnId)
      if (state !== undefined && state.turnId !== turnId) closeWithOutcome(signal.source, signal.at, { kind: 'unknown', evidence: 'next-turn-boundary' })
      ensureTurn(turnId, signal.source, signal.at, 'codex-turn-started')
      continue
    }
    if (signal?.kind === 'turn-complete' || signal?.kind === 'turn-aborted') {
      const turnId = boundedTurnId(signal.turnId === undefined || signal.turnId.length === 0 ? (state?.turnId ?? derivedTurnId(signal.source.locator)) : signal.turnId)
      if (state !== undefined && state.turnId !== turnId) closeWithOutcome(signal.source, signal.at, { kind: 'unknown', evidence: 'next-turn-boundary' })
      ensureTurn(turnId, signal.source, signal.at, 'codex-turn-started')
      closeWithOutcome(signal.source, signal.at, signal.kind === 'turn-aborted' ? { kind: 'aborted', evidence: 'codex-turn-aborted' } : signal.failed === true ? { kind: 'failed', evidence: 'codex-turn-complete' } : { kind: 'completed', evidence: 'codex-turn-complete' })
      continue
    }
    if (item.marker !== undefined) {
      closeWithOutcome(item.marker.source, item.marker.at, { kind: 'unknown', evidence: 'next-turn-boundary' })
      emit(lifecycleEvent({ type: 'rollback', removedUserTurns: item.marker.removedUserTurns, removedBoundaryIds: [...item.marker.removedBoundaryIds], evidence: 'codex-thread-rolled-back' }, item.marker.source, revisionId, item.marker.at))
      continue
    }
    const event = item.event
    if (event === undefined) continue
    if (event.kind === 'message' && event.role === 'user') {
      const contextual = isContextualUserText(event.text)
      if (!contextual && state?.sawUser === true) closeWithOutcome(event.source, event.at, { kind: 'unknown', evidence: 'next-turn-boundary' })
      ensureTurn(derivedTurnId(event.id), event.source, event.at, 'derived-user-boundary')
      ensureStep(event.source, event.at)
      if (state !== undefined && !contextual) state.sawUser = true
      emit(event)
      continue
    }
    if (state === undefined) ensureTurn(derivedTurnId(event.id), event.source, event.at, 'derived-user-boundary')
    const isModelResponse = event.kind === 'reasoning-summary' || (event.kind === 'message' && event.role === 'assistant') || event.kind === 'tool-call'
    if (isModelResponse && state?.stepOpen === true && state.openCalls.size === 0 && (state.needsNextResponse || (event.kind === 'message' && event.role === 'assistant' && state.sawAssistant))) {
      closeStepForNextResponse(event.source, event.at)
    }
    ensureStep(event.source, event.at)
    if (event.kind === 'tool-call') state?.openCalls.add(event.callId)
    else if (event.kind === 'tool-result') {
      state?.openCalls.delete(event.callId)
      if (state !== undefined) state.needsNextResponse = true
    }
    else if (event.kind === 'message' && event.role === 'assistant' && state !== undefined) state.sawAssistant = true
    emit(event)
  }
  const last = output.at(-1)
  if (state !== undefined) closeWithOutcome(last?.source ?? state.source, last?.at, { kind: 'interrupted', evidence: 'end-of-log' })
  return output.map((event, index) => ({ ...event, order: index } as NormalizedEvent))
}

export function normalizeLogicalRecords(records: readonly RolloutRecord[], revisionId: string, limits: EffectiveLimits, diagnostics: Diagnostic[], completeness: NormalizedSession['completeness'], options: LogicalNormalizationOptions = {}): LogicalNormalizationResult {
  const addDiagnostic = (item: Diagnostic): void => {
    if (diagnostics.length < HARD_LIMITS.diagnostics) diagnostics.push(item)
    else completeness.truncatedRecords += 1
  }
  let unsupported = false
  const markUnsupported = (message: string, record?: RolloutRecord): void => {
    unsupported = true
    addDiagnostic(diagnostic('CODEX_FORMAT_UNSUPPORTED', message, false, record === undefined ? undefined : { line: record.line, ordinal: record.ordinal, type: record.type }))
  }
  const prepared = applyRollbackLedger(records, revisionId, markUnsupported)
  if (options.forceUnsupportedIfRollback === true && prepared.hasRollback) {
    markUnsupported('Rollback history cannot be safely reconstructed from a partial, corrupt, or limited prefix.')
  }
  const normalized = removeUnpairedToolCalls(normalizeRolloutRecords(prepared.records, revisionId, limits, diagnostics, completeness))
  const timeline = lifecycleTimeline(normalized, prepared.records, prepared.rollbackMarkers, prepared.signals, revisionId)
  return { timeline, diagnostics, completeness, unsupported: unsupported || prepared.unsupported, hasRollback: prepared.hasRollback }
}

export async function fingerprintFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(filePath, { highWaterMark: 128 * 1024 })
  for await (const chunk of stream as AsyncIterable<Uint8Array>) hash.update(chunk)
  return hash.digest('hex')
}

export function normalizedSessionFromParsed(parsed: ParsedRollout): NormalizedSession {
  const metadata = parsed.metadata
  const sessionId = metadata?.id ?? `unknown-${parsed.revisionId}`
  const diagnostics = [...parsed.diagnostics]
  const completeness = { ...parsed.completeness }
  const logicalRecords = parsed.records.map((record, index) => ({ ...record, chainOrder: record.chainOrder ?? index }))
  const logical = normalizeLogicalRecords(logicalRecords, parsed.revisionId, effectiveParseLimits(undefined), diagnostics, completeness, { forceUnsupportedIfRollback: parsed.health !== 'complete' })
  return {
    schemaVersion: 2,
    source: {
      agent: 'codex',
      sessionId,
      rolloutRevisionId: parsed.revisionId,
      fingerprint: parsed.fingerprint ?? createHash('sha256').update(parsed.revisionId).digest('hex'),
      ...(metadata?.cwd === undefined ? {} : { cwd: metadata.cwd }),
      ...(metadata?.cliVersion === undefined ? {} : { cliVersion: metadata.cliVersion }),
      ...(metadata?.timestamp === undefined ? {} : { startedAt: metadata.timestamp }),
      ...(parsed.updatedAt === undefined ? {} : { updatedAt: parsed.updatedAt }),
      archived: parsed.archived,
    },
    lineage: [{ rolloutRevisionId: parsed.revisionId, relation: 'head', representation: parsed.representation }],
    timeline: logical.timeline,
    diagnostics,
    completeness,
  }
}

export const parseJsonl = parseRollout
export const parseCodexRollout = parseRolloutFile

export const parseCodexStream = parseRollout
export const parseJsonlStream = parseRollout

export class CodexRolloutParser {
  readonly options: RolloutParserOptions
  constructor(options: RolloutParserOptions = {}) { this.options = options }
  parse(input: RolloutInput, options: RolloutParserOptions = {}): Promise<ParsedRollout> {
    return parseRollout(input, { ...this.options, ...options })
  }
  parseFile(filePath: string, options: RolloutParserOptions = {}): Promise<ParsedRollout> {
    return parseRolloutFile(filePath, { ...this.options, ...options })
  }
}
