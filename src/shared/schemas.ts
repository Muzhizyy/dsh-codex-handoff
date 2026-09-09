import { z } from 'zod'

import { BUDGET_LIMITS, DEFAULT_LIMITS, HARD_LIMITS, utf8ByteLength } from './limits.js'

const boundedText = (maxBytes = HARD_LIMITS.normalizedTextBytes) => z.string().refine(value => utf8ByteLength(value) <= maxBytes, `must be at most ${maxBytes} UTF-8 bytes`)
const boundedId = boundedText(512).min(1)
const boundedPath = boundedText(4096).min(1)
const boundedFingerprint = boundedText(256).min(8)
const boundedKey = boundedText(256).min(1)
const nonNegativeInteger = z.number().int().nonnegative()
const isoDateTime = z.string().datetime({ offset: true }).max(64)

/** DSH `CONTEXT_SUMMARY_MAX_CHARS`; shared keeps the boundary browser-safe and UTF-8 bounded. */
export const DSH_CONTEXT_SUMMARY_MAX_CHARS = 120

function serializedJsonByteLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? Number.POSITIVE_INFINITY : utf8ByteLength(serialized)
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/** Count every item in every nested JSON array, including source-id and path arrays. */
function aggregateArrayItems(value: unknown): number {
  if (Array.isArray(value)) {
    return value.length + value.reduce((total, item) => total + aggregateArrayItems(item), 0)
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).reduce<number>(
      (total, item) => total + aggregateArrayItems(item),
      0,
    )
  }
  return 0
}

export const IsoDateTimeSchema = isoDateTime
const byteCount = nonNegativeInteger.max(HARD_LIMITS.sourceFileBytes)
const confidence = z.enum(['high', 'medium', 'low'])

export const SeveritySchema = z.enum(['info', 'warning', 'error'])
export const SessionSourceKindSchema = z.literal('codex')
export const HandoffModeSchema = z.enum(['smart', 'full'])
export const ParseHealthSchema = z.enum(['complete', 'partial', 'corrupt', 'unsupported'])
export const ErrorCodeSchema = z.enum([
  'CODEX_HOME_NOT_FOUND',
  'CODEX_ACCESS_DENIED',
  'CODEX_PARTIAL_PARSE',
  'CODEX_COMPRESSED_INVALID',
  'CODEX_LIMIT_EXCEEDED',
  'CODEX_METADATA_MISSING',
  'CODEX_FORMAT_UNSUPPORTED',
  'CODEX_HISTORY_PARTIAL',
  'CODEX_HISTORY_CORRUPT',
  'SOURCE_STALE',
  'SOURCE_CHANGED',
  'CWD_REQUIRED',
  'CWD_NOT_FOUND',
  'NOT_A_GIT_REPOSITORY',
  'GIT_INSPECTION_FAILED',
  'TRAJECTORY_CONFIRMATION_REQUIRED',
  'TRAJECTORY_TOO_LARGE',
  'SMART_ANALYZER_DEGRADED',
  'SMART_CONTEXT_CANNOT_FIT',
  'DSH_INCOMPATIBLE',
  'DSH_SEED_INVALID',
  'IMPORT_ID_CONFLICT',
  'WORKSPACE_ATTACH_FAILED',
  'SESSION_NOT_VISIBLE',
  'CANCELLED',
  'INTERNAL',
])

export const DiagnosticRecordSchema = z
  .object({
    line: nonNegativeInteger.optional(),
    ordinal: nonNegativeInteger.optional(),
    type: boundedText(128).optional(),
  })
  .strict()

export const DiagnosticSchema = z
  .object({
    code: boundedText(128).min(1),
    severity: SeveritySchema,
    message: boundedText(HARD_LIMITS.diagnosticMessageChars),
    record: DiagnosticRecordSchema.optional(),
    recoverable: z.boolean(),
  })
  .strict()

export const SourceRefSchema = z
  .object({
    locator: boundedId,
    line: nonNegativeInteger.optional(),
    ordinal: nonNegativeInteger.optional(),
    type: boundedText(128).optional(),
  })
  .strict()

export const ExternalSessionSummarySchema = z
  .object({
    discoveryId: boundedId,
    source: SessionSourceKindSchema,
    sessionId: boundedId,
    rolloutRevisionId: boundedId,
    fingerprint: boundedFingerprint,
    title: boundedText(4096).optional(),
    cwd: boundedPath.optional(),
    startedAt: isoDateTime.optional(),
    updatedAt: isoDateTime,
    archived: z.boolean(),
    cliVersion: boundedText(256).optional(),
    messageCount: nonNegativeInteger.max(HARD_LIMITS.records),
    toolCallCount: nonNegativeInteger.max(HARD_LIMITS.records),
    byteSize: byteCount,
    parseHealth: ParseHealthSchema,
  })
  .strict()

export const SessionPageSchema = z
  .object({
    items: z.array(ExternalSessionSummarySchema).max(HARD_LIMITS.discoverPageResults),
    nextCursor: boundedId.optional(),
    scannedAt: isoDateTime,
  })
  .strict()

export const ExternalSessionRefSchema = z
  .object({
    discoveryId: boundedId,
    source: SessionSourceKindSchema,
    sessionId: boundedId,
    rolloutRevisionId: boundedId,
    expectedFingerprint: boundedFingerprint.optional(),
    archived: z.boolean().optional(),
  })
  .strict()

const normalizedSourceSchema = z
  .object({
    agent: z.literal('codex'),
    sessionId: boundedId,
    rolloutRevisionId: boundedId,
    fingerprint: boundedFingerprint,
    title: boundedText(4096).optional(),
    cwd: boundedPath.optional(),
    cliVersion: boundedText(256).optional(),
    startedAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
    archived: z.boolean(),
  })
  .strict()

const lineageSchema = z
  .object({
    rolloutRevisionId: boundedId,
    relation: z.enum(['head', 'history-base']),
    endOrdinalExclusive: nonNegativeInteger.optional(),
    representation: z.enum(['jsonl', 'jsonl.zst']),
  })
  .strict()

const messageEventSchema = z
  .object({
    kind: z.literal('message'),
    id: boundedId,
    order: nonNegativeInteger.max(HARD_LIMITS.records),
    at: isoDateTime.optional(),
    role: z.enum(['user', 'assistant', 'system']),
    text: boundedText(HARD_LIMITS.normalizedTextBytes),
    phase: z.enum(['commentary', 'final_answer']).optional(),
    source: SourceRefSchema,
  })
  .strict()

const reasoningEventSchema = z
  .object({
    kind: z.literal('reasoning-summary'),
    id: boundedId,
    order: nonNegativeInteger.max(HARD_LIMITS.records),
    at: isoDateTime.optional(),
    text: boundedText(HARD_LIMITS.normalizedTextBytes),
    source: SourceRefSchema,
  })
  .strict()

const toolCallEventSchema = z
  .object({
    kind: z.literal('tool-call'),
    id: boundedId,
    order: nonNegativeInteger.max(HARD_LIMITS.records),
    at: isoDateTime.optional(),
    callId: boundedId,
    name: boundedText(512),
    argumentsText: boundedText(HARD_LIMITS.normalizedTextBytes),
    source: SourceRefSchema,
  })
  .strict()

const toolResultEventSchema = z
  .object({
    kind: z.literal('tool-result'),
    id: boundedId,
    order: nonNegativeInteger.max(HARD_LIMITS.records),
    at: isoDateTime.optional(),
    callId: boundedId,
    name: boundedText(512).optional(),
    content: boundedText(HARD_LIMITS.normalizedToolResultBytes),
    failed: z.boolean().optional(),
    source: SourceRefSchema,
  })
  .strict()

const compactedEventSchema = z
  .object({
    kind: z.literal('compacted'),
    id: boundedId,
    order: nonNegativeInteger.max(HARD_LIMITS.records),
    at: isoDateTime.optional(),
    summary: boundedText(HARD_LIMITS.normalizedTextBytes),
    source: SourceRefSchema,
  })
  .strict()

const annotationEventSchema = z
  .object({
    kind: z.literal('annotation'),
    id: boundedId,
    order: nonNegativeInteger.max(HARD_LIMITS.records),
    at: isoDateTime.optional(),
    category: z.enum(['incomplete-tool', 'unsupported', 'boundary']),
    text: boundedText(HARD_LIMITS.normalizedTextBytes),
    source: SourceRefSchema,
  })
  .strict()

