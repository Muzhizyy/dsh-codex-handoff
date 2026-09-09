import {
  CompiledContextSchema,
  NormalizedSessionSchema,
  type CompiledContext,
  type Diagnostic,
  type JsonValue,
  type NormalizedEvent,
  type NormalizedSession,
  type PluginSource,
  redactDiagnostic,
  redactJson,
} from '../shared/index.js'
import { HandoffError } from '../shared/errors.js'

/** JSON event envelope accepted by the DSH v2 Session constructor. */
export interface DshSeedEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: JsonValue
  readonly surfaceOp?: 'append'
  readonly sourceEventSeqs?: readonly number[]
}

export interface SeedCompilation {
  readonly seed: readonly JsonValue[]
  readonly diagnostics: readonly Diagnostic[]
}

export interface SeedCompilerOptions {
  readonly fallbackTime?: number
  readonly includeNotice?: boolean
  /** Injectable deterministic hash seam for runtimes with no Node crypto dependency. */
  readonly hash?: DeterministicHash
}

export type DeterministicHash = (parts: readonly string[]) => string

const COMPILER_SCHEMA = '1.0.0' as const
const IMPORT_PROVIDER = 'codex-import'
const IMPORT_MODEL = 'unknown'
const MAX_NOTICE_CHARS = 120

const SHA256_K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits))
}

/** Small, dependency-free SHA-256 implementation used only for deterministic IDs. */
export function sha256Hex(input: string): string {
  const source = new TextEncoder().encode(input)
  const paddedLength = Math.ceil((source.length + 9) / 64) * 64
  const bytes = new Uint8Array(paddedLength)
  bytes.set(source)
  bytes[source.length] = 0x80
  const bitLength = BigInt(source.length) * 8n
  for (let index = 0; index < 8; index += 1) {
    bytes[paddedLength - 1 - index] = Number((bitLength >> BigInt(index * 8)) & 0xffn)
  }

  let h0 = 0x6a09e667
  let h1 = 0xbb67ae85
  let h2 = 0x3c6ef372
  let h3 = 0xa54ff53a
  let h4 = 0x510e527f
  let h5 = 0x9b05688c
  let h6 = 0x1f83d9ab
  let h7 = 0x5be0cd19
  const words = new Uint32Array(64)

  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const base = offset + index * 4
      words[index] = ((bytes[base]! << 24) | (bytes[base + 1]! << 16) | (bytes[base + 2]! << 8) | bytes[base + 3]!) >>> 0
    }
    for (let index = 16; index < 64; index += 1) {
      const previous = words[index - 15]!
      const earlier = words[index - 2]!
      const sigma0 = rotateRight(previous, 7) ^ rotateRight(previous, 18) ^ (previous >>> 3)
      const sigma1 = rotateRight(earlier, 17) ^ rotateRight(earlier, 19) ^ (earlier >>> 10)
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0
    }

    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    let f = h5
    let g = h6
    let h = h7
    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choose = (e & f) ^ (~e & g)
      const first = (h + sigma1 + choose + SHA256_K[index]! + words[index]!) >>> 0
      const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const second = (sigma0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d + first) >>> 0
      d = c
      c = b
      b = a
      a = (first + second) >>> 0
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
    h5 = (h5 + f) >>> 0
    h6 = (h6 + g) >>> 0
    h7 = (h7 + h) >>> 0
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map(value => value.toString(16).padStart(8, '0'))
    .join('')
}

const stableHash: DeterministicHash = parts => {
  return sha256Hex(JSON.stringify(parts))
}

function makeMessageId(kind: string, source: string, index: number, hash: DeterministicHash = stableHash): string {
  return 'sha256-' + hash(['dsh-import', 'message', kind, source, String(index)])
}

function makeCallId(source: string, index: number, hash: DeterministicHash = stableHash): string {
  return 'sha256-' + hash(['dsh-import', 'call', source, String(index)])
}

function boundNotice(value: string): string {
  return value.length <= MAX_NOTICE_CHARS ? value : value.slice(0, MAX_NOTICE_CHARS - 1) + '…'
}

function asJson<T>(value: T): JsonValue {
  return value as unknown as JsonValue
}

function isJsonRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Redact a compiler-created plugin provenance object while retaining only the
 * two opaque identity fields required by the DSH import contract.  This is
 * deliberately typed and called only with a PluginSource produced from a
 * schema-validated NormalizedSession/CompiledContext; arbitrary seed JSON
 * never receives this exception.
 */
function redactTrustedPluginSource(source: PluginSource): JsonValue {
  const redacted = redactJson(asJson(source))
  if (!isJsonRecord(redacted)) throw new Error('plugin provenance must be a JSON object')
  return asJson({
    ...redacted,
    sourceSessionId: source.sourceSessionId,
    rolloutRevisionId: source.rolloutRevisionId,
  })
}

function redactSeedEvent(event: DshSeedEvent, trustedPluginSource?: PluginSource): DshSeedEvent {
  const redacted = redactJson(asJson(event))
  if (trustedPluginSource === undefined) return redacted as unknown as DshSeedEvent
  if (event.type !== 'user/message') {
    throw new Error('trusted plugin provenance may only annotate a user/message event')
  }
  const eventRecord = isJsonRecord(redacted) ? redacted : undefined
  const data = eventRecord?.data
  if (eventRecord === undefined || data === undefined || !isJsonRecord(data)) {
    throw new Error('trusted plugin provenance requires a message event object')
  }
  return asJson({
    ...eventRecord,
    data: {
      ...data,
      source: redactTrustedPluginSource(trustedPluginSource),
    },
  }) as unknown as DshSeedEvent
}

function diagnostic(code: string, message: string): Diagnostic {
  return { code, severity: 'warning', message, recoverable: true }
}

function sourceNotice(session: NormalizedSession): PluginSource {
  return {
    kind: 'plugin',
    plugin: 'dsh-codex-handoff',
    sourceAgent: 'codex',
    sourceSessionId: session.source.sessionId,
    rolloutRevisionId: session.source.rolloutRevisionId,
    fingerprint: session.source.fingerprint,
    mode: 'full',
    compilerSchema: COMPILER_SCHEMA,
    form: 'notice',
    summary: 'Imported read-only Codex history; historical tools were not executed.',
  }
}

function parseTime(at: string | undefined, fallback: number): number {
  if (at === undefined) return fallback
  const parsed = Date.parse(at)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(parsed)))
}

function textContent(text: string): JsonValue {
  return asJson({ type: 'text', text })
}

function assistantContent(text: string, type: 'text' | 'reasoning' = 'text'): JsonValue {
  return asJson([{ type, text }])
}

function assistantToolContent(id: string, name: string, args: string): JsonValue {
  return asJson([{ type: 'tool-call', id, name, arguments: args }])
}

function makeUserMessage(id: string, text: string, source: JsonValue): JsonValue {
  return asJson({ id, role: 'user', content: [textContent(text)], source })
}

function makeAssistantMessage(id: string, content: JsonValue): JsonValue {
  return asJson({
    id,
    role: 'assistant',
    content,
    source: { kind: 'model', provider: IMPORT_PROVIDER, model: IMPORT_MODEL },
  })
}

function makeToolResultMessage(id: string, idForCall: string, text: string, failed: boolean): JsonValue {
  return asJson({
    id,
    role: 'user',
    content: [{
      type: 'tool-result',
      toolCallId: idForCall,
      content: [textContent(text)],
      ...(failed ? { isError: true } : {}),
    }],
    source: { kind: 'tool', callId: idForCall },
  })
}

function sourceOrder(events: readonly NormalizedEvent[]): NormalizedEvent[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.order - b.event.order || a.index - b.index)
    .map(item => item.event)
}

