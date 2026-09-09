import { describe, expect, it } from 'vitest'

import { HandoffError, diagnosticFromError, sanitizeRemoteError } from '../../src/shared/errors.js'
import { RemoteErrorSchema } from '../../src/shared/schemas.js'

describe('shared errors', () => {
  it('serializes a stable sanitized error DTO', () => {
    const error = new HandoffError({
      code: 'SOURCE_CHANGED',
      message: 'The selected source changed; preview it again.',
      recoverable: true,
      details: { attempt: 1 },
      cause: new Error('private implementation detail'),
    })
    expect(error).toMatchObject({ isDSHRemoteError: true })
    expect(error.toRemoteError()).toEqual({
      code: 'SOURCE_CHANGED',
      message: 'The selected source changed; preview it again.',
      recoverable: true,
      details: { attempt: 1 },
    })
    expect(diagnosticFromError(error)).toMatchObject({ code: 'SOURCE_CHANGED', recoverable: true })
  })

  it('does not leak arbitrary thrown values across Remote boundaries', () => {
    expect(sanitizeRemoteError({ secret: 'do not expose' })).toEqual({
      code: 'INTERNAL',
      message: 'The handoff operation failed unexpectedly.',
      recoverable: false,
    })
    expect(diagnosticFromError('bad input')).toMatchObject({ code: 'INTERNAL', severity: 'error' })
    expect(() => RemoteErrorSchema.parse({ code: 'NOT_A_REAL_ERROR', message: 'bad', recoverable: false })).toThrow()
  })

  it('redacts credential-bearing message and details while keeping the stable code', () => {
    const error = new HandoffError({
      code: 'SOURCE_CHANGED',
      message: 'Bearer abc123 password: "quoted-secret"',
      recoverable: true,
      details: { authorization: 'Bearer abc123', reason: 'AKIA1234567890ABCDEF' },
    })
    const remote = error.toRemoteError()
    expect(remote.code).toBe('SOURCE_CHANGED')
    expect(JSON.stringify(remote)).not.toContain('abc123')
    expect(JSON.stringify(remote)).not.toContain('quoted-secret')
    expect(JSON.stringify(remote)).not.toContain('AKIA1234567890ABCDEF')
  })
})