const legacyNormalizedEventSchema = z.discriminatedUnion('kind', [
  messageEventSchema,
  reasoningEventSchema,
  toolCallEventSchema,
  toolResultEventSchema,
  compactedEventSchema,
  annotationEventSchema,
])

const lifecycleTurnStartPayloadSchema = z
  .object({
    type: z.literal('turn-start'),
    turnId: boundedId,
    evidence: z.enum(['codex-turn-started', 'derived-user-boundary']),
  })
  .strict()

const lifecycleStepStartPayloadSchema = z
  .object({
    type: z.literal('step-start'),
    turnId: boundedId,
    step: z.number().int().min(1).max(HARD_LIMITS.records),
    evidence: z.literal('derived-response-cycle'),
  })
  .strict()

const lifecycleStepEndPayloadSchema = z
  .object({
    type: z.literal('step-end'),
    turnId: boundedId,
    step: z.number().int().min(1).max(HARD_LIMITS.records),
    evidence: z.literal('derived-response-cycle'),
  })
  .strict()

const lifecycleTurnEndPayloadSchema = z
  .object({
    type: z.literal('turn-end'),
    turnId: boundedId,
    outcome: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('completed'), evidence: z.literal('codex-turn-complete') }).strict(),
      z.object({ kind: z.literal('failed'), evidence: z.literal('codex-turn-complete') }).strict(),
      z.object({ kind: z.literal('aborted'), evidence: z.literal('codex-turn-aborted') }).strict(),
      z.object({ kind: z.literal('interrupted'), evidence: z.literal('end-of-log') }).strict(),
      z.object({ kind: z.literal('unknown'), evidence: z.literal('next-turn-boundary') }).strict(),
    ]),
  })
  .strict()

const lifecycleRollbackPayloadSchema = z
  .object({
    type: z.literal('rollback'),
    removedUserTurns: z.number().int().min(1).max(HARD_LIMITS.records),
    removedBoundaryIds: z.array(boundedId).min(1).max(HARD_LIMITS.records),
    evidence: z.literal('codex-thread-rolled-back'),
  })
  .strict()

export const LifecyclePayloadSchema = z.discriminatedUnion('type', [
  lifecycleTurnStartPayloadSchema,
  lifecycleStepStartPayloadSchema,
  lifecycleStepEndPayloadSchema,
  lifecycleTurnEndPayloadSchema,
  lifecycleRollbackPayloadSchema,
])

const lifecycleEventSchema = z
  .object({
    kind: z.literal('lifecycle'),
    id: boundedId,
    order: nonNegativeInteger.max(HARD_LIMITS.records),
    at: isoDateTime.optional(),
    lifecycle: LifecyclePayloadSchema,
    source: SourceRefSchema,
  })
  .strict()

export const NormalizedEventSchema = z.discriminatedUnion('kind', [
  messageEventSchema,
  reasoningEventSchema,
  toolCallEventSchema,
  toolResultEventSchema,
  compactedEventSchema,
  annotationEventSchema,
  lifecycleEventSchema,
])

export const CompletenessSchema = z
  .object({
    malformedLines: nonNegativeInteger,
    unknownRecords: nonNegativeInteger,
    droppedEncryptedBlocks: nonNegativeInteger,
    danglingToolCalls: nonNegativeInteger,
    orphanToolResults: nonNegativeInteger,
    truncatedRecords: nonNegativeInteger,
  })
  .strict()

const normalizedSessionFields = {
  source: normalizedSourceSchema,
  lineage: z.array(lineageSchema).max(HARD_LIMITS.chainFiles),
  diagnostics: z.array(DiagnosticSchema).max(HARD_LIMITS.diagnostics),
  completeness: CompletenessSchema,
}

const normalizedSessionV1Fields = {
  ...normalizedSessionFields,
  schemaVersion: z.literal(1),
  timeline: z.array(legacyNormalizedEventSchema).max(HARD_LIMITS.records),
}

/** Legacy read-only shape. Full handoff must use NormalizedSessionSchema (v2). */
export const NormalizedSessionV1Schema = z.object(normalizedSessionV1Fields).strict()

const normalizedSessionV2Schema = z
  .object({
    ...normalizedSessionFields,
    schemaVersion: z.literal(2),
    timeline: z.array(NormalizedEventSchema).max(HARD_LIMITS.records),
  })
  .strict()

export const NormalizedSessionSchema = normalizedSessionV2Schema.superRefine((session, ctx) => {
  const seenOrders = new Set<number>()
  const seenTurnIds = new Set<string>()
  const closedTurnIds = new Set<string>()
  const openCalls = new Set<string>()
  let openTurn: { turnId: string } | undefined
  let openStep: { turnId: string; step: number } | undefined
  let nextStep = 1

  for (const [index, event] of session.timeline.entries()) {
    if (seenOrders.has(event.order)) {
      ctx.addIssue({ code: 'custom', path: ['timeline', index, 'order'], message: 'timeline order values must be unique' })
    }
    seenOrders.add(event.order)
    if (event.order !== index) {
      ctx.addIssue({ code: 'custom', path: ['timeline', index, 'order'], message: 'timeline order must be continuous and match array order' })
    }

    if (event.kind !== 'lifecycle') {
      if (!openStep) {
        ctx.addIssue({ code: 'custom', path: ['timeline', index], message: 'surface and tool events must be inside an open step' })
      }
      if (event.kind === 'tool-call') {
        if (openCalls.has(event.callId)) {
          ctx.addIssue({ code: 'custom', path: ['timeline', index, 'callId'], message: 'tool call is already open' })
        }
        openCalls.add(event.callId)
      } else if (event.kind === 'tool-result') {
        if (!openCalls.has(event.callId)) {
          ctx.addIssue({ code: 'custom', path: ['timeline', index, 'callId'], message: 'tool result has no open call' })
        }
        openCalls.delete(event.callId)
      }
      continue
    }

    const payload = event.lifecycle
    if (payload.type === 'turn-start') {
      if (openTurn || openStep) {
        ctx.addIssue({ code: 'custom', path: ['timeline', index, 'lifecycle'], message: 'turn brackets must not nest' })
      }
      if (seenTurnIds.has(payload.turnId)) {
        ctx.addIssue({ code: 'custom', path: ['timeline', index, 'lifecycle', 'turnId'], message: 'turn ids must be unique' })
      }
      seenTurnIds.add(payload.turnId)
      openTurn = { turnId: payload.turnId }
      openStep = undefined
      nextStep = 1
      continue
    }

    if (payload.type === 'step-start') {
      if (!openTurn) {
        ctx.addIssue({ code: 'custom', path: ['timeline', index, 'lifecycle'], message: 'step must be inside a turn' })
      } else if (payload.turnId !== openTurn.turnId) {
        ctx.addIssue({ code: 'custom', path: ['timeline', index, 'lifecycle', 'turnId'], message: 'step turnId must match its open turn' })
      }
      if (openStep) {
        ctx.addIssue({ code: 'custom', path: ['timeline', index, 'lifecycle'], message: 'step brackets must not nest' })
      }
      if (payload.step !== nextStep) {
        ctx.addIssue({ code: 'custom', path: ['timeline', index, 'lifecycle', 'step'], message: 'steps must be contiguous and 1-based within a turn' })
      }
      if (openTurn && payload.turnId === openTurn.turnId && !openStep && payload.step === nextStep) {
        openStep = { turnId: payload.turnId, step: payload.step }
      }
      continue
    }

    if (payload.type === 'step-end') {
      if (!openStep) {
        ctx.addIssue({ code: 'custom', path: ['timeline', index, 'lifecycle'], message: 'step-end must close an open step' })
      } else {
        if (payload.turnId !== openStep.turnId) {
          ctx.addIssue({ code: 'custom', path: ['timeline', index, 'lifecycle', 'turnId'], message: 'step-end turnId must match its open step' })
        }
        if (payload.step !== openStep.step) {
          ctx.addIssue({ code: 'custom', path: ['timeline', index, 'lifecycle', 'step'], message: 'step-end must close the current step' })
        }
        if (openCalls.size > 0) {
          ctx.addIssue({ code: 'custom', path: ['timeline', index], message: 'step-end cannot leave dangling tool calls' })
        }
        if (payload.turnId === openStep.turnId && payload.step === openStep.step) {
          openStep = undefined
          nextStep += 1
        }
      }
      continue
    }

    if (payload.type === 'turn-end') {
      if (!openTurn) {
        ctx.addIssue({ code: 'custom', path: ['timeline', index, 'lifecycle'], message: 'turn-end must close an open turn' })
      } else {
        if (openStep) {
          ctx.addIssue({ code: 'custom', path: ['timeline', index], message: 'turn-end cannot close a turn with an open step' })
        }
        if (payload.turnId !== openTurn.turnId) {
          ctx.addIssue({ code: 'custom', path: ['timeline', index, 'lifecycle', 'turnId'], message: 'turn-end turnId must match its open turn' })
        }
        if (!openStep && payload.turnId === openTurn.turnId) {
          closedTurnIds.add(openTurn.turnId)
          openTurn = undefined
          nextStep = 1
        }
      }
      continue
    }

    if (openTurn || openStep) {
      ctx.addIssue({ code: 'custom', path: ['timeline', index, 'lifecycle'], message: 'rollback must be outside turn and step brackets' })
    }
    if (payload.removedBoundaryIds.length !== payload.removedUserTurns) {
      ctx.addIssue({ code: 'custom', path: ['timeline', index, 'lifecycle', 'removedBoundaryIds'], message: 'rollback boundary count must equal removed user turns' })
    }
    if (new Set(payload.removedBoundaryIds).size !== payload.removedBoundaryIds.length) {
      ctx.addIssue({ code: 'custom', path: ['timeline', index, 'lifecycle', 'removedBoundaryIds'], message: 'rollback boundary ids must be unique' })
    }
  }

  if (openStep) {
    ctx.addIssue({ code: 'custom', path: ['timeline'], message: 'timeline contains an unclosed step bracket' })
  }
  if (openTurn) {
    ctx.addIssue({ code: 'custom', path: ['timeline'], message: 'timeline contains an unclosed turn bracket' })
  }
})

