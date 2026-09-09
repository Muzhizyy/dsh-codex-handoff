import { describe, expect, it } from 'vitest'

import {
  AgentHandoffManifestSchema,
  AnalysisClaimSchema,
  AnalysisClaimsSchema,
  AnalysisClaimsReadSchema,
  VerificationClaimSchema,
  AnalyzeRequestSchema,
  CompatibilityViewSchema,
  CreateOutcomeSchema,
  CreateRequestSchema,
  DestinationCheckSchema,
  DefaultParseLimits,
  ExternalSessionSummarySchema,
  JsonValueSchema,
  ImportFailureSchema,
  ImportRecoveryIntentSchema,
  ImportRecordReadSchema,
  ImportRecordSchema,
  ImportRecordV1Schema,
  PreparedImportSchema,
  PluginSourceNoticeSchema,
  PluginSourceSchema,
  PluginSourceSnapshotSchema,
  RemoteErrorDetailsSchema,
  NormalizedSessionSchema,
  NormalizedSessionReadSchema,
  NormalizedSessionV1Schema,
  ParseLimitsSchema,
  SessionPageSchema,
  TokenBudgetSchema,
} from '../../src/shared/index.js'
import { boundedInteger, HARD_LIMITS, utf8ByteLength } from '../../src/shared/limits.js'
import { CodexHandoffRemoteSchemas } from '../../src/shared/remote.js'

const at = '2026-09-05T00:00:00.000Z'

const source = {
  id: 'conversation-1',
  kind: 'conversation' as const,
  locator: 'rollout:0',
  confidence: 'high' as const,
  redacted: true,
}

const text = { text: 'Inspect the current task.', sourceIds: [source.id], confidence: 'high' as const }

function manifest() {
  return {
    schemaVersion: '1.0.0' as const,
    generatedAt: at,
    mode: 'smart' as const,
    source: {
      agent: 'codex' as const,
      sessionId: 'thread-1',
      rolloutRevisionId: 'rollout-1',
      fingerprint: 'sha256-' + 'a'.repeat(64),
    },
    objective: text,
    workspace: { cwd: 'C:\\work\\demo' },
    progress: { completed: [], inProgress: [], blocked: [] },
    decisions: [],
    failedAttempts: [],
    currentProblems: [],
    relevantFiles: [],
    repositoryChanges: {
      modified: [],
      added: [],
      deleted: [],
      renamed: [],
      untracked: [],
      staged: [],
      unstaged: [],
    },
    verification: {
      commandsRun: [],
      testsPassed: [],
      testsFailed: [],
      latestStatus: 'unknown' as const,
    },
    constraints: [],
    openQuestions: [],
    nextActions: [],
    provenance: [source],
    completeness: {
      malformedLines: 0,
      unknownRecords: 0,
      droppedEncryptedBlocks: 0,
      danglingToolCalls: 0,
      orphanToolResults: 0,
      truncatedRecords: 0,
      analyzer: 'deterministic-fallback' as const,
      omittedByBudget: {},
    },
    diagnostics: [],
  }
}