function validateGeneratedSeed(seed: readonly DshSeedEvent[]): void {
  for (const [index, event] of seed.entries()) {
    if (event.seq !== index) throw new Error('DSH seed seq is not contiguous at ' + index)
    if (!Number.isSafeInteger(event.time) || event.time < 0) {
      throw new Error('DSH seed time is not a non-negative safe integer at ' + index)
    }
    if (event.type === 'request/header' || event.type === 'request/context' || event.type === 'session/end-seed') {
      throw new Error('DSH seed contains constructor/live-only event ' + event.type)
    }
    if (
      (event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result')
      && event.surfaceOp !== 'append'
    ) {
      throw new Error('surface event ' + event.type + ' must carry surfaceOp=append')
    }
    if (
      (event.type === 'turn/start' || event.type === 'turn/end' || event.type === 'step/start'
        || event.type === 'step/end' || event.type === 'tool/call')
      && event.surfaceOp !== undefined
    ) {
      throw new Error('log-only event ' + event.type + ' must not carry surfaceOp')
    }
    try {
      if (JSON.stringify(event) === undefined) throw new Error('not JSON')
    } catch {
      throw new Error('DSH seed event is not losslessly JSON serializable at ' + index)
    }
  }
}

interface IndexedEvent {
  readonly event: NormalizedEvent
  readonly index: number
  readonly turn: number
  readonly step: number
}

/**
 * Compile normalized Codex chronology to inert DSH v2 events.
 *
 * The compiler never imports DSH and never writes persistence. The gateway
 * supplies this JSON-only seed to the public Agent API, leaving constructor
 * ownership of session/end-seed and persistence with DSH.
 */
export class FullTrajectorySeedCompiler {
  private readonly options: {
    readonly fallbackTime: number
    readonly includeNotice: boolean
    readonly hash: DeterministicHash
  }

  constructor(options: SeedCompilerOptions = {}) {
    this.options = {
      fallbackTime: options.fallbackTime ?? 0,
      includeNotice: options.includeNotice ?? true,
      hash: options.hash ?? stableHash,
    }
  }

  compile(session: NormalizedSession): readonly JsonValue[] {
    return this.compileDetailed(session).seed
  }

  compileDetailed(rawSession: NormalizedSession): SeedCompilation {
    let session: NormalizedSession
    try {
      // Full trajectory intentionally accepts only the lifecycle-bearing v2
      // normalization. v1 and malformed brackets/evidence are never guessed.
      session = NormalizedSessionSchema.parse(rawSession)
    } catch (error) {
      throw new HandoffError({
        code: 'DSH_SEED_INVALID',
        message: 'Full trajectory requires a valid lifecycle-normalized session.',
        recoverable: false,
        cause: error,
      })
    }
    const messageId = (kind: string, source: string, index: number): string => makeMessageId(kind, source, index, this.options.hash)
    const callId = (source: string, index: number): string => makeCallId(source, index, this.options.hash)
    const diagnostics: Diagnostic[] = [...session.diagnostics]
    const events = sourceOrder(session.timeline)
    const baseTime = parseTime(session.source.startedAt ?? session.source.updatedAt, this.options.fallbackTime)

    const placementByIndex = new Map<number, { turn: number; step: number }>()
    const lifecyclePlacementByIndex = new Map<number, { turn: number; step?: number }>()
    const indexed: IndexedEvent[] = []
    let turn = 0
    let openStep = 0
    const turnById = new Map<string, number>()
    for (const [index, event] of events.entries()) {
      if (event.kind === 'lifecycle') {
        switch (event.lifecycle.type) {
          case 'turn-start':
            turn += 1
            openStep = 0
            turnById.set(event.lifecycle.turnId, turn)
            lifecyclePlacementByIndex.set(index, { turn })
            break
          case 'step-start': {
            const turnNumber = turnById.get(event.lifecycle.turnId)
            if (turnNumber === undefined) throw new Error('lifecycle step references an unknown turn')
            openStep = event.lifecycle.step
            lifecyclePlacementByIndex.set(index, { turn: turnNumber, step: openStep })
            break
          }
          case 'step-end': {
            const turnNumber = turnById.get(event.lifecycle.turnId)
            if (turnNumber === undefined) throw new Error('lifecycle step-end references an unknown turn')
            lifecyclePlacementByIndex.set(index, { turn: turnNumber, step: event.lifecycle.step })
            openStep = 0
            break
          }
          case 'turn-end': {
            const turnNumber = turnById.get(event.lifecycle.turnId)
            if (turnNumber === undefined) throw new Error('lifecycle turn-end references an unknown turn')
            lifecyclePlacementByIndex.set(index, { turn: turnNumber })
            openStep = 0
            break
          }
          case 'rollback':
            lifecyclePlacementByIndex.set(index, { turn, step: 0 })
            break
        }
      } else {
        if (turn === 0 || openStep === 0) throw new Error('normalized v2 event is outside a lifecycle step')
        const placement = { turn, step: openStep }
        placementByIndex.set(index, placement)
        indexed.push({ event, index, ...placement })
      }
    }

    const callsBySourceId = new Map<string, IndexedEvent[]>()
    const resultsBySourceId = new Map<string, IndexedEvent[]>()
    for (const item of indexed) {
      if (item.event.kind === 'tool-call') {
        const list = callsBySourceId.get(item.event.callId) ?? []
        list.push(item)
        callsBySourceId.set(item.event.callId, list)
      } else if (item.event.kind === 'tool-result') {
        const list = resultsBySourceId.get(item.event.callId) ?? []
        list.push(item)
        resultsBySourceId.set(item.event.callId, list)
      }
    }
    const resultForCall = new Map<number, IndexedEvent>()
    const callForResult = new Map<number, IndexedEvent>()
    for (const calls of callsBySourceId.values()) {
      for (const call of calls) {
        if (call.event.kind !== 'tool-call') continue
        const candidate = (resultsBySourceId.get(call.event.callId) ?? []).find(result =>
          result.index > call.index && result.turn === call.turn && result.step === call.step && !callForResult.has(result.index))
        if (candidate !== undefined) {
          resultForCall.set(call.index, candidate)
          callForResult.set(candidate.index, call)
        }
      }
    }

    const seed: DshSeedEvent[] = []
    const trustedPluginSources = new Map<number, PluginSource>()
    let lastTime = baseTime
    const emit = (
      type: string,
      candidateTime: number,
      data: JsonValue,
      surfaceOp?: 'append',
      sourceEventSeqs?: readonly number[],
      trustedPluginSource?: PluginSource,
    ): number => {
      const time = Math.max(lastTime, Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(candidateTime))))
      lastTime = time
      const event: DshSeedEvent = {
        type,
        seq: seed.length,
        time,
        data,
        ...(surfaceOp === undefined ? {} : { surfaceOp }),
        ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }),
      }
      seed.push(event)
      if (trustedPluginSource !== undefined) trustedPluginSources.set(event.seq, trustedPluginSource)
      return event.seq
    }
    const eventTime = (item: { readonly event: NormalizedEvent; readonly index: number }): number => {
      const at = 'at' in item.event ? item.event.at : undefined
      return parseTime(at, baseTime + item.index)
    }
    const notice = sourceNotice(session)

    const emittedByTurn = new Map<number, boolean>()
    const indexedByIndex = new Map(indexed.map(item => [item.index, item] as const))
    let noticeEmitted = false
    let hasLifecycle = false
    const markSurface = (turnNumber: number): void => { emittedByTurn.set(turnNumber, true) }
    const emitNotice = (time: number): void => {
      if (!this.options.includeNotice || noticeEmitted) return
      emit(
        'user/message',
        time,
        makeUserMessage(
          messageId('notice', session.source.sessionId + session.source.rolloutRevisionId, 0),
          notice.form === 'notice' ? notice.summary : 'Imported read-only Codex history.',
          notice as JsonValue,
        ),
        'append',
        undefined,
        notice,
      )
      noticeEmitted = true
    }

    for (const [index, event] of events.entries()) {
      if (event.kind === 'lifecycle') {
        hasLifecycle = true
        const placement = lifecyclePlacementByIndex.get(index)
        if (placement === undefined) throw new Error('lifecycle placement is missing')
        const time = eventTime({ event, index })
        switch (event.lifecycle.type) {
          case 'turn-start':
            emit('turn/start', time, asJson({ turn: placement.turn }))
            emittedByTurn.set(placement.turn, false)
            break
          case 'step-start':
            emit('step/start', time, asJson({ turn: placement.turn, step: event.lifecycle.step }))
            emitNotice(time)
            break
          case 'step-end':
            emit('step/end', time, asJson({ turn: placement.turn, step: event.lifecycle.step }))
            break
          case 'turn-end':
            emit('turn/end', time, asJson({
              turn: placement.turn,
              reason: event.lifecycle.outcome.kind === 'completed' ? { kind: 'completed' } : { kind: 'interrupted' },
            }))
            if (!emittedByTurn.get(placement.turn)) {
              diagnostics.push(diagnostic('DSH_EMPTY_TURN', 'An imported source turn had no surface-representable content.'))
            }
            break
          case 'rollback':
            // Rollback is source bookkeeping, not a user-visible DSH event.
            break
        }
        continue
      }

      const item = indexedByIndex.get(index)
      if (item === undefined) throw new Error('normalized v2 event placement is missing')
      const time = eventTime(item)
      const eventPlacement = placementByIndex.get(index)
      if (eventPlacement === undefined) throw new Error('normalized v2 event placement is missing')
      const turnNumber = eventPlacement.turn
      const stepNumber = eventPlacement.step
      const eventBody = item.event
      switch (eventBody.kind) {
        case 'message':
          if (eventBody.role === 'user') {
            emit('user/message', time, makeUserMessage(messageId('user', eventBody.source.locator + eventBody.id, item.index), eventBody.text, asJson({ kind: 'user' })), 'append')
            markSurface(turnNumber)
          } else if (eventBody.role === 'assistant') {
            emit('assistant/message', time, asJson({ stream: [], turn: turnNumber, step: stepNumber, message: makeAssistantMessage(messageId('assistant', eventBody.source.locator + eventBody.id, item.index), assistantContent(eventBody.text)) }), 'append')
            markSurface(turnNumber)
          }
          break
        case 'reasoning-summary':
          emit('assistant/message', time, asJson({ stream: [], turn: turnNumber, step: stepNumber, message: makeAssistantMessage(messageId('reasoning', eventBody.source.locator + eventBody.id, item.index), assistantContent(eventBody.text, 'reasoning')) }), 'append')
          markSurface(turnNumber)
          break
        case 'tool-call': {
          const paired = resultForCall.get(item.index)
          if (paired === undefined) {
            emit('assistant/message', time, asJson({ stream: [], turn: turnNumber, step: stepNumber, message: makeAssistantMessage(messageId('dangling-tool', eventBody.source.locator + eventBody.id, item.index), assistantContent('Historical tool call had no recorded result; it was not executed.')) }), 'append')
            diagnostics.push(diagnostic('DSH_DANGLING_TOOL_DOWNGRADED', 'A historical tool call without a matching result was preserved as text.'))
            markSurface(turnNumber)
            break
          }
          const mappedCallId = callId(session.source.sessionId + session.source.rolloutRevisionId + eventBody.callId, item.index)
          emit('assistant/message', time, asJson({ stream: [], turn: turnNumber, step: stepNumber, message: makeAssistantMessage(messageId('tool-call', eventBody.source.locator + eventBody.id, item.index), assistantToolContent(mappedCallId, eventBody.name, eventBody.argumentsText)) }), 'append')
          emit('tool/call', time, asJson({ turn: turnNumber, step: stepNumber, callId: mappedCallId, name: eventBody.name, arguments: eventBody.argumentsText }))
          markSurface(turnNumber)
          break
        }
        case 'tool-result': {
          const paired = callForResult.get(item.index)
          if (paired === undefined || paired.event.kind !== 'tool-call') {
            emit('user/message', time, makeUserMessage(messageId('orphan-tool-result', eventBody.source.locator + eventBody.id, item.index), 'Historical tool result had no recorded call; it was not executed.', notice as JsonValue), 'append', undefined, notice)
            diagnostics.push(diagnostic('DSH_ORPHAN_TOOL_RESULT_DOWNGRADED', 'A historical tool result without a matching call was preserved as text.'))
            markSurface(turnNumber)
            break
          }
          const mappedCallId = callId(session.source.sessionId + session.source.rolloutRevisionId + paired.event.callId, paired.index)
          const callSeq = seed.findLast(item => item.type === 'tool/call' && (item.data as { callId?: string }).callId === mappedCallId)?.seq
          if (callSeq === undefined) {
            emit('user/message', time, makeUserMessage(messageId('unpaired-tool-result', eventBody.source.locator + eventBody.id, item.index), 'Historical tool result could not be paired safely; it was not executed.', notice as JsonValue), 'append', undefined, notice)
            diagnostics.push(diagnostic('DSH_TOOL_PAIRING_FAILED', 'A historical tool result was not paired safely and was preserved as text.'))
            markSurface(turnNumber)
            break
          }
          emit('tool/result', time, asJson({ turn: turnNumber, step: stepNumber, message: makeToolResultMessage(messageId('tool-result', eventBody.source.locator + eventBody.id, item.index), mappedCallId, eventBody.content, eventBody.failed === true) }), 'append', [callSeq])
          markSurface(turnNumber)
          break
        }
        case 'compacted':
          emit('assistant/message', time, asJson({ stream: [], turn: turnNumber, step: stepNumber, message: makeAssistantMessage(messageId('compacted', eventBody.source.locator + eventBody.id, item.index), assistantContent(eventBody.summary, 'reasoning')) }), 'append')
          markSurface(turnNumber)
          break
        case 'annotation':
          emit('user/message', time, makeUserMessage(messageId('annotation', eventBody.source.locator + eventBody.id, item.index), boundNotice('Historical annotation: ' + eventBody.text), notice as JsonValue), 'append', undefined, notice)
          if (eventBody.category === 'incomplete-tool') {
            diagnostics.push(diagnostic('DSH_DANGLING_TOOL_DOWNGRADED', 'An incomplete historical tool action was preserved as text.'))
          }
          markSurface(turnNumber)
          break
        case 'lifecycle':
          throw new Error('lifecycle event was not indexed')
      }
    }

    if (!hasLifecycle) {
      emit('turn/start', baseTime, asJson({ turn: 1 }))
      emit('step/start', baseTime, asJson({ turn: 1, step: 1 }))
      emitNotice(baseTime)
      emit('step/end', baseTime, asJson({ turn: 1, step: 1 }))
      emit('turn/end', baseTime, asJson({ turn: 1, reason: { kind: 'completed' } }))
    }

    // Treat the compiler output as an untrusted aggregate: every nested
    // message, tool argument/result, annotation, notice metadata and
    // diagnostic is sanitized immediately before it can become a DSH event.
    const safeSeed = seed.map(event => redactSeedEvent(event, trustedPluginSources.get(event.seq)))
    validateGeneratedSeed(safeSeed)
    return { seed: safeSeed.map(event => asJson(event)), diagnostics: diagnostics.map(redactDiagnostic) }
  }
}