/** Smart may inspect legacy v1 records; v1 is intentionally excluded from Full schema. */
export const NormalizedSessionReadSchema = z.union([NormalizedSessionSchema, NormalizedSessionV1Schema])

export const PathChangeSchema = z
  .object({
    path: boundedPath,
    oldPath: boundedPath.optional(),
    index: z.boolean(),
    worktree: z.boolean(),
  })
  .strict()

const gitStateSchema = z
  .object({
    repoRoot: boundedPath,
    branch: boundedText(1024).optional(),
    detached: z.boolean(),
    head: boundedText(256),
    dirty: z.boolean(),
    modified: z.array(PathChangeSchema).max(HARD_LIMITS.records),
    added: z.array(PathChangeSchema).max(HARD_LIMITS.records),
    deleted: z.array(PathChangeSchema).max(HARD_LIMITS.records),
    renamed: z.array(PathChangeSchema).max(HARD_LIMITS.records),
    untracked: z.array(PathChangeSchema).max(HARD_LIMITS.records),
    staged: z.array(boundedPath).max(HARD_LIMITS.records),
    unstaged: z.array(boundedPath).max(HARD_LIMITS.records),
    recentCommits: z
      .array(
        z
          .object({
            hash: boundedText(256),
            subject: boundedText(4096),
            authoredAt: isoDateTime,
          })
          .strict(),
      )
      .max(HARD_LIMITS.records),
  })
  .strict()

const relevantPathSchema = z
  .object({
    path: boundedPath,
    exists: z.boolean(),
    kind: z.enum(['file', 'directory', 'symlink', 'other']).optional(),
    size: byteCount.optional(),
    observedAt: isoDateTime,
  })
  .strict()

export const RepositoryStateSchema = z
  .object({
    observedAt: isoDateTime,
    cwd: z
      .object({
        requested: boundedPath,
        canonical: boundedPath,
        exists: z.boolean(),
        writable: z.boolean().optional(),
      })
      .strict(),
    git: gitStateSchema.optional(),
    relevantPaths: z.array(relevantPathSchema).max(HARD_LIMITS.records),
    diagnostics: z.array(DiagnosticSchema).max(HARD_LIMITS.diagnostics),
  })
  .strict()

export const ProvenanceKindSchema = z.enum(['conversation', 'tool-result', 'git', 'filesystem', 'inferred'])
export const ProvenanceRecordSchema = z
  .object({
    id: boundedId,
    kind: ProvenanceKindSchema,
    locator: boundedText(4096),
    observedAt: isoDateTime.optional(),
    assertedAt: isoDateTime.optional(),
    confidence,
    redacted: z.boolean(),
  })
  .strict()

export const ClaimSchema = z
  .object({
    id: boundedId,
    subject: boundedText(4096),
    predicate: boundedText(1024),
    value: z.unknown(),
    status: z.enum(['current', 'superseded', 'unverified', 'historical']),
    sourceIds: z.array(boundedId).min(1).max(HARD_LIMITS.provenanceRecords),
    order: nonNegativeInteger.optional(),
  })
  .strict()

export const ManifestTextSchema = z
  .object({
    text: boundedText(HARD_LIMITS.normalizedTextBytes),
    sourceIds: z.array(boundedId).min(1).max(HARD_LIMITS.provenanceRecords),
    confidence,
  })
  .strict()

export const WorkItemSchema = ManifestTextSchema.extend({
  id: boundedId,
  status: z.enum(['completed', 'in-progress', 'blocked', 'historical']),
}).strict()

export const DecisionSchema = ManifestTextSchema.extend({
  id: boundedId,
  rationale: boundedText(HARD_LIMITS.normalizedTextBytes).optional(),
  status: z.enum(['active', 'superseded']),
}).strict()

export const FailedAttemptSchema = ManifestTextSchema.extend({
  id: boundedId,
  reason: boundedText(HARD_LIMITS.normalizedTextBytes).optional(),
  currentRepoPresence: z.union([z.boolean(), z.literal('unknown')]),
}).strict()

export const ProblemSchema = ManifestTextSchema.extend({
  id: boundedId,
  severity: z.enum(['blocking', 'non-blocking', 'unknown']),
}).strict()

export const RelevantFileSchema = ManifestTextSchema.extend({
  path: boundedPath,
  exists: z.boolean(),
  change: boundedText(4096).optional(),
}).strict()

export const CommandRecordSchema = ManifestTextSchema.extend({
  commandSummary: boundedText(4096),
  result: z.enum(['passed', 'failed', 'unknown']),
  at: isoDateTime.optional(),
}).strict()

export const VerificationItemSchema = ManifestTextSchema.extend({
  name: boundedText(1024),
  at: isoDateTime.optional(),
}).strict()

/**
 * Recency fields for model/deterministic claims.  These are intentionally
 * separate from the legacy manifest item shape: v1 remains readable while
 * v2 claims carry one total order across every claim section.
 */
const claimRecencyFields = {
  scope: boundedText(1024),
  order: nonNegativeInteger.max(HARD_LIMITS.records),
  timestamp: isoDateTime,
}

export const AnalysisClaimSchema = ManifestTextSchema.extend(claimRecencyFields).strict()
export const VerificationClaimSchema = VerificationItemSchema.extend(claimRecencyFields).strict()

const VersionedManifestTextSchema = ManifestTextSchema.extend(claimRecencyFields).strict()
const VersionedWorkItemSchema = WorkItemSchema.extend(claimRecencyFields).strict()
const VersionedDecisionSchema = DecisionSchema.extend(claimRecencyFields).strict()
const VersionedFailedAttemptSchema = FailedAttemptSchema.extend(claimRecencyFields).strict()
const VersionedProblemSchema = ProblemSchema.extend(claimRecencyFields).strict()
const VersionedRelevantFileSchema = RelevantFileSchema.extend(claimRecencyFields).strict()
const VersionedCommandRecordSchema = CommandRecordSchema.extend(claimRecencyFields).strict()
const VersionedVerificationItemSchema = VerificationItemSchema.extend(claimRecencyFields).strict()

export const ActionItemSchema = ManifestTextSchema.extend({
  id: boundedId,
  priority: z.number().int().min(0).max(100),
  requiresVerification: z.boolean().optional(),
}).strict()

const VersionedActionItemSchema = ActionItemSchema.extend(claimRecencyFields).strict()

const manifestSourceSchema = z
  .object({
    agent: z.literal('codex'),
    sessionId: boundedId,
    rolloutRevisionId: boundedId,
    fingerprint: boundedFingerprint,
    title: boundedText(4096).optional(),
    startedAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  })
  .strict()

const manifestWorkspaceSchema = z
  .object({
    cwd: boundedPath,
    repoRoot: boundedPath.optional(),
    branch: boundedText(1024).optional(),
    detached: z.boolean().optional(),
    head: boundedText(256).optional(),
    dirty: z.boolean().optional(),
  })
  .strict()

