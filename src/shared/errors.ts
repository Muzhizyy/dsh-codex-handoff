import type { infer as Infer } from 'zod'

import { HARD_LIMITS } from './limits.js'
import { redactRemoteDetails, redactText } from './redaction.js'
import { ErrorCodeSchema, RemoteErrorSchema } from './schemas.js'
import type { Diagnostic, RemoteError } from './types.js'

export const ERROR_CODES = ErrorCodeSchema.options
export type ErrorCode = Infer<typeof ErrorCodeSchema>

function safeMessage(message: string): string {
  return redactText(message).slice(0, HARD_LIMITS.diagnosticMessageChars)
}

function safeDetails(details: Record<string, string | number | boolean | null> | undefined): Record<string, string | number | boolean | null> | undefined {
  const sanitized = redactRemoteDetails(details)
  if (sanitized === undefined) return undefined
  return Object.fromEntries(Object.entries(sanitized).map(([key, value]) => [
    key.slice(0, 128),
    typeof value === 'string' ? value.slice(0, HARD_LIMITS.remoteDetailsChars) : value,
  ] as const))
}

export interface HandoffErrorOptions {
  readonly code: ErrorCode
  readonly message: string
  readonly recoverable: boolean
  readonly details?: Record<string, string | number | boolean | null>
  readonly cause?: unknown
}

/** Error used inside Host code; only its sanitized DTO crosses a Remote boundary. */
export class HandoffError extends Error {
  /**
   * Structural marker understood by the DSH Typert gateway. The gateway runs
   * plugin code across package/realm boundaries, so it intentionally detects
   * Remote errors by shape rather than `instanceof`. Without this marker every
   * domain failure is flattened to `gateway/internal` on the web transport.
   */
  readonly isDSHRemoteError = true as const
  readonly code: ErrorCode
  readonly recoverable: boolean
  readonly details?: Record<string, string | number | boolean | null>

  constructor(options: HandoffErrorOptions) {
    super(options.message)
    this.name = 'HandoffError'
    this.code = options.code
    this.recoverable = options.recoverable
    if (options.details !== undefined) {
      this.details = options.details
    }
    if (options.cause !== undefined) {
      this.cause = options.cause
    }
  }

  toRemoteError(): RemoteError {
    const details = safeDetails(this.details)
    const candidate = {
      code: this.code,
      message: safeMessage(this.message),
      recoverable: this.recoverable,
      ...(details === undefined ? {} : { details }),
    }
    return RemoteErrorSchema.parse(candidate)
  }
}

export function diagnosticFromError(error: unknown, fallbackCode: ErrorCode = 'INTERNAL'): Diagnostic {
  if (error instanceof HandoffError) {
    return {
      code: error.code,
      severity: 'error',
      message: safeMessage(error.message),
      recoverable: error.recoverable,
    }
  }
  return {
    code: fallbackCode,
    severity: 'error',
    message: safeMessage('The handoff operation failed unexpectedly.'),
    recoverable: false,
  }
}

export function sanitizeRemoteError(error: unknown): RemoteError {
  if (error instanceof HandoffError) {
    return error.toRemoteError()
  }
  return {
    code: 'INTERNAL',
    message: 'The handoff operation failed unexpectedly.',
    recoverable: false,
  }
}
