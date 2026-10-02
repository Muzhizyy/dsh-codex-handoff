import { utf8ByteLength } from '../shared/limits.js'
import type { Diagnostic, ProvenanceKind, ProvenanceRecord } from '../shared/types.js'

/** A small platform-neutral digest used for deterministic, opaque local ids. */
export function stableHash(value: string): string {
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    first ^= code & 0xff
    first = Math.imul(first, 0x01000193)
    first ^= (code >>> 8) & 0xff
    first = Math.imul(first, 0x01000193)
    second ^= code & 0xff
    second = Math.imul(second, 0x85ebca6b)
    second ^= (code >>> 8) & 0xff
    second = Math.imul(second, 0xc2b2ae35)
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`
}

export function stableId(prefix: string, value: string): string {
  return `${prefix}-${stableHash(value)}`.slice(0, 512)
}

export function boundedUtf8(value: string, maximum: number): string {
  if (utf8ByteLength(value) <= maximum) return value
  let output = ''
  let bytes = 0
  for (const character of value) {
    const next = utf8ByteLength(character)
    if (bytes + next > maximum) break
    output += character
    bytes += next
  }
  return output
}

/** Conservative, deterministic fallback estimate; non-ASCII costs at least one token. */
export function estimateTokens(value: string): number {
  let estimate = 0
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    // ASCII prose is cheap, while CJK and emoji are intentionally charged
    // conservatively so a preview cannot overrun the negotiated context cap.
    estimate += code <= 0x7f ? 0.25 : code > 0xffff ? 2 : 1
  }
  return Math.max(1, Math.ceil(estimate))
}

export function diagnostic(code: string, message: string, recoverable = true): Diagnostic {
  return {
    code: boundedUtf8(code, 128),
    severity: recoverable ? 'warning' : 'error',
    message: boundedUtf8(message, 8 * 1024),
    recoverable,
  }
}

export function provenance(
  id: string,
  kind: ProvenanceKind,
  locator: string,
  confidence: 'high' | 'medium' | 'low',
  redacted: boolean,
  observedAt?: string,
  assertedAt?: string,
): ProvenanceRecord {
  return {
    id: boundedUtf8(id, 512),
    kind,
    locator: boundedUtf8(locator, 4096),
    ...(observedAt === undefined ? {} : { observedAt }),
    ...(assertedAt === undefined ? {} : { assertedAt }),
    confidence,
    redacted,
  }
}

export function safeIso(value: string | undefined, fallback: string): string {
  if (value !== undefined && Number.isFinite(Date.parse(value))) return new Date(value).toISOString()
  return Number.isFinite(Date.parse(fallback)) ? new Date(fallback).toISOString() : new Date(0).toISOString()
}

export function sourceId(value: string): string {
  return stableId('source', value)
}