const repositoryChangesSchema = z
  .object({
    modified: z.array(boundedPath).max(HARD_LIMITS.records),
    added: z.array(boundedPath).max(HARD_LIMITS.records),
    deleted: z.array(boundedPath).max(HARD_LIMITS.records),
    renamed: z
      .array(
        z
          .object({
            from: boundedPath,
            to: boundedPath,
          })
          .strict(),
      )
      .max(HARD_LIMITS.records),
    untracked: z.array(boundedPath).max(HARD_LIMITS.records),
    staged: z.array(boundedPath).max(HARD_LIMITS.records),
    unstaged: z.array(boundedPath).max(HARD_LIMITS.records),
  })
  .strict()

const verificationSchema = z
  .object({
    commandsRun: z.array(CommandRecordSchema).max(HARD_LIMITS.manifestItems),
    testsPassed: z.array(VerificationItemSchema).max(HARD_LIMITS.manifestItems),
    testsFailed: z.array(VerificationItemSchema).max(HARD_LIMITS.manifestItems),
    latestStatus: z.enum(['passing', 'failing', 'mixed', 'unknown']),
    buildStatus: z.enum(['passing', 'failing', 'unknown']).optional(),
  })
  .strict()

export const AgentHandoffManifestSchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    generatedAt: isoDateTime,
    mode: z.literal('smart'),
    source: manifestSourceSchema,
    objective: ManifestTextSchema,
    workspace: manifestWorkspaceSchema,
    progress: z
      .object({
        completed: z.array(WorkItemSchema).max(HARD_LIMITS.manifestItems),
        inProgress: z.array(WorkItemSchema).max(HARD_LIMITS.manifestItems),
        blocked: z.array(WorkItemSchema).max(HARD_LIMITS.manifestItems),
      })
      .strict(),
    decisions: z.array(DecisionSchema).max(HARD_LIMITS.manifestItems),
    failedAttempts: z.array(FailedAttemptSchema).max(HARD_LIMITS.manifestItems),
    currentProblems: z.array(ProblemSchema).max(HARD_LIMITS.manifestItems),
    relevantFiles: z.array(RelevantFileSchema).max(HARD_LIMITS.manifestItems),
    repositoryChanges: repositoryChangesSchema,
    verification: verificationSchema,
    constraints: z.array(ManifestTextSchema).max(HARD_LIMITS.manifestItems),
    openQuestions: z.array(ManifestTextSchema).max(HARD_LIMITS.manifestItems),
    nextActions: z.array(ActionItemSchema).max(HARD_LIMITS.manifestItems),
    provenance: z.array(ProvenanceRecordSchema).max(HARD_LIMITS.provenanceRecords),
    completeness: CompletenessSchema.extend({
      analyzer: z.enum(['dsh-model', 'deterministic-fallback']),
      omittedByBudget: z.record(z.string().max(256), nonNegativeInteger).superRefine((value, ctx) => {
        if (Object.keys(value).length > 256) {
          ctx.addIssue({ code: 'custom', message: 'too many budget sections' })
        }
      }),
    }).strict(),
    diagnostics: z.array(DiagnosticSchema).max(HARD_LIMITS.diagnostics),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const provenanceById = new Map<string, (typeof manifest.provenance)[number]>()
    for (const [index, item] of manifest.provenance.entries()) {
      if (provenanceById.has(item.id)) {
        ctx.addIssue({ code: 'custom', path: ['provenance', index, 'id'], message: 'provenance ids must be unique' })
      }
      provenanceById.set(item.id, item)
      if (item.kind === 'inferred' && item.confidence === 'high') {
        ctx.addIssue({ code: 'custom', path: ['provenance', index, 'confidence'], message: 'inferred evidence cannot have high confidence' })
      }
    }
    const texts: Array<{ sourceIds: string[]; path: (string | number)[] }> = [
      { sourceIds: manifest.objective.sourceIds, path: ['objective', 'sourceIds'] },
      ...manifest.progress.completed.map((item, index) => ({ sourceIds: item.sourceIds, path: ['progress', 'completed', index, 'sourceIds'] })),
      ...manifest.progress.inProgress.map((item, index) => ({ sourceIds: item.sourceIds, path: ['progress', 'inProgress', index, 'sourceIds'] })),
      ...manifest.progress.blocked.map((item, index) => ({ sourceIds: item.sourceIds, path: ['progress', 'blocked', index, 'sourceIds'] })),
      ...manifest.decisions.map((item, index) => ({ sourceIds: item.sourceIds, path: ['decisions', index, 'sourceIds'] })),
      ...manifest.failedAttempts.map((item, index) => ({ sourceIds: item.sourceIds, path: ['failedAttempts', index, 'sourceIds'] })),
      ...manifest.currentProblems.map((item, index) => ({ sourceIds: item.sourceIds, path: ['currentProblems', index, 'sourceIds'] })),
      ...manifest.relevantFiles.map((item, index) => ({ sourceIds: item.sourceIds, path: ['relevantFiles', index, 'sourceIds'] })),
      ...manifest.constraints.map((item, index) => ({ sourceIds: item.sourceIds, path: ['constraints', index, 'sourceIds'] })),
      ...manifest.openQuestions.map((item, index) => ({ sourceIds: item.sourceIds, path: ['openQuestions', index, 'sourceIds'] })),
      ...manifest.nextActions.map((item, index) => ({ sourceIds: item.sourceIds, path: ['nextActions', index, 'sourceIds'] })),
      ...manifest.verification.commandsRun.map((item, index) => ({ sourceIds: item.sourceIds, path: ['verification', 'commandsRun', index, 'sourceIds'] })),
      ...manifest.verification.testsPassed.map((item, index) => ({ sourceIds: item.sourceIds, path: ['verification', 'testsPassed', index, 'sourceIds'] })),
      ...manifest.verification.testsFailed.map((item, index) => ({ sourceIds: item.sourceIds, path: ['verification', 'testsFailed', index, 'sourceIds'] })),
    ]
    const aggregateItems = aggregateArrayItems(manifest)
    if (aggregateItems > HARD_LIMITS.manifestItems) {
      ctx.addIssue({ code: 'custom', path: ['progress'], message: 'manifest aggregate item limit exceeded' })
    } else if (serializedJsonByteLength(manifest) > HARD_LIMITS.aggregateManifestTextBytes) {
      ctx.addIssue({ code: 'custom', path: ['provenance'], message: 'manifest aggregate UTF-8 byte limit exceeded' })
    }
    for (const item of texts) {
      for (const sourceId of item.sourceIds) {
        if (!provenanceById.has(sourceId)) {
          ctx.addIssue({ code: 'custom', path: item.path, message: `unknown provenance source id: ${sourceId}` })
        }
      }
    }
  })

export const ImportIdentitySchema = z
  .object({
    key: z.string().regex(/^[a-f0-9]{64}$/),
    destinationSessionId: z.string().regex(/^session-codex-handoff-[a-f0-9]{32,64}$/),
  })
  .strict()

export type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue }

/** JSON-only value tree used for bounded DSH recovery/seed payloads. */
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    boundedText(HARD_LIMITS.seedEventBytes),
    z.array(JsonValueSchema).max(HARD_LIMITS.seedEvents),
    z.record(boundedKey, JsonValueSchema).superRefine((value, ctx) => {
      if (Object.keys(value).length > HARD_LIMITS.evidenceItems) {
        ctx.addIssue({ code: 'custom', message: 'JSON object has too many keys' })
      }
    }),
  ]),
)

