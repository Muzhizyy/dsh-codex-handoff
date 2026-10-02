import { z } from 'zod'

import { utf8ByteLength } from './limits.js'

const boundedString = (maximum: number) => z.string().refine(value => utf8ByteLength(value) <= maximum)
const id = boundedString(512).min(1)
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/)
const isoDateTime = z.string().datetime({ offset: true }).max(64)

export const RETURN_CONTEXT_SOFT_LIMIT_BYTES = 64 * 1024
export const RETURN_CONTEXT_HARD_LIMIT_BYTES = 256 * 1024
export const RETURN_RECEIPT_TTL_MS = 10 * 60 * 1000

export const ReturnPreviewRequestSchema = z.object({ dshSessionId: id }).strict()

export const ReturnPreviewResponseSchema = z.object({
  receiptId: id,
  expiresAt: isoDateTime,
  context: boundedString(RETURN_CONTEXT_HARD_LIMIT_BYTES),
  contextSha256: fingerprint,
  contextBytes: z.number().int().nonnegative().max(RETURN_CONTEXT_HARD_LIMIT_BYTES),
  scope: z.object({
    target: z.literal('fork'),
    dshCursor: z.number().int().nonnegative(),
    dshRevision: id.optional(),
  }).strict(),
  source: z.object({
    codexThreadId: id,
    codexRolloutRevisionId: id,
    codexFingerprint: z.string().regex(/^[a-f0-9]{8,256}$/),
    dshSessionId: id,
  }).strict(),
  workspace: z.object({
    canonicalCwd: boundedString(4096).min(1),
    workspaceIdentity: boundedString(512).min(1),
    gitFingerprint: fingerprint,
    summary: boundedString(16 * 1024),
  }).strict(),
  warnings: z.array(boundedString(2048)).max(100),
}).strict().superRefine((value, ctx) => {
  if (value.contextBytes !== utf8ByteLength(value.context)) {
    ctx.addIssue({ code: 'custom', path: ['contextBytes'], message: 'contextBytes must match the UTF-8 byte length' })
  }
})

export const ReturnSyncRequestSchema = z.object({ receiptId: id }).strict()

const resumeSchema = z.object({
  argv: z.array(boundedString(8192)).min(3).max(3),
  displayCommand: boundedString(16 * 1024).min(1),
}).strict()

export const ReturnSyncResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.enum(['created', 'existing']),
    receiptId: id,
    sourceThreadId: id,
    codexForkId: id,
    resume: resumeSchema,
  }).strict(),
  z.object({
    status: z.literal('unknown'),
    receiptId: id,
    sourceThreadId: id,
    codexForkId: id.optional(),
    retry: z.literal('reconcile-only'),
  }).strict(),
])

export const ReturnWorkspaceSchema = ReturnPreviewResponseSchema.shape.workspace

export const ReturnSourceSchema = ReturnPreviewResponseSchema.shape.source

export const ReturnDurableRecordSchema = z.object({
  schemaVersion: z.literal(1),
  receiptId: id,
  receiptDigest: fingerprint,
  snapshotDigest: fingerprint,
  createdAt: isoDateTime,
  expiresAt: isoDateTime,
  state: z.enum(['prepared', 'dispatching', 'forked', 'injecting', 'complete', 'unknown', 'failed']),
  /** CAS owner for an in-flight app-server attempt. Never a user/session identifier. */
  attemptId: id.optional(),
  context: boundedString(RETURN_CONTEXT_HARD_LIMIT_BYTES),
  contextSha256: fingerprint,
  sourceThreadId: id,
  sourceRolloutRevisionId: id,
  sourceFingerprint: z.string().regex(/^[a-f0-9]{8,256}$/),
  dshSessionId: id,
  dshCursor: z.number().int().nonnegative(),
  dshRevision: id.optional(),
  canonicalCwd: boundedString(4096).min(1),
  workspaceIdentity: boundedString(512).min(1),
  gitFingerprint: fingerprint,
  workspaceSummary: boundedString(16 * 1024),
  warnings: z.array(boundedString(2048)).max(100),
  codexForkId: id.optional(),
  codexBinary: boundedString(8192).min(1).optional(),
  updatedAt: isoDateTime,
}).strict().superRefine((value, ctx) => {
  if (value.contextSha256.length !== 64) {
    ctx.addIssue({ code: 'custom', path: ['contextSha256'], message: 'contextSha256 must be a SHA-256 digest' })
  }
  if ((value.state === 'forked' || value.state === 'injecting' || value.state === 'complete') && value.codexForkId === undefined) {
    ctx.addIssue({ code: 'custom', path: ['codexForkId'], message: 'post-fork state requires a fork id' })
  }
  if (value.state === 'complete' && value.codexBinary === undefined) {
    ctx.addIssue({ code: 'custom', path: ['codexBinary'], message: 'complete state requires the resolved Codex binary' })
  }
})

export type ReturnPreviewRequest = z.infer<typeof ReturnPreviewRequestSchema>
export type ReturnPreviewResponse = z.infer<typeof ReturnPreviewResponseSchema>
export type ReturnSyncRequest = z.infer<typeof ReturnSyncRequestSchema>
export type ReturnSyncResponse = z.infer<typeof ReturnSyncResponseSchema>
export type ReturnDurableRecord = z.infer<typeof ReturnDurableRecordSchema>
