import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { FullTrajectorySeedCompiler } from '../../src/dsh/seed.js'
import { MemoryReturnStore, ReturnSyncService } from '../../src/host/return-sync.js'
import type { ImportIndex } from '../../src/dsh/gateway.js'
import type { RepositoryInspector, SessionSource } from '../../src/shared/ports.js'
import type { ImportRecordRead, NormalizedSession, RepositoryState } from '../../src/shared/types.js'

describe('Full-import return context', () => {
  it('labels the first human message as the original goal, not the producer notice', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-return-goal-'))
    try {
      const sourceId = 'source-session-1'
      const revisionId = 'rollout-1'
      const fingerprint = 'a'.repeat(64)
      const dshSessionId = 'dsh-session-1'
      const event = (kind: string, id: string, order: number, body: object) => ({
        kind, id, order, source: { locator: `verifier:${id}` }, ...body,
      })
      const session = {
        schemaVersion: 2,
        source: { agent: 'codex', sessionId: sourceId, rolloutRevisionId: revisionId, fingerprint, cwd, archived: false },
        lineage: [{ rolloutRevisionId: revisionId, relation: 'head', representation: 'jsonl' }],
        timeline: [
          event('lifecycle', 'turn-start', 0, { lifecycle: { type: 'turn-start', turnId: 'turn-1', evidence: 'codex-turn-started' } }),
          event('lifecycle', 'step-start', 1, { lifecycle: { type: 'step-start', turnId: 'turn-1', step: 1, evidence: 'derived-response-cycle' } }),
          event('message', 'human-goal', 2, { role: 'user', text: 'Human original request: finish the integration.' }),
          event('lifecycle', 'step-end', 3, { lifecycle: { type: 'step-end', turnId: 'turn-1', step: 1, evidence: 'derived-response-cycle' } }),
          event('lifecycle', 'turn-end', 4, { lifecycle: { type: 'turn-end', turnId: 'turn-1', outcome: { kind: 'completed', evidence: 'codex-turn-complete' } } }),
        ],
        diagnostics: [],
        completeness: {
          malformedLines: 0, unknownRecords: 0, droppedEncryptedBlocks: 0,
          danglingToolCalls: 0, orphanToolResults: 0, truncatedRecords: 0,
        },
      } as NormalizedSession
      const seed = new FullTrajectorySeedCompiler({ includeNotice: true }).compile(session)
      const notice = seed.find(item => item.type === 'user/message' && (item.data as { source?: { kind?: string } }).source?.kind === 'plugin:dsh-codex-handoff')
      expect(notice).toBeDefined()
      const events = [...seed, {
        type: 'user/message', seq: seed.length, time: 2,
        data: { id: 'dsh-latest', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Current DSH instruction: report progress.' }] },
      }]
      const observation = {
        header: { id: dshSessionId, cwd, version: 4 },
        cursor: events.length - 1,
        events,
        [Symbol.dispose]: vi.fn(),
      }
      const importRecord = {
        schemaVersion: 2, state: 'created', destinationSessionId: dshSessionId, cwd,
        sourceSessionId: sourceId, sourceRolloutRevisionId: revisionId, sourceFingerprint: fingerprint, mode: 'full',
      } as unknown as ImportRecordRead
      const importIndex = { list: async () => [importRecord] } as unknown as ImportIndex
      const source: SessionSource = {
        kind: 'codex',
        discover: async () => ({ scannedAt: new Date(0).toISOString(), items: [{
          discoveryId: 'verifier-ref', source: 'codex', sessionId: sourceId, rolloutRevisionId: revisionId,
          fingerprint, archived: false, updatedAt: new Date(0).toISOString(), messageCount: 1,
          toolCallCount: 0, byteSize: 100, parseHealth: 'complete', cwd,
        }] }),
        preview: async () => { throw new Error('unused') },
        load: async () => session,
      } as SessionSource
      const repository: RepositoryInspector = {
        inspect: async (): Promise<RepositoryState> => ({
          observedAt: new Date(0).toISOString(), cwd: { requested: cwd, canonical: cwd, exists: true },
          git: {
            repoRoot: cwd, branch: 'main', detached: false, head: 'f'.repeat(40), dirty: false,
            modified: [], added: [], deleted: [], renamed: [], untracked: [], staged: [], unstaged: [], recentCommits: [],
          },
          relevantPaths: [], diagnostics: [],
        }),
      }
      const service = new ReturnSyncService({
        source, repository, importIndex,
        sessionQuery: { observeSession: async () => observation },
        store: new MemoryReturnStore(),
        now: () => new Date('2026-10-02T00:00:00.000Z'),
      })
      const preview = await service.returnPreview({ dshSessionId })
      const originalGoal = preview.context.match(/## Original goal\n+([\s\S]*?)\n+## Current user intent/)?.[1]
      expect(originalGoal).toBeDefined()
      expect(originalGoal).toContain('Human original request: finish the integration.')
      expect(originalGoal).not.toContain('Imported read-only Codex history')
      expect(preview.context).toContain('Current DSH instruction: report progress.')
      expect(observation[Symbol.dispose]).toHaveBeenCalledOnce()
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