const importRecoveryIntentSchema = z
  .object({
    source: ExternalSessionRefSchema,
    seedDigest: z.string().regex(/^[a-f0-9]{64}$/),
    /** Byte count of canonical UTF-8 seed JSON. Full recovery stores only this
     * count/digest and may use the larger seed-event bound; Smart replay rows
     * are restricted to the durable recovery-artifact bound below. */
    seedBytes: nonNegativeInteger.max(HARD_LIMITS.seedEventBytes),
    /** ImportRecordSchema requires this exact already-redacted seed for Smart
     * prepared/creating rows; Full rows omit it and re-compile from source. */
    seed: z.array(JsonValueSchema).max(HARD_LIMITS.seedEvents).optional(),
    targetTokens: nonNegativeInteger.min(BUDGET_LIMITS.minimumTargetTokens).optional(),
    useModel: z.boolean().optional(),
    cwdIdentity: z
      .object({ device: boundedText(128).min(1), inode: boundedText(128).min(1) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((intent, ctx) => {
    if (intent.seed !== undefined) {
      const actualBytes = serializedJsonByteLength(intent.seed)
      if (actualBytes > HARD_LIMITS.recoveryArtifactBytes) {
        ctx.addIssue({ code: 'custom', path: ['seed'], message: 'recovery seed exceeds the durable artifact byte limit' })
      }
      if (intent.seedBytes !== actualBytes) {
        ctx.addIssue({ code: 'custom', path: ['seedBytes'], message: 'recovery seedBytes must equal the UTF-8 JSON byte length' })
      }
    }
  })

export const ImportRecoveryIntentSchema = importRecoveryIntentSchema

const importRecordBaseShape = {
  schemaVersion: z.literal(2),
  key: z.string().regex(/^[a-f0-9]{64}$/),
  sourceSessionId: boundedId,
  sourceRolloutRevisionId: boundedId,
  sourceFingerprint: boundedFingerprint,
  mode: HandoffModeSchema,
  cwd: boundedPath,
  destinationSessionId: z.string().regex(/^session-codex-handoff-[a-f0-9]{32,64}$/),
  sourceFingerprintBefore: boundedFingerprint,
  attemptId: boundedId,
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  /**
   * Bounded restart intent. The source ref is an inventory handle, never a
   * rollout path. Smart prepared/creating rows retain only the already-
   * redacted bounded seed; Full rows retain digest metadata and re-compile.
   */
  recovery: importRecoveryIntentSchema.optional(),
}

/** A durable, explicit check of the destination side of the import saga. */
export const DestinationCheckSchema = z.union([
  z
    .object({
      status: z.literal('verified'),
      checkedAt: isoDateTime,
      via: z.enum(['agent-create-handle', 'session-query']),
      cwd: boundedPath,
      sourceSessionId: boundedId,
      sourceRolloutRevisionId: boundedId,
      sourceFingerprint: boundedFingerprint,
      mode: HandoffModeSchema,
      compilerSchema: boundedText(128).min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal('absent'),
      checkedAt: isoDateTime,
    })
    .strict(),
  z
    .object({
      status: z.literal('conflict'),
      checkedAt: isoDateTime,
      reason: z.enum(['destination-id-reused', 'cwd-mismatch', 'source-mismatch']),
      observedCwd: boundedPath.optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal('unknown'),
      reason: z.enum(['query-unavailable', 'query-failed', 'inspect-failed', 'metadata-missing']),
      checkedAt: isoDateTime,
    })
    .strict(),
])

/** Sanitized, stable failure details persisted with failed/orphaned records. */
export const ImportFailureSchema = z
  .object({
    phase: z.enum([
      'source-before-create',
      'agent-create',
      'source-after-create',
      'index-commit',
      'destination-query',
      'destination-verify',
      'workspace-attach',
    ]),
    code: boundedText(128).min(1).regex(/^[A-Z][A-Z0-9_]*$/),
    at: isoDateTime,
    recoverable: z.boolean(),
  })
  .strict()

const importPreparedRecordSchema = z
  .object({
    ...importRecordBaseShape,
    state: z.literal('prepared'),
  })
  .strict()

const importCreatingRecordSchema = z
  .object({
    ...importRecordBaseShape,
    state: z.literal('creating'),
    createStartedAt: isoDateTime,
  })
  .strict()

const importCreatedRecordSchema = z
  .object({
    ...importRecordBaseShape,
    state: z.literal('created'),
    createStartedAt: isoDateTime,
    /** Missing on old v2 rows and means attach completion is unknown. */
    workspaceAttachedAt: isoDateTime.optional(),
    sourceFingerprintAfter: boundedFingerprint,
    destination: z
      .object({
        status: z.literal('verified'),
        checkedAt: isoDateTime,
        via: z.enum(['agent-create-handle', 'session-query']),
        cwd: boundedPath,
        sourceSessionId: boundedId,
        sourceRolloutRevisionId: boundedId,
        sourceFingerprint: boundedFingerprint,
        mode: HandoffModeSchema,
        compilerSchema: boundedText(128).min(1),
      })
      .strict(),
  })
  .strict()

const importCreatedUnattachedRecordSchema = z
  .object({
    ...importRecordBaseShape,
    state: z.literal('created_unattached'),
    createStartedAt: isoDateTime,
    workspaceAttachedAt: isoDateTime.optional(),
    sourceFingerprintAfter: boundedFingerprint,
    destination: z
      .object({
        status: z.literal('verified'),
        checkedAt: isoDateTime,
        via: z.enum(['agent-create-handle', 'session-query']),
        cwd: boundedPath,
        sourceSessionId: boundedId,
        sourceRolloutRevisionId: boundedId,
        sourceFingerprint: boundedFingerprint,
        mode: HandoffModeSchema,
        compilerSchema: boundedText(128).min(1),
      })
      .strict(),
    failure: ImportFailureSchema.refine(value => value.phase === 'workspace-attach', { message: 'created_unattached failure must be workspace-attach' }),
  })
  .strict()

const importFailedRecordSchema = z
  .object({
    ...importRecordBaseShape,
    state: z.literal('failed'),
    failure: ImportFailureSchema,
    destination: z
      .object({
        status: z.literal('absent'),
        checkedAt: isoDateTime,
      })
      .strict(),
    createStartedAt: isoDateTime.optional(),
    sourceFingerprintAfter: boundedFingerprint.optional(),
  })
  .strict()

const importOrphanedRecordSchema = z
  .object({
    ...importRecordBaseShape,
    state: z.literal('orphaned'),
    failure: ImportFailureSchema,
    destination: DestinationCheckSchema,
    createStartedAt: isoDateTime.optional(),
    sourceFingerprintAfter: boundedFingerprint.optional(),
  })
  .strict()

export const ImportRecordSchema = z.discriminatedUnion('state', [
  importPreparedRecordSchema,
  importCreatingRecordSchema,
  importCreatedRecordSchema,
  importCreatedUnattachedRecordSchema,
  importFailedRecordSchema,
  importOrphanedRecordSchema,
]).superRefine((record, ctx) => {
  const recovery = record.recovery
  const replayState = record.state === 'prepared' || record.state === 'creating'
  if (recovery === undefined) {
    if (record.mode === 'smart' && replayState) {
      ctx.addIssue({ code: 'custom', path: ['recovery'], message: 'Smart replay records require a durable recovery intent' })
    }
    return
  }
  if (record.mode === 'full' && recovery.seed !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['recovery', 'seed'], message: 'Full recovery records must not persist a replay seed' })
  }
  if (record.mode === 'full' && recovery.targetTokens !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['recovery', 'targetTokens'], message: 'Full recovery records must not carry Smart-only targetTokens' })
  }
  if (record.mode === 'full' && recovery.useModel !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['recovery', 'useModel'], message: 'Full recovery records must not carry Smart-only useModel' })
  }
  if (record.mode === 'smart' && replayState && recovery.seed === undefined) {
    ctx.addIssue({ code: 'custom', path: ['recovery', 'seed'], message: 'Smart replay records require an exact durable seed' })
  }
  if (record.mode === 'smart' && replayState && recovery.seedBytes > HARD_LIMITS.recoveryArtifactBytes) {
    ctx.addIssue({ code: 'custom', path: ['recovery', 'seedBytes'], message: 'Smart replay seedBytes exceed the durable recovery artifact limit' })
  }
})

const importRecordV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    key: z.string().regex(/^[a-f0-9]{64}$/),
    sourceSessionId: boundedId,
    sourceRolloutRevisionId: boundedId,
    sourceFingerprint: boundedFingerprint,
    mode: HandoffModeSchema,
    cwd: boundedPath,
    destinationSessionId: z.string().regex(/^session-codex-handoff-[a-f0-9]{32,64}$/),
    state: z.enum(['prepared', 'creating', 'created', 'created_unattached', 'failed', 'orphaned']),
    sourceFingerprintBefore: boundedFingerprint,
    sourceFingerprintAfter: boundedFingerprint.optional(),
    attemptId: boundedId,
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  })
  .strict()

/** Legacy import records are read-only compatibility input, never v2 write output. */
export const ImportRecordV1Schema = importRecordV1Schema
export const ImportRecordReadSchema = z.union([ImportRecordSchema, ImportRecordV1Schema])

