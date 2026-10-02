import { describe, expect, it } from 'vitest'

import { redactDetails, redactJson, redactSessionPreview, redactText, type JsonValue, type SessionPreview } from '../../src/shared/index.js'

describe('shared redaction boundary', () => {
  it('redacts credential URLs, bearer/API keys, private keys, quoted and multiline secrets', () => {
    const text = [
      'https://u:p@example.invalid/a',
      'Bearer abc.def.ghi',
      'AKIA1234567890ABCDEF',
      '-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----',
      'password: "quoted"',
      'token:\n  multiline-secret',
    ].join(' ')
    const result = redactText(text)
    expect(result).not.toContain('example.invalid')
    expect(result).not.toContain('abc.def.ghi')
    expect(result).not.toContain('AKIA1234567890ABCDEF')
    expect(result).not.toContain('PRIVATE KEY-----\nsecret')
    expect(result).not.toContain('quoted')
    expect(result).not.toContain('multiline-secret')
  })

  it('deep-redacts JSON and unknown details without changing safe primitives', () => {
    const value: JsonValue = { safe: 'hello', nested: [{ token: 'secret' }, 'Bearer abc'] }
    expect(redactJson(value)).toMatchObject({ safe: 'hello', nested: [{ token: '[REDACTED]' }, 'Bearer [REDACTED]'] })
    expect(redactDetails({ cause: new Error('not serialized'), secret: 'x' })).toMatchObject({ secret: '[REDACTED]' })
  })

  it('redacts every untrusted preview diagnostic/source string while preserving opaque IDs', () => {
    const canary = 'Bearer preview-canary'
    const preview: SessionPreview = {
      source: {
        discoveryId: 'cx1.opaque', source: 'codex', sessionId: 'thread-1', rolloutRevisionId: 'rollout-1',
        fingerprint: 'sha256-' + 'a'.repeat(64), title: canary, cwd: `C:/safe/${canary}`, updatedAt: '2026-09-05T00:00:00.000Z',
        archived: false, cliVersion: canary, messageCount: 1, toolCallCount: 0, byteSize: 1, parseHealth: 'complete',
      },
      estimatedTokens: 1,
      estimator: 'fallback',
      largestRecords: [{ kind: 'message', bytes: 1, source: { locator: 'opaque-locator', type: canary } }],
      snippets: [{ source: { locator: 'opaque-snippet', type: canary }, role: 'user', text: canary, redacted: false }],
      repository: {
        observedAt: '2026-09-05T00:00:00.000Z',
        cwd: { requested: `C:/safe/${canary}`, canonical: `C:/safe/${canary}`, exists: true },
        relevantPaths: [{ path: `src/${canary}`, exists: true, kind: 'file', observedAt: '2026-09-05T00:00:00.000Z' }],
        diagnostics: [{ code: canary, severity: 'warning', message: canary, record: { type: canary }, recoverable: true }],
      },
      completeness: { malformedLines: 0, unknownRecords: 0, droppedEncryptedBlocks: 0, danglingToolCalls: 0, orphanToolResults: 0, truncatedRecords: 0 },
      diagnostics: [{ code: canary, severity: 'warning', message: canary, record: { type: canary }, recoverable: true }],
    }
    const safe = redactSessionPreview(preview)
    expect(JSON.stringify(safe)).not.toContain(canary)
    expect(safe.source.discoveryId).toBe('cx1.opaque')
    expect(safe.largestRecords[0]?.source.locator).toBe('opaque-locator')
    expect(safe.largestRecords[0]?.source.type).toContain('[REDACTED]')
    expect(safe.snippets[0]?.redacted).toBe(true)
  })
})