describe('shared runtime contracts', () => {
  it('accepts a bounded discovery summary and rejects unknown fields', () => {
    const summary = {
      discoveryId: 'opaque-1',
      source: 'codex' as const,
      sessionId: 'thread-1',
      rolloutRevisionId: 'rollout-1',
      fingerprint: 'sha256-' + 'a'.repeat(64),
      updatedAt: at,
      archived: false,
      messageCount: 2,
      toolCallCount: 0,
      byteSize: 100,
      parseHealth: 'complete' as const,
    }
    expect(ExternalSessionSummarySchema.parse(summary)).toEqual(summary)
    expect(() => ExternalSessionSummarySchema.parse({ ...summary, path: 'secret' })).toThrow()
    expect(SessionPageSchema.parse({ items: [summary], scannedAt: at })).toMatchObject({ items: [summary] })
  })

  it('accepts a normalized event stream with bounded source references', () => {
    const normalized = {
      schemaVersion: 2 as const,
      source: {
        agent: 'codex' as const,
        sessionId: 'thread-1',
        rolloutRevisionId: 'rollout-1',
        fingerprint: 'sha256-' + 'a'.repeat(64),
        archived: false,
      },
      lineage: [{ rolloutRevisionId: 'rollout-1', relation: 'head' as const, representation: 'jsonl' as const }],
      timeline: [
        {
          kind: 'lifecycle' as const,
          id: 'boundary-1',
          order: 0,
          lifecycle: { type: 'turn-start' as const, turnId: 'turn-1', evidence: 'codex-turn-started' as const },
          source: { locator: 'line:1', line: 1 },
        },
        {
          kind: 'lifecycle' as const,
          id: 'boundary-2',
          order: 1,
          lifecycle: { type: 'step-start' as const, turnId: 'turn-1', step: 1, evidence: 'derived-response-cycle' as const },
          source: { locator: 'line:2', line: 2 },
        },
        {
          kind: 'message' as const,
          id: 'event-1',
          order: 2,
          role: 'user' as const,
          text: 'Continue.',
          source: { locator: 'line:3', line: 3 },
        },
        {
          kind: 'lifecycle' as const,
          id: 'boundary-3',
          order: 3,
          lifecycle: { type: 'step-end' as const, turnId: 'turn-1', step: 1, evidence: 'derived-response-cycle' as const },
          source: { locator: 'line:4', line: 4 },
        },
        {
          kind: 'lifecycle' as const,
          id: 'boundary-4',
          order: 4,
          lifecycle: { type: 'turn-end' as const, turnId: 'turn-1', outcome: { kind: 'completed' as const, evidence: 'codex-turn-complete' as const } },
          source: { locator: 'line:5', line: 5 },
        },
      ],
      diagnostics: [],
      completeness: {
        malformedLines: 0,
        unknownRecords: 0,
        droppedEncryptedBlocks: 0,
        danglingToolCalls: 0,
        orphanToolResults: 0,
        truncatedRecords: 0,
      },
    }
    expect(NormalizedSessionSchema.parse(normalized)).toEqual(normalized)
    expect(() => NormalizedSessionSchema.parse({ ...normalized, schemaVersion: 1 })).toThrow()

    const v1 = {
      ...normalized,
      schemaVersion: 1 as const,
      timeline: [{ kind: 'message' as const, id: 'legacy-event', order: 0, role: 'user' as const, text: 'Legacy', source: { locator: 'line:1', line: 1 } }],
    }
    expect(NormalizedSessionV1Schema.parse(v1)).toEqual(v1)
    expect(NormalizedSessionReadSchema.parse(v1)).toEqual(v1)
  })

  it('enforces v2 lifecycle brackets, ordering, calls, and rollback boundaries', () => {
    const base = {
      schemaVersion: 2 as const,
      source: { agent: 'codex' as const, sessionId: 'thread-1', rolloutRevisionId: 'rollout-1', fingerprint: 'sha256-' + 'a'.repeat(64), archived: false },
      lineage: [{ rolloutRevisionId: 'rollout-1', relation: 'head' as const, representation: 'jsonl' as const }],
      diagnostics: [],
      completeness: { malformedLines: 0, unknownRecords: 0, droppedEncryptedBlocks: 0, danglingToolCalls: 0, orphanToolResults: 0, truncatedRecords: 0 },
    }
    const lifecycle = (lifecycle: Record<string, unknown>, order: number) => ({ kind: 'lifecycle' as const, id: `boundary-${order}`, order, lifecycle, source: { locator: `line:${order + 1}` } })
    const validTimeline = [
      lifecycle({ type: 'turn-start', turnId: 'turn-1', evidence: 'derived-user-boundary' }, 0),
      lifecycle({ type: 'step-start', turnId: 'turn-1', step: 1, evidence: 'derived-response-cycle' }, 1),
      { kind: 'tool-call' as const, id: 'call-event', order: 2, callId: 'call-1', name: 'inspect', argumentsText: '{}', source: { locator: 'line:3' } },
      { kind: 'tool-result' as const, id: 'result-event', order: 3, callId: 'call-1', content: 'ok', source: { locator: 'line:4' } },
      lifecycle({ type: 'step-end', turnId: 'turn-1', step: 1, evidence: 'derived-response-cycle' }, 4),
      lifecycle({ type: 'turn-end', turnId: 'turn-1', outcome: { kind: 'completed', evidence: 'codex-turn-complete' } }, 5),
      lifecycle({ type: 'rollback', removedUserTurns: 1, removedBoundaryIds: ['boundary-0'], evidence: 'codex-thread-rolled-back' }, 6),
    ]
    expect(NormalizedSessionSchema.parse({ ...base, timeline: validTimeline })).toMatchObject({ schemaVersion: 2 })
    expect(() => NormalizedSessionSchema.parse({ ...base, timeline: validTimeline.slice(0, 5).concat([validTimeline[6]!]) })).toThrow(/turn-end|bracket/i)
    expect(() => NormalizedSessionSchema.parse({ ...base, timeline: validTimeline.map((event, index) => index === 2 ? { ...event, order: 9 } : event) })).toThrow(/order/i)
    expect(() => NormalizedSessionSchema.parse({ ...base, timeline: validTimeline.map((event, index) => index === 4 ? { ...event, lifecycle: { ...(event as { lifecycle: Record<string, unknown> }).lifecycle, step: 2 } } : event) })).toThrow(/step/i)
    expect(() => NormalizedSessionSchema.parse({ ...base, timeline: validTimeline.map((event, index) => index === 3 ? { ...event, kind: 'lifecycle' as const, lifecycle: { type: 'step-end', turnId: 'turn-1', step: 1, evidence: 'derived-response-cycle' }, source: { locator: 'line:4' } } : event) })).toThrow(/dangling|call/i)
    expect(() => NormalizedSessionSchema.parse({ ...base, timeline: validTimeline.map((event, index) => index === 6 ? { ...event, lifecycle: { type: 'rollback', removedUserTurns: 2, removedBoundaryIds: ['boundary-0'], evidence: 'codex-thread-rolled-back' } } : event) })).toThrow(/boundary count/i)
    expect(() => NormalizedSessionSchema.parse({ ...base, timeline: [{ ...validTimeline[0], lifecycle: { type: 'turn-start', turnId: 'turn-1', evidence: 'bad' } }] })).toThrow()
  })

  it('enforces provenance closure and inference confidence', () => {
    expect(AgentHandoffManifestSchema.parse(manifest())).toMatchObject({ schemaVersion: '1.0.0' })
    expect(() => AgentHandoffManifestSchema.parse({ ...manifest(), objective: { ...text, sourceIds: ['missing'] } })).toThrow(
      /provenance/i,
    )
    expect(() =>
      AgentHandoffManifestSchema.parse({
        ...manifest(),
        provenance: [{ ...source, kind: 'inferred', confidence: 'high' }],
      }),
    ).toThrow(/confidence/i)
  })

  it('validates provenance for every manifest section and bounded diagnostics', () => {
    const item = { ...text, id: 'item-1', status: 'completed' as const }
    const decision = { ...text, id: 'decision-1', status: 'active' as const, rationale: 'The evidence supports it.' }
    const failed = { ...text, id: 'failed-1', currentRepoPresence: false as const, reason: 'The approach was reverted.' }
    const problem = { ...text, id: 'problem-1', severity: 'non-blocking' as const }
    const file = { ...text, path: 'src/index.ts', exists: true, change: 'modified' }
    const command = { ...text, commandSummary: 'test', result: 'passed' as const, at }
    const verification = { ...text, name: 'unit tests', at }
    const action = { ...text, id: 'action-1', priority: 1, requiresVerification: true }
    const value = {
      ...manifest(),
      progress: { completed: [item], inProgress: [item], blocked: [item] },
      decisions: [decision],
      failedAttempts: [failed],
      currentProblems: [problem],
      relevantFiles: [file],
      verification: { commandsRun: [command], testsPassed: [verification], testsFailed: [verification], latestStatus: 'mixed' as const, buildStatus: 'passing' as const },
      constraints: [text],
      openQuestions: [text],
      nextActions: [action],
    }
    expect(AgentHandoffManifestSchema.parse(value)).toMatchObject({ progress: { completed: [item] } })
    expect(() => AgentHandoffManifestSchema.parse({ ...value, completeness: { ...value.completeness, omittedByBudget: Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`section-${index}`, 1])) } })).toThrow()
    expect(() => RemoteErrorDetailsSchema.parse(Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`key-${index}`, true])))).toThrow()
    expect(() => AgentHandoffManifestSchema.parse({ ...value, provenance: [source, source] })).toThrow(/unique/i)
    expect(() => AgentHandoffManifestSchema.parse({
      ...manifest(),
      repositoryChanges: {
        ...manifest().repositoryChanges,
        modified: Array.from({ length: 9_999 }, (_, index) => `src/modified-${index}.ts`),
        added: ['src/added.ts'],
      },
    })).toThrow(/aggregate item/i)
    const oneMegabyte = 'r'.repeat(1024 * 1024)
    const largeDecisions = Array.from({ length: 17 }, (_, index) => ({
      ...decision,
      id: `large-decision-${index}`,
      rationale: oneMegabyte,
    }))
    expect(() => AgentHandoffManifestSchema.parse({ ...value, decisions: largeDecisions })).toThrow(/aggregate UTF-8/i)
    expect(() => AgentHandoffManifestSchema.parse({ ...value, decisions: [{ ...decision, rationale: 'r'.repeat(1024 * 1024 + 1) }] })).toThrow(/UTF-8|bytes/i)
    expect(() => AgentHandoffManifestSchema.parse({ ...value, failedAttempts: [{ ...failed, reason: 'r'.repeat(1024 * 1024 + 1) }] })).toThrow(/UTF-8|bytes/i)
    expect(() => AgentHandoffManifestSchema.parse({ ...value, provenance: [{ ...source, locator: 'r'.repeat(4_097) }] })).toThrow(/UTF-8|bytes/i)
  })

  it('validates AnalysisClaims provenance closure, aggregate limits and inference confidence', () => {
    const work = { ...text, id: 'claim-work', status: 'in-progress' as const }
    const decision = { ...text, id: 'claim-decision', status: 'active' as const }
    const failed = { ...text, id: 'claim-failed', currentRepoPresence: 'unknown' as const }
    const problem = { ...text, id: 'claim-problem', severity: 'unknown' as const }
    const file = { ...text, path: 'src/index.ts', exists: true }
    const command = { ...text, commandSummary: 'test', result: 'unknown' as const }
    const verification = { ...text, name: 'tests' }
    const action = { ...text, id: 'claim-action', priority: 1 }
    const valid = {
      schemaVersion: 1 as const,
      objective: text,
      completed: [work],
      inProgress: [work],
      blocked: [work],
      decisions: [decision],
      failedAttempts: [failed],
      currentProblems: [problem],
      relevantFiles: [file],
      commandsRun: [command],
      testsPassed: [verification],
      testsFailed: [verification],
      constraints: [text],
      openQuestions: [text],
      nextActions: [action],
      provenance: [source],
    }
      expect(AnalysisClaimsSchema.parse(valid)).toMatchObject({ schemaVersion: 1, completed: [work] })
    expect(() => AnalysisClaimsSchema.parse({ ...valid, objective: { ...text, sourceIds: ['missing'] } })).toThrow(/provenance/i)
    expect(() => AnalysisClaimsSchema.parse({ ...valid, provenance: [{ ...source, kind: 'inferred', confidence: 'high' }] })).toThrow(/confidence/i)
    expect(() => AnalysisClaimsSchema.parse({ ...valid, provenance: [source, source] })).toThrow(/unique/i)
    const largeText = 'é'.repeat(500_000)
    const largeItem = { ...text, text: largeText, id: 'large', status: 'completed' as const }
    expect(() => AnalysisClaimsSchema.parse({ ...valid, completed: Array.from({ length: 17 }, () => ({ ...largeItem, id: 'large' })) })).toThrow(/byte/i)
    const oneMegabyte = 'r'.repeat(1024 * 1024)
    const largeDecisions = Array.from({ length: 17 }, (_, index) => ({
      ...decision,
      id: `large-claim-decision-${index}`,
      rationale: oneMegabyte,
    }))
    expect(() => AnalysisClaimsSchema.parse({ ...valid, decisions: largeDecisions })).toThrow(/aggregate UTF-8/i)
  })

  it('requires v2 analysis/verification recency fields on one global order and keeps v1 readable', () => {
    const recency = { scope: 'session:source-1', order: 0, timestamp: at }
    const analysisClaim = { ...text, ...recency }
    const verificationClaim = { ...text, name: 'pnpm check', ...recency }
    expect(AnalysisClaimSchema.parse(analysisClaim)).toMatchObject(recency)
    expect(VerificationClaimSchema.parse(verificationClaim)).toMatchObject(recency)

    const validV2 = {
      schemaVersion: 2 as const,
      objective: analysisClaim,
      provenance: [source],
    }
    expect(AnalysisClaimsSchema.parse(validV2)).toMatchObject({ schemaVersion: 2, objective: analysisClaim })
    expect(AnalysisClaimsReadSchema.parse({ schemaVersion: 1, provenance: [] })).toMatchObject({ schemaVersion: 1 })
    expect(() => AnalysisClaimsSchema.parse({ ...validV2, objective: { ...analysisClaim, scope: undefined } })).toThrow(/scope/i)
    expect(() => AnalysisClaimsSchema.parse({ ...validV2, objective: { ...analysisClaim, timestamp: 'not-a-time' } })).toThrow(/timestamp/i)
    expect(() => AnalysisClaimsSchema.parse({
      ...validV2,
      constraints: [{ ...analysisClaim, order: 0 }],
    })).toThrow(/duplicated|global/i)
    expect(() => AnalysisClaimsSchema.parse({
      ...validV2,
      constraints: [{ ...analysisClaim, order: 2 }],
    })).toThrow(/continuous|global/i)
  })

  it('uses UTF-8 byte limits and only accepts recursive JSON values for seeds', () => {
    const unicode = '🙂'.repeat(10)
    expect(utf8ByteLength(unicode)).toBe(40)
    expect(() => JsonValueSchema.parse(undefined)).toThrow()
    expect(JsonValueSchema.parse({ nested: ['ok', 1, true, null] })).toEqual({ nested: ['ok', 1, true, null] })
    const sourceRef = { discoveryId: 'opaque-1', source: 'codex' as const, sessionId: 'thread-1', rolloutRevisionId: 'rollout-1' }
    const seed = [{ type: 'user/message', text: unicode }]
    const bytes = utf8ByteLength(JSON.stringify(seed))
    const prepared = {
      identity: { key: 'a'.repeat(64), destinationSessionId: 'session-codex-handoff-' + 'a'.repeat(32) },
      source: sourceRef,
      sourceFingerprint: 'sha256-' + 'a'.repeat(64),
      mode: 'full' as const,
      cwd: 'C:\\work\\demo',
      seed,
      seedBytes: bytes,
      totalBytes: bytes,
    }
    expect(PreparedImportSchema.parse(prepared)).toMatchObject({ seedBytes: bytes, totalBytes: bytes })
    expect(() => PreparedImportSchema.parse({ ...prepared, seedBytes: bytes + 1 })).toThrow(/seedBytes/i)
    expect(() => PreparedImportSchema.parse({ ...prepared, totalBytes: bytes + 1 })).toThrow(/totalBytes/i)
    expect(() => PreparedImportSchema.parse({ ...prepared, seedBytes: bytes + 1, totalBytes: bytes + 2 })).toThrow(/agree|seedBytes/i)
    expect(() => JsonValueSchema.parse({ unsupported: undefined })).toThrow()
  })

  it('uses the v2 import saga union and keeps v1 read-only', () => {
    const key = 'a'.repeat(64)
    const destinationSessionId = 'session-codex-handoff-' + 'a'.repeat(32)
    const fingerprint = 'sha256-' + 'b'.repeat(64)
    const base = {
      schemaVersion: 2 as const,
      key,
      sourceSessionId: 'thread-1',
      sourceRolloutRevisionId: 'rollout-1',
      sourceFingerprint: fingerprint,
      mode: 'full' as const,
      cwd: 'C:\\work\\demo',
      destinationSessionId,
      sourceFingerprintBefore: fingerprint,
      attemptId: 'attempt-1',
      createdAt: at,
      updatedAt: at,
    }
    const absent = { status: 'absent' as const, checkedAt: at }
    const present = {
      status: 'verified' as const,
      checkedAt: at,
      via: 'session-query' as const,
      cwd: 'C:\\work\\demo',
      sourceSessionId: 'thread-1',
      sourceRolloutRevisionId: 'rollout-1',
      sourceFingerprint: fingerprint,
      mode: 'full' as const,
      compilerSchema: '1.0.0',
    }
    const failure = { phase: 'agent-create' as const, code: 'DSH_SEED_INVALID', recoverable: true, at }
    expect(DestinationCheckSchema.parse(absent)).toEqual(absent)
    expect(DestinationCheckSchema.parse(present)).toEqual(present)
    expect(ImportFailureSchema.parse(failure)).toEqual(failure)
    expect(ImportRecordSchema.parse({ ...base, state: 'prepared' as const })).toMatchObject({ state: 'prepared' })
    expect(ImportRecordSchema.parse({ ...base, state: 'creating' as const, createStartedAt: at })).toMatchObject({ state: 'creating' })
    expect(ImportRecordSchema.parse({ ...base, state: 'created' as const, createStartedAt: at, sourceFingerprintAfter: fingerprint, destination: present })).toMatchObject({ state: 'created' })
    expect(ImportRecordSchema.parse({ ...base, state: 'created_unattached' as const, createStartedAt: at, sourceFingerprintAfter: fingerprint, destination: present, failure: { ...failure, phase: 'workspace-attach' as const } })).toMatchObject({ state: 'created_unattached' })
    expect(ImportRecordSchema.parse({ ...base, state: 'failed' as const, destination: absent, failure })).toMatchObject({ state: 'failed' })
    expect(ImportRecordSchema.parse({ ...base, state: 'orphaned' as const, destination: { status: 'unknown', reason: 'query-unavailable', checkedAt: at }, failure })).toMatchObject({ state: 'orphaned' })
    expect(() => ImportRecordSchema.parse({ ...base, state: 'creating' })).toThrow(/createStartedAt|Required/i)
    expect(() => ImportRecordSchema.parse({ ...base, state: 'created', createStartedAt: at, destination: present })).toThrow(/fingerprintAfter|Required/i)
    expect(() => ImportRecordSchema.parse({ ...base, state: 'created', createStartedAt: at, sourceFingerprintAfter: fingerprint, destination: absent })).toThrow()
    expect(() => ImportRecordSchema.parse({ ...base, state: 'failed', destination: absent })).toThrow(/failure|Required/i)
    expect(() => ImportRecordSchema.parse({ ...base, state: 'created_unattached', createStartedAt: at, sourceFingerprintAfter: fingerprint, destination: present, failure })).toThrow(/workspace-attach/i)

    const v1 = {
      schemaVersion: 1 as const,
      key,
      sourceSessionId: 'thread-1',
      sourceRolloutRevisionId: 'rollout-1',
      sourceFingerprint: fingerprint,
      mode: 'smart' as const,
      cwd: 'C:\\work\\demo',
      destinationSessionId,
      state: 'prepared' as const,
      sourceFingerprintBefore: fingerprint,
      attemptId: 'attempt-1',
      createdAt: at,
      updatedAt: at,
    }
    expect(ImportRecordV1Schema.parse(v1)).toEqual(v1)
    expect(ImportRecordReadSchema.parse(v1)).toEqual(v1)
    expect(() => ImportRecordSchema.parse(v1)).toThrow()
  })

  it('bounds Smart recovery artifacts independently and enforces mode/byte invariants', () => {
    const key = 'a'.repeat(64)
    const fingerprint = 'sha256-' + 'b'.repeat(64)
    const sourceRef = { discoveryId: 'opaque-1', source: 'codex' as const, sessionId: 'thread-1', rolloutRevisionId: 'rollout-1', expectedFingerprint: fingerprint, archived: false }
    const seed = [{ type: 'user/message', data: { text: 'exact replay' } }]
    const seedBytes = utf8ByteLength(JSON.stringify(seed))
    const recovery = {
      source: sourceRef,
      seedDigest: 'c'.repeat(64),
      seedBytes,
      seed,
      cwdIdentity: { device: 'dev', inode: 'ino' },
    }
    const base = {
      schemaVersion: 2 as const,
      key,
      sourceSessionId: 'thread-1',
      sourceRolloutRevisionId: 'rollout-1',
      sourceFingerprint: fingerprint,
      mode: 'smart' as const,
      cwd: 'C:\\work\\demo',
      destinationSessionId: 'session-codex-handoff-' + 'a'.repeat(32),
      sourceFingerprintBefore: fingerprint,
      attemptId: 'attempt-1',
      createdAt: at,
      updatedAt: at,
      recovery,
    }
    expect(ImportRecoveryIntentSchema.parse(recovery)).toMatchObject({ seedBytes, seed })
    expect(ImportRecordSchema.parse({ ...base, state: 'prepared' as const })).toMatchObject({ state: 'prepared' })
    expect(() => ImportRecoveryIntentSchema.parse({ ...recovery, seedBytes: seedBytes + 1 })).toThrow(/seedBytes/i)
    expect(() => ImportRecordSchema.parse({ ...base, mode: 'full' as const, state: 'prepared' as const })).toThrow(/Full recovery/i)
    expect(() => ImportRecordSchema.parse({ ...base, mode: 'full' as const, recovery: { ...recovery, seed: undefined, targetTokens: 4096 }, state: 'prepared' as const })).toThrow(/targetTokens/i)
    expect(() => ImportRecordSchema.parse({ ...base, mode: 'full' as const, recovery: { ...recovery, seed: undefined, useModel: true }, state: 'prepared' as const })).toThrow(/useModel/i)
    expect(() => ImportRecordSchema.parse({ ...base, recovery: { ...recovery, seed: undefined }, state: 'creating' as const, createStartedAt: at })).toThrow(/require an exact durable seed/i)
    const oversizedSeed = [{ payload: 'x'.repeat(HARD_LIMITS.recoveryArtifactBytes) }]
    expect(() => ImportRecoveryIntentSchema.parse({ ...recovery, seed: oversizedSeed, seedBytes: utf8ByteLength(JSON.stringify(oversizedSeed)) })).toThrow(/durable artifact/i)

    const fullSeed = [{ payload: 'x'.repeat(HARD_LIMITS.recoveryArtifactBytes + 32) }]
    const fullSeedBytes = utf8ByteLength(JSON.stringify(fullSeed))
    expect(fullSeedBytes).toBeGreaterThan(HARD_LIMITS.recoveryArtifactBytes)
    expect(fullSeedBytes).toBeLessThanOrEqual(HARD_LIMITS.seedEventBytes)
    const fullRecovery = { ...recovery, seed: undefined, seedBytes: fullSeedBytes, targetTokens: undefined, useModel: undefined }
    expect(ImportRecoveryIntentSchema.parse(fullRecovery)).toMatchObject({ seedBytes: fullSeedBytes })
    expect(ImportRecordSchema.parse({ ...base, mode: 'full' as const, recovery: fullRecovery, state: 'prepared' as const })).toMatchObject({ state: 'prepared' })
    const preparedFull = {
      identity: { key, destinationSessionId: 'session-codex-handoff-' + 'a'.repeat(32) },
      source: sourceRef,
      sourceFingerprint: fingerprint,
      mode: 'full' as const,
      cwd: 'C:\\work\\demo',
      seed: fullSeed,
      seedBytes: fullSeedBytes,
      totalBytes: fullSeedBytes,
    }
    expect(PreparedImportSchema.parse(preparedFull)).toMatchObject({ mode: 'full', seedBytes: fullSeedBytes })
    expect(() => ImportRecordSchema.parse({ ...base, mode: 'smart' as const, recovery: { ...fullRecovery }, state: 'prepared' as const })).toThrow(/exact durable seed|recovery artifact/i)
  })

  it('binds Remote schemas to the method registry and strict source forms', () => {
    expect(Object.keys(CodexHandoffRemoteSchemas)).toEqual(['compatibility', 'discover', 'preview', 'analyze', 'create'])
    expect(Object.keys(CodexHandoffRemoteSchemas.compatibility)).toEqual(['response'])
    expect(Object.keys(CodexHandoffRemoteSchemas.create)).toEqual(['request', 'response'])
    const metadata = {
      kind: 'plugin' as const,
      plugin: 'dsh-codex-handoff' as const,
      sourceAgent: 'codex' as const,
      sourceSessionId: 'thread-1',
      rolloutRevisionId: 'rollout-1',
      fingerprint: 'sha256-' + 'a'.repeat(64),
      mode: 'full' as const,
      compilerSchema: '1.0.0' as const,
    }
    expect(PluginSourceNoticeSchema.parse({ ...metadata, form: 'notice', summary: 'Imported Codex context.' })).toMatchObject({ form: 'notice' })
    expect(PluginSourceSnapshotSchema.parse({ ...metadata, form: 'snapshot', sections: [{ name: 'Objective', text: 'Do the work.' }] })).toMatchObject({ form: 'snapshot' })
    expect(PluginSourceSchema.safeParse({ ...metadata, form: 'notice' }).success).toBe(false)
    expect(PluginSourceSchema.safeParse({ ...metadata, form: 'notice', sections: [], summary: 'Imported.' }).success).toBe(false)
    expect(PluginSourceSchema.safeParse({ ...metadata, form: 'snapshot', sections: [{ heading: 'Objective', text: 'Do the work.' }] }).success).toBe(false)
    expect(PluginSourceSchema.safeParse({ ...metadata, form: 'snapshot' }).success).toBe(false)
    expect(PluginSourceSchema.safeParse({ ...metadata, form: 'notice', summary: 'é'.repeat(61) }).success).toBe(false)
    expect(PluginSourceSchema.safeParse({ ...metadata, form: 'notice', summary: 'é'.repeat(60) }).success).toBe(true)
  })

  it('models the SPEC required/optional compatibility capabilities without overlap', () => {
    const value = {
      compatible: true,
      dshVersion: '0.1.2-rc.1',
      observedSessionFormat: 2,
      required: {
        agents: true,
        agentDefaultModel: true,
        sessionQuery: true,
        sessionPersistence: true,
        workspaceRegistry: true,
        storageDomain: true,
        typert: true,
      },
      optional: {
        llm: true,
        agentPresets: true,
        conversationSessionHeaderActions: false,
        settingsSection: false,
      },
      diagnostics: [],
      checkedAt: at,
    }
    expect(CompatibilityViewSchema.parse(value)).toEqual(value)
    expect(CompatibilityViewSchema.safeParse({ ...value, required: { ...value.required, typert: undefined } }).success).toBe(false)
    expect(CompatibilityViewSchema.safeParse({ ...value, required: { ...value.required, llm: true } }).success).toBe(false)
    expect(CompatibilityViewSchema.safeParse({ ...value, optional: { ...value.optional, agents: false } }).success).toBe(false)
  })

  it('binds AnalyzeRequest useModel to disclosure and consent.modelAnalysis', () => {
    const base = {
      source: { discoveryId: 'opaque-1', source: 'codex' as const, sessionId: 'thread-1', rolloutRevisionId: 'rollout-1' },
      cwd: 'C:\\work\\demo',
      expectedFingerprint: 'sha256-' + 'a'.repeat(64),
    }
    expect(AnalyzeRequestSchema.parse({
      ...base,
      targetTokens: 64_000,
      useModel: true as const,
      consent: { disclosureVersion: 'smart-v1', accepted: true as const, acceptedMode: 'smart' as const, modelAnalysis: true as const, fullPersistence: false as const },
    })).toMatchObject({ useModel: true, targetTokens: 64_000 })
    expect(TokenBudgetSchema.parse({})).toEqual({})
    expect(TokenBudgetSchema.parse({ targetTokens: 1_000_000 })).toEqual({ targetTokens: 1_000_000 })
    expect(() => AnalyzeRequestSchema.parse({
      ...base,
      useModel: true as const,
      consent: { disclosureVersion: 'smart-v1', accepted: true as const, acceptedMode: 'smart' as const, modelAnalysis: false as const, fullPersistence: false as const },
    })).toThrow()
    expect(() => AnalyzeRequestSchema.parse({
      ...base,
      useModel: false as const,
      consent: { disclosureVersion: 'full-v1', accepted: true as const, acceptedMode: 'full' as const, modelAnalysis: false as const, fullPersistence: true as const },
    })).toThrow()
  })

  it('keeps parser limit defaults within the hard maximum', () => {
    expect(ParseLimitsSchema.parse(DefaultParseLimits)).toEqual(DefaultParseLimits)
    expect(() => ParseLimitsSchema.parse({ ...DefaultParseLimits, lineBytes: 9 * 1024 * 1024 })).toThrow()
  })

  it('requires mode-matched consent and rejects mode-specific option mixing', () => {
    const base = {
      source: {
        discoveryId: 'opaque-1',
        source: 'codex' as const,
        sessionId: 'thread-1',
        rolloutRevisionId: 'rollout-1',
      },
      mode: 'smart' as const,
      cwd: 'C:\\work\\demo',
      expectedFingerprint: 'sha256-' + 'a'.repeat(64),
      consent: { disclosureVersion: 'smart-v1', accepted: true as const, acceptedMode: 'smart' as const, modelAnalysis: false, fullPersistence: false },
      smart: { targetTokens: 6000, useModel: false },
    }
    expect(CreateRequestSchema.parse(base)).toMatchObject({ mode: 'smart' })
    expect(() => CreateRequestSchema.parse({ ...base, consent: { ...base.consent, acceptedMode: 'full' } })).toThrow()
    expect(() => CreateRequestSchema.parse({ ...base, full: { confirmedLarge: true } })).toThrow()
    expect(() => CreateRequestSchema.parse({ ...base, consent: { disclosureVersion: 'full-v1', accepted: true as const, acceptedMode: 'full' as const, modelAnalysis: false as const, fullPersistence: true as const } })).toThrow()
    expect(() => CreateRequestSchema.parse({ ...base, smart: { targetTokens: 6000, useModel: true as const }, consent: { ...base.consent, modelAnalysis: false as const } })).toThrow(/modelAnalysis/i)
    expect(CreateRequestSchema.parse({ source: base.source, mode: 'full', cwd: base.cwd, expectedFingerprint: base.expectedFingerprint, consent: { disclosureVersion: 'full-v1', accepted: true as const, acceptedMode: 'full' as const, modelAnalysis: false, fullPersistence: true }, full: { confirmedLarge: true } })).toMatchObject({ mode: 'full' })
    expect(() => CreateRequestSchema.parse({ ...base, source: { ...base.source, expectedFingerprint: 'sha256-' + 'b'.repeat(64) } })).toThrow()
    expect(() => CreateRequestSchema.parse({ source: { ...base.source, expectedFingerprint: 'sha256-' + 'b'.repeat(64) }, mode: 'full' as const, cwd: base.cwd, expectedFingerprint: base.expectedFingerprint, consent: { disclosureVersion: 'full-v1', accepted: true as const, acceptedMode: 'full' as const, modelAnalysis: false as const, fullPersistence: true as const }, full: {} })).toThrow(/fingerprint/i)
  })

  it('accepts only the explicit partial-success outcome shape', () => {
    expect(
      CreateOutcomeSchema.parse({
        state: 'created_unattached',
        sessionId: 'session-codex-handoff-' + 'a'.repeat(32),
        workspaceAttached: false,
        warnings: [],
      }),
    ).toMatchObject({ state: 'created_unattached' })
    expect(() =>
      CreateOutcomeSchema.parse({
        state: 'created_unattached',
        sessionId: 'session-codex-handoff-' + 'a'.repeat(32),
        workspaceAttached: true,
        warnings: [],
      }),
    ).toThrow()
  })

  it('clamps caller-provided limits without allowing negative or oversized values', () => {
    expect(boundedInteger(12, 'lineBytes')).toBe(12)
    expect(boundedInteger(HARD_LIMITS.lineBytes + 1, 'lineBytes')).toBe(HARD_LIMITS.lineBytes)
    expect(boundedInteger(-1, 'lineBytes')).toBeGreaterThan(0)
  })
})