export const ParseLimitsSchema = z
  .object({
    discoverPageResults: nonNegativeInteger.min(1).max(HARD_LIMITS.discoverPageResults),
    filesScanned: nonNegativeInteger.min(1).max(HARD_LIMITS.filesScanned),
    lineBytes: nonNegativeInteger.min(1).max(HARD_LIMITS.lineBytes),
    sourceFileBytes: nonNegativeInteger.min(1).max(HARD_LIMITS.sourceFileBytes),
    chainDecompressedBytes: nonNegativeInteger.min(1).max(HARD_LIMITS.chainDecompressedBytes),
    chainDepth: nonNegativeInteger.min(1).max(HARD_LIMITS.chainDepth),
    chainFiles: nonNegativeInteger.min(1).max(HARD_LIMITS.chainFiles),
    records: nonNegativeInteger.min(1).max(HARD_LIMITS.records),
    normalizedTextBytes: nonNegativeInteger.min(1).max(HARD_LIMITS.normalizedTextBytes),
    normalizedToolResultBytes: nonNegativeInteger.min(1).max(HARD_LIMITS.normalizedToolResultBytes),
    previewSnippetBytes: nonNegativeInteger.min(1).max(HARD_LIMITS.previewSnippetBytes),
  })
  .strict()

export const ParseLimitsPatchSchema = ParseLimitsSchema.partial().strict()

export const DiscoverQuerySchema = z
  .object({
    cursor: boundedId.optional(),
    search: boundedText(HARD_LIMITS.remoteListSearchChars).optional(),
    archived: z.enum(['active', 'archived', 'all']).default('all'),
    limit: nonNegativeInteger.min(1).max(HARD_LIMITS.discoverPageResults).default(DEFAULT_LIMITS.discoverPageResults),
    includeMessageIndex: z.boolean().default(false),
  })
  .strict()

export const DiscoverRequestSchema = DiscoverQuerySchema

export const LargestRecordSchema = z
  .object({
    kind: z.enum(['message', 'tool-result', 'reasoning', 'other']),
    bytes: byteCount,
    source: SourceRefSchema,
  })
  .strict()

export const PreviewSnippetSchema = z
  .object({
    source: SourceRefSchema,
    role: z.enum(['user', 'assistant', 'system', 'tool']),
    text: boundedText(HARD_LIMITS.previewSnippetBytes),
    redacted: z.boolean(),
  })
  .strict()

export const SessionPreviewSchema = z
  .object({
    source: ExternalSessionSummarySchema,
    estimatedTokens: nonNegativeInteger.max(HARD_LIMITS.estimatedTokens),
    estimator: z.enum(['dsh', 'fallback']),
    largestRecords: z.array(LargestRecordSchema).max(100),
    snippets: z.array(PreviewSnippetSchema).max(100),
    repository: RepositoryStateSchema.optional(),
    completeness: CompletenessSchema,
    diagnostics: z.array(DiagnosticSchema).max(HARD_LIMITS.diagnostics),
  })
  .strict()

const pluginSourceBaseShape = {
  kind: z.literal('plugin'),
  plugin: z.literal('dsh-codex-handoff'),
  sourceAgent: z.literal('codex'),
  sourceSessionId: boundedId,
  rolloutRevisionId: boundedId,
  fingerprint: boundedFingerprint,
  mode: HandoffModeSchema,
  compilerSchema: z.literal('1.0.0'),
}

export const PluginSourceNoticeSchema = z
  .object({
    ...pluginSourceBaseShape,
    form: z.literal('notice'),
    summary: boundedText(DSH_CONTEXT_SUMMARY_MAX_CHARS).min(1),
  })
  .strict()