/** Compile a Smart kickoff context into one balanced, inert user turn. */
export class SmartSeedCompiler {
  private readonly hash: DeterministicHash

  constructor(options: Pick<SeedCompilerOptions, 'hash'> = {}) {
    this.hash = options.hash ?? stableHash
  }

  compile(context: CompiledContext): readonly JsonValue[] {
    return this.compileDetailed(context).seed
  }

  compileDetailed(rawContext: CompiledContext): SeedCompilation {
    const context = CompiledContextSchema.parse(rawContext)
    const seed: DshSeedEvent[] = [
      { type: 'turn/start', seq: 0, time: 0, data: asJson({ turn: 1 }) },
      { type: 'step/start', seq: 1, time: 0, data: asJson({ turn: 1, step: 1 }) },
      {
        type: 'user/message',
        seq: 2,
        time: 0,
        data: makeUserMessage(
          'sha256-' + this.hash([
            'dsh-import',
            'smart-message',
            context.source.sourceSessionId,
            context.source.rolloutRevisionId,
            context.source.fingerprint,
            context.text,
          ]),
          context.text || 'No handoff context was observed.',
          context.source as JsonValue,
        ),
        surfaceOp: 'append',
      },
      { type: 'step/end', seq: 3, time: 0, data: asJson({ turn: 1, step: 1 }) },
      { type: 'turn/end', seq: 4, time: 0, data: asJson({ turn: 1, reason: { kind: 'completed' } }) },
    ]
    // Only the compiler-created user/message carries the validated plugin
    // snapshot.  Never attach provenance to lifecycle envelopes while
    // redacting the aggregate.
    const safeSeed = seed.map(event => redactSeedEvent(
      event,
      event.seq === 2 && event.type === 'user/message' ? context.source : undefined,
    ))
    validateGeneratedSeed(safeSeed)
    return { seed: safeSeed.map(event => asJson(event)), diagnostics: context.diagnostics.map(redactDiagnostic) }
  }
}

export function compileFullSeed(session: NormalizedSession, options?: SeedCompilerOptions): SeedCompilation {
  return new FullTrajectorySeedCompiler(options).compileDetailed(session)
}

export function compileSmartSeed(context: CompiledContext, options?: Pick<SeedCompilerOptions, 'hash'>): SeedCompilation {
  return new SmartSeedCompiler(options).compileDetailed(context)
}