export const PluginSourceSnapshotSchema = z
  .object({
    ...pluginSourceBaseShape,
    form: z.literal('snapshot'),
    sections: z
      .array(
        z
          .object({
            name: boundedText(256).min(1),
            text: boundedText(HARD_LIMITS.normalizedTextBytes),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()

export const PluginSourceSchema = z.discriminatedUnion('form', [PluginSourceNoticeSchema, PluginSourceSnapshotSchema])

export const CompiledContextSchema = z
  .object({
    text: boundedText(HARD_LIMITS.seedEventBytes),
    source: PluginSourceSnapshotSchema,
    estimatedTokens: nonNegativeInteger.max(HARD_LIMITS.estimatedTokens),
    estimator: z.enum(['dsh', 'fallback']),
    omittedByBudget: z.record(z.string().max(256), nonNegativeInteger),
    diagnostics: z.array(DiagnosticSchema).max(HARD_LIMITS.diagnostics),
  })
  .strict()

export const TokenBudgetSchema = z
  .object({
    targetTokens: nonNegativeInteger.min(BUDGET_LIMITS.minimumTargetTokens).optional(),
    contextWindowTokens: nonNegativeInteger.min(BUDGET_LIMITS.minimumTargetTokens).optional(),
  })
  .strict()

export const EvidenceItemSchema = z
  .object({
    id: boundedId,
    kind: z.enum(['conversation', 'tool-result', 'git', 'filesystem']),
    text: boundedText(HARD_LIMITS.normalizedTextBytes),
    sourceId: boundedId,
    assertedAt: isoDateTime.optional(),
    redacted: z.boolean(),
  })
  .strict()

export const EvidenceBundleSchema = z
  .object({
    items: z.array(EvidenceItemSchema).max(HARD_LIMITS.evidenceItems),
    estimatedTokens: nonNegativeInteger.max(HARD_LIMITS.estimatedTokens),
    truncated: z.boolean(),
    diagnostics: z.array(DiagnosticSchema).max(HARD_LIMITS.diagnostics),
  })
  .strict()

export const AnalysisClaimsV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    objective: ManifestTextSchema.optional(),
    completed: z.array(WorkItemSchema).max(HARD_LIMITS.analysisClaims).default([]),
    inProgress: z.array(WorkItemSchema).max(HARD_LIMITS.analysisClaims).default([]),
    blocked: z.array(WorkItemSchema).max(HARD_LIMITS.analysisClaims).default([]),
    decisions: z.array(DecisionSchema).max(HARD_LIMITS.analysisClaims).default([]),
    failedAttempts: z.array(FailedAttemptSchema).max(HARD_LIMITS.analysisClaims).default([]),
    currentProblems: z.array(ProblemSchema).max(HARD_LIMITS.analysisClaims).default([]),
    relevantFiles: z.array(RelevantFileSchema).max(HARD_LIMITS.analysisClaims).default([]),
    commandsRun: z.array(CommandRecordSchema).max(HARD_LIMITS.analysisClaims).default([]),
    testsPassed: z.array(VerificationItemSchema).max(HARD_LIMITS.analysisClaims).default([]),
    testsFailed: z.array(VerificationItemSchema).max(HARD_LIMITS.analysisClaims).default([]),
    constraints: z.array(ManifestTextSchema).max(HARD_LIMITS.analysisClaims).default([]),
    openQuestions: z.array(ManifestTextSchema).max(HARD_LIMITS.analysisClaims).default([]),
    nextActions: z.array(ActionItemSchema).max(HARD_LIMITS.analysisClaims).default([]),
    provenance: z.array(ProvenanceRecordSchema).max(HARD_LIMITS.provenanceRecords).default([]),
    diagnostics: z.array(DiagnosticSchema).max(HARD_LIMITS.diagnostics).default([]),
  })
  .strict()
  .superRefine((claims, ctx) => {
    const provenanceById = new Map<string, (typeof claims.provenance)[number]>()
    for (const [index, item] of claims.provenance.entries()) {
      if (provenanceById.has(item.id)) {
        ctx.addIssue({ code: 'custom', path: ['provenance', index, 'id'], message: 'provenance ids must be unique' })
      }
      provenanceById.set(item.id, item)
      if (item.kind === 'inferred' && item.confidence === 'high') {
        ctx.addIssue({ code: 'custom', path: ['provenance', index, 'confidence'], message: 'inferred evidence cannot have high confidence' })
      }
    }
    const aggregateItems = aggregateArrayItems(claims)
    if (aggregateItems > HARD_LIMITS.analysisClaims) {
      ctx.addIssue({ code: 'custom', path: ['provenance'], message: 'analysis aggregate item limit exceeded' })
    } else if (serializedJsonByteLength(claims) > HARD_LIMITS.aggregateAnalysisTextBytes) {
      ctx.addIssue({ code: 'custom', path: ['provenance'], message: 'analysis aggregate UTF-8 byte limit exceeded' })
    }
    const sourceItems = [
      ...(claims.objective === undefined ? [] : [{ sourceIds: claims.objective.sourceIds, path: ['objective', 'sourceIds'] }]),
      ...claims.completed.map((item, index) => ({ sourceIds: item.sourceIds, path: ['completed', index, 'sourceIds'] })),
      ...claims.inProgress.map((item, index) => ({ sourceIds: item.sourceIds, path: ['inProgress', index, 'sourceIds'] })),
      ...claims.blocked.map((item, index) => ({ sourceIds: item.sourceIds, path: ['blocked', index, 'sourceIds'] })),
      ...claims.decisions.map((item, index) => ({ sourceIds: item.sourceIds, path: ['decisions', index, 'sourceIds'] })),
      ...claims.failedAttempts.map((item, index) => ({ sourceIds: item.sourceIds, path: ['failedAttempts', index, 'sourceIds'] })),
      ...claims.currentProblems.map((item, index) => ({ sourceIds: item.sourceIds, path: ['currentProblems', index, 'sourceIds'] })),
      ...claims.relevantFiles.map((item, index) => ({ sourceIds: item.sourceIds, path: ['relevantFiles', index, 'sourceIds'] })),
      ...claims.commandsRun.map((item, index) => ({ sourceIds: item.sourceIds, path: ['commandsRun', index, 'sourceIds'] })),
      ...claims.testsPassed.map((item, index) => ({ sourceIds: item.sourceIds, path: ['testsPassed', index, 'sourceIds'] })),
      ...claims.testsFailed.map((item, index) => ({ sourceIds: item.sourceIds, path: ['testsFailed', index, 'sourceIds'] })),
      ...claims.constraints.map((item, index) => ({ sourceIds: item.sourceIds, path: ['constraints', index, 'sourceIds'] })),
      ...claims.openQuestions.map((item, index) => ({ sourceIds: item.sourceIds, path: ['openQuestions', index, 'sourceIds'] })),
      ...claims.nextActions.map((item, index) => ({ sourceIds: item.sourceIds, path: ['nextActions', index, 'sourceIds'] })),
    ]
    for (const item of sourceItems) {
      for (const sourceId of item.sourceIds) {
        if (!provenanceById.has(sourceId)) {
          ctx.addIssue({ code: 'custom', path: item.path, message: `unknown provenance source id: ${sourceId}` })
        }
      }
    }
  })

function validateGlobalClaimRecency(
  claims: {
    readonly objective?: z.infer<typeof VersionedManifestTextSchema> | undefined
    readonly completed: readonly z.infer<typeof VersionedWorkItemSchema>[]
    readonly inProgress: readonly z.infer<typeof VersionedWorkItemSchema>[]
    readonly blocked: readonly z.infer<typeof VersionedWorkItemSchema>[]
    readonly decisions: readonly z.infer<typeof VersionedDecisionSchema>[]
    readonly failedAttempts: readonly z.infer<typeof VersionedFailedAttemptSchema>[]
    readonly currentProblems: readonly z.infer<typeof VersionedProblemSchema>[]
    readonly relevantFiles: readonly z.infer<typeof VersionedRelevantFileSchema>[]
    readonly commandsRun: readonly z.infer<typeof VersionedCommandRecordSchema>[]
    readonly testsPassed: readonly z.infer<typeof VersionedVerificationItemSchema>[]
    readonly testsFailed: readonly z.infer<typeof VersionedVerificationItemSchema>[]
    readonly constraints: readonly z.infer<typeof VersionedManifestTextSchema>[]
    readonly openQuestions: readonly z.infer<typeof VersionedManifestTextSchema>[]
    readonly nextActions: readonly z.infer<typeof VersionedActionItemSchema>[]
  },
  ctx: z.RefinementCtx,
): void {
  const items = [
    ...(claims.objective === undefined ? [] : [claims.objective]),
    ...claims.completed,
    ...claims.inProgress,
    ...claims.blocked,
    ...claims.decisions,
    ...claims.failedAttempts,
    ...claims.currentProblems,
    ...claims.relevantFiles,
    ...claims.commandsRun,
    ...claims.testsPassed,
    ...claims.testsFailed,
    ...claims.constraints,
    ...claims.openQuestions,
    ...claims.nextActions,
  ]
  const orders = new Map<number, number>()
  for (const [index, item] of items.entries()) {
    const prior = orders.get(item.order)
    if (prior !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['order'], message: `claim order ${item.order} is duplicated (items ${prior} and ${index})` })
    }
    orders.set(item.order, index)
  }
  const sorted = [...orders.keys()].sort((left, right) => left - right)
  for (const [index, order] of sorted.entries()) {
    if (order !== index) {
      ctx.addIssue({ code: 'custom', path: ['order'], message: 'claim order must be one global continuous sequence starting at zero' })
      break
    }
  }
}

export const AnalysisClaimsV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    objective: VersionedManifestTextSchema.optional(),
    completed: z.array(VersionedWorkItemSchema).max(HARD_LIMITS.analysisClaims).default([]),
    inProgress: z.array(VersionedWorkItemSchema).max(HARD_LIMITS.analysisClaims).default([]),
    blocked: z.array(VersionedWorkItemSchema).max(HARD_LIMITS.analysisClaims).default([]),
    decisions: z.array(VersionedDecisionSchema).max(HARD_LIMITS.analysisClaims).default([]),
    failedAttempts: z.array(VersionedFailedAttemptSchema).max(HARD_LIMITS.analysisClaims).default([]),
    currentProblems: z.array(VersionedProblemSchema).max(HARD_LIMITS.analysisClaims).default([]),
    relevantFiles: z.array(VersionedRelevantFileSchema).max(HARD_LIMITS.analysisClaims).default([]),
    commandsRun: z.array(VersionedCommandRecordSchema).max(HARD_LIMITS.analysisClaims).default([]),
    testsPassed: z.array(VersionedVerificationItemSchema).max(HARD_LIMITS.analysisClaims).default([]),
    testsFailed: z.array(VersionedVerificationItemSchema).max(HARD_LIMITS.analysisClaims).default([]),
    constraints: z.array(VersionedManifestTextSchema).max(HARD_LIMITS.analysisClaims).default([]),
    openQuestions: z.array(VersionedManifestTextSchema).max(HARD_LIMITS.analysisClaims).default([]),
    nextActions: z.array(VersionedActionItemSchema).max(HARD_LIMITS.analysisClaims).default([]),
    provenance: z.array(ProvenanceRecordSchema).max(HARD_LIMITS.provenanceRecords).default([]),
    diagnostics: z.array(DiagnosticSchema).max(HARD_LIMITS.diagnostics).default([]),
  })
  .strict()
  .superRefine((claims, ctx) => validateGlobalClaimRecency(claims, ctx))

/** v1 is retained as a strict read-only compatibility branch; new writes use v2. */
const AnalysisClaimsRuntimeSchema = z.union([AnalysisClaimsV2Schema, AnalysisClaimsV1Schema])
/**
 * The existing producer contract remains v1-shaped until its callers migrate.
 * Runtime parsing accepts both versions, while the read schema exposes the
 * discriminated union to new consumers.  Keeping this compatibility typing in
 * the shared boundary prevents a v2 read branch from infecting v1 producers.
 */
export const AnalysisClaimsSchema: z.ZodType<z.infer<typeof AnalysisClaimsV1Schema>> =
  AnalysisClaimsRuntimeSchema as unknown as z.ZodType<z.infer<typeof AnalysisClaimsV1Schema>>
export const AnalysisClaimsReadSchema = AnalysisClaimsRuntimeSchema

export const SmartPreviewSchema = z
  .object({
    source: ExternalSessionRefSchema,
    manifest: AgentHandoffManifestSchema,
    context: CompiledContextSchema,
    degraded: z.boolean(),
    diagnostics: z.array(DiagnosticSchema).max(HARD_LIMITS.diagnostics),
  })
  .strict()

export const PreparedImportSchema = z
  .object({
    identity: ImportIdentitySchema,
    source: ExternalSessionRefSchema,
    sourceFingerprint: boundedFingerprint,
    mode: HandoffModeSchema,
    cwd: boundedPath,
    title: boundedText(4096).optional(),
    seed: z.array(JsonValueSchema).max(HARD_LIMITS.seedEvents),
    seedBytes: nonNegativeInteger.max(HARD_LIMITS.seedEventBytes).optional(),
    totalBytes: nonNegativeInteger.max(HARD_LIMITS.seedEventBytes).optional(),
    manifest: AgentHandoffManifestSchema.optional(),
    context: CompiledContextSchema.optional(),
    targetTokens: nonNegativeInteger.min(BUDGET_LIMITS.minimumTargetTokens).optional(),
    useModel: z.boolean().optional(),
    cwdIdentity: z
      .object({ device: boundedText(128).min(1), inode: boundedText(128).min(1) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((prepared, ctx) => {
    const actualBytes = serializedJsonByteLength(prepared.seed)
    if (actualBytes > HARD_LIMITS.seedEventBytes) {
      ctx.addIssue({ code: 'custom', path: ['seed'], message: 'seed exceeds the aggregate UTF-8 byte limit' })
    }
    if (prepared.seedBytes !== undefined && prepared.seedBytes !== actualBytes) {
      ctx.addIssue({ code: 'custom', path: ['seedBytes'], message: 'seedBytes must equal the UTF-8 JSON byte length' })
    }
    if (prepared.totalBytes !== undefined && prepared.totalBytes !== actualBytes) {
      ctx.addIssue({ code: 'custom', path: ['totalBytes'], message: 'totalBytes must equal the UTF-8 JSON byte length' })
    }
    if (prepared.seedBytes !== undefined && prepared.totalBytes !== undefined && prepared.seedBytes !== prepared.totalBytes) {
      ctx.addIssue({ code: 'custom', path: ['totalBytes'], message: 'seedBytes and totalBytes must agree' })
    }
  })

const capabilitiesSchema = z
  .object({
    agents: z.boolean(),
    agentDefaultModel: z.boolean(),
    sessionQuery: z.boolean(),
    sessionPersistence: z.boolean(),
    workspaceRegistry: z.boolean(),
    storageDomain: z.boolean(),
    typert: z.boolean(),
  })
  .strict()

const optionalCapabilitiesSchema = z
  .object({
    llm: z.boolean(),
    agentPresets: z.boolean(),
    conversationSessionHeaderActions: z.boolean(),
    settingsSection: z.boolean(),
  })
  .strict()

export const CompatibilityViewSchema = z
  .object({
    compatible: z.boolean(),
    dshVersion: boundedText(128).optional(),
    observedSessionFormat: nonNegativeInteger.optional(),
    required: capabilitiesSchema,
    optional: optionalCapabilitiesSchema,
    diagnostics: z.array(DiagnosticSchema).max(HARD_LIMITS.diagnostics),
    checkedAt: isoDateTime,
  })
  .strict()
  .superRefine((view, ctx) => {
    const overlap = Object.keys(view.required).filter(key => key in view.optional)
    if (overlap.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['optional'],
        message: `capabilities cannot be both required and optional: ${overlap.join(', ')}`,
      })
    }
  })

export const PreviewRequestSchema = z
  .object({
    source: ExternalSessionRefSchema,
    limits: ParseLimitsSchema.optional(),
  })
  .strict()

export const SMART_DISCLOSURE_VERSION = 'smart-v1' as const
export const FULL_DISCLOSURE_VERSION = 'full-v1' as const
export const SmartDisclosureVersionSchema = z.literal(SMART_DISCLOSURE_VERSION)
export const FullDisclosureVersionSchema = z.literal(FULL_DISCLOSURE_VERSION)
export const DisclosureVersionSchema = z.enum([SMART_DISCLOSURE_VERSION, FULL_DISCLOSURE_VERSION])

export const SmartModelConsentSchema = z
  .object({
    disclosureVersion: SmartDisclosureVersionSchema,
    accepted: z.literal(true),
    acceptedMode: z.literal('smart'),
    modelAnalysis: z.literal(true),
    fullPersistence: z.literal(false),
  })
  .strict()

export const DeterministicSmartConsentSchema = z
  .object({
    disclosureVersion: SmartDisclosureVersionSchema,
    accepted: z.literal(true),
    acceptedMode: z.literal('smart'),
    modelAnalysis: z.literal(false),
    fullPersistence: z.literal(false),
  })
  .strict()

export const FullConsentSchema = z
  .object({
    disclosureVersion: FullDisclosureVersionSchema,
    accepted: z.literal(true),
    acceptedMode: z.literal('full'),
    modelAnalysis: z.literal(false),
    fullPersistence: z.literal(true),
  })
  .strict()

export const ConsentSchema = z.union([SmartModelConsentSchema, DeterministicSmartConsentSchema, FullConsentSchema])

const analyzeBaseShape = {
  source: ExternalSessionRefSchema,
  cwd: boundedPath,
  expectedFingerprint: boundedFingerprint,
  targetTokens: nonNegativeInteger.min(BUDGET_LIMITS.minimumTargetTokens).optional(),
}

const analyzeWithModelSchema = z
  .object({
    ...analyzeBaseShape,
    useModel: z.literal(true),
    consent: SmartModelConsentSchema,
  })
  .strict()

const analyzeDeterministicSchema = z
  .object({
    ...analyzeBaseShape,
    useModel: z.literal(false),
    consent: DeterministicSmartConsentSchema,
  })
  .strict()

export const AnalyzeRequestSchema = z.discriminatedUnion('useModel', [analyzeWithModelSchema, analyzeDeterministicSchema])

const createBaseShape = {
  source: ExternalSessionRefSchema,
  cwd: boundedPath,
  expectedFingerprint: boundedFingerprint,
}

/** Model-enhanced Smart Create; the consent type cannot be a Full consent. */
export const ModelSmartCreateRequestSchema = z
  .object({
    ...createBaseShape,
    mode: z.literal('smart'),
    consent: SmartModelConsentSchema,
    smart: z
      .object({
        useModel: z.literal(true),
        targetTokens: nonNegativeInteger.min(BUDGET_LIMITS.minimumTargetTokens).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.source.expectedFingerprint !== undefined && request.source.expectedFingerprint !== request.expectedFingerprint) {
      ctx.addIssue({ code: 'custom', path: ['expectedFingerprint'], message: 'source fingerprint does not match expected fingerprint' })
    }
  })

/** Deterministic Smart Create; this explicitly disallows model analysis/full persistence. */
export const DeterministicSmartCreateRequestSchema = z
  .object({
    ...createBaseShape,
    mode: z.literal('smart'),
    consent: DeterministicSmartConsentSchema,
    smart: z
      .object({
        useModel: z.literal(false),
        targetTokens: nonNegativeInteger.min(BUDGET_LIMITS.minimumTargetTokens).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.source.expectedFingerprint !== undefined && request.source.expectedFingerprint !== request.expectedFingerprint) {
      ctx.addIssue({ code: 'custom', path: ['expectedFingerprint'], message: 'source fingerprint does not match expected fingerprint' })
    }
  })

export const SmartCreateRequestSchema = z.union([
  ModelSmartCreateRequestSchema,
  DeterministicSmartCreateRequestSchema,
])

export const FullCreateRequestSchema = z
  .object({
    ...createBaseShape,
    mode: z.literal('full'),
    consent: FullConsentSchema,
    full: z
      .object({
        confirmedLarge: z.boolean().optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.source.expectedFingerprint !== undefined && request.source.expectedFingerprint !== request.expectedFingerprint) {
      ctx.addIssue({ code: 'custom', path: ['expectedFingerprint'], message: 'source fingerprint does not match expected fingerprint' })
    }
  })

/** Wire union with three exact variants: model Smart, deterministic Smart, and Full. */
export const CreateRequestSchema = z.union([
  ModelSmartCreateRequestSchema,
  DeterministicSmartCreateRequestSchema,
  FullCreateRequestSchema,
])

const createdOutcomeSchema = z
  .object({
    state: z.enum(['created', 'existing']),
    sessionId: boundedId,
    workspaceAttached: z.boolean(),
    warnings: z.array(DiagnosticSchema).max(HARD_LIMITS.diagnostics),
  })
  .strict()

const unattachedOutcomeSchema = z
  .object({
    state: z.literal('created_unattached'),
    sessionId: boundedId,
    workspaceAttached: z.literal(false),
    warnings: z.array(DiagnosticSchema).max(HARD_LIMITS.diagnostics),
  })
  .strict()

export const CreateOutcomeSchema = z.discriminatedUnion('state', [createdOutcomeSchema, unattachedOutcomeSchema])

export const RemoteErrorDetailsSchema = z
  .record(boundedKey, z.union([boundedText(HARD_LIMITS.remoteDetailsChars), z.number(), z.boolean(), z.null()]))
  .superRefine((details, ctx) => {
    if (Object.keys(details).length > 32) {
      ctx.addIssue({ code: 'custom', message: 'too many error detail fields' })
    }
  })

export const RemoteErrorSchema = z
  .object({
    code: ErrorCodeSchema,
    message: boundedText(HARD_LIMITS.diagnosticMessageChars),
    recoverable: z.boolean(),
    details: RemoteErrorDetailsSchema.optional(),
  })
  .strict()

export const DefaultParseLimitsSchema = ParseLimitsSchema
export const DefaultParseLimits = ParseLimitsSchema.parse(DEFAULT_LIMITS)
