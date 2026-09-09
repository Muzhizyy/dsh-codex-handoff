import { describe, expect, it, vi } from 'vitest'

import { ImportIdentitySchema, PreparedImportSchema } from '../../src/shared/index.js'
import {
  DshSessionGateway,
  StorageDomainImportIndex,
  IMPORT_LEDGER,
  createStorageDomainImportIndex,
  MemoryImportIndex,
  computeImportIdentity,
  sha256Hex,
  type DshGatewayRuntime,
} from '../../src/dsh/index.js'
import { MINIMAL_DSH_SEED } from '../fixtures/dsh/minimal-seed.js'

function prepared(mode: 'smart' | 'full' = 'full') {
  const source = {
    discoveryId: 'discovery-1',
    source: 'codex' as const,
    sessionId: 'source-session-1',
    rolloutRevisionId: 'rollout-1',
    expectedFingerprint: 'fingerprint-123456',
  }
  const identity = computeImportIdentity({ source, mode, cwd: 'C:\\workspace' })
  return PreparedImportSchema.parse({
    identity,
    source,
    sourceFingerprint: source.expectedFingerprint,
    mode,
    cwd: 'C:\\workspace',
    seed: MINIMAL_DSH_SEED,
    cwdIdentity: { device: 'test-device', inode: 'test-inode' },
  })
}

function preparedWithProvenance(mode: 'smart' | 'full') {
  const base = prepared(mode)
  const sourceSessionId = '123e4567-e89b-12d3-a456-426614174000'
  const rolloutRevisionId = '550e8400-e29b-41d4-a716-446655440000'
  const source = { ...base.source, sessionId: sourceSessionId, rolloutRevisionId }
  const pluginSource = mode === 'full'
    ? {
        kind: 'plugin' as const,
        plugin: 'dsh-threadbridge' as const,
        sourceAgent: 'codex' as const,
        sourceSessionId,
        rolloutRevisionId,
        fingerprint: base.source.expectedFingerprint,
        mode: 'full' as const,
        compilerSchema: '1.0.0' as const,
        form: 'notice' as const,
        summary: 'Imported read-only Codex history; historical tools were not executed.',
      }
    : {
        kind: 'plugin' as const,
        plugin: 'dsh-threadbridge' as const,
        sourceAgent: 'codex' as const,
        sourceSessionId,
        rolloutRevisionId,
        fingerprint: base.source.expectedFingerprint,
        mode: 'smart' as const,
        compilerSchema: '1.0.0' as const,
        form: 'snapshot' as const,
        sections: [{ name: 'Objective', text: 'Bearer gateway-secret AKIA1234567890ABCDEF' }],
      }
  const identity = computeImportIdentity({ source, mode, cwd: base.cwd })
  return PreparedImportSchema.parse({
    ...base,
    source,
    identity,
    seed: [{
      type: 'user/message',
      seq: 0,
      time: 0,
      data: {
        id: 'gateway-provenance-test',
        role: 'user',
        content: [{ type: 'text', text: 'Bearer gateway-secret AKIA1234567890ABCDEF' }],
        source: pluginSource,
      },
      surfaceOp: 'append',
    }],
  })
}

function runtime(
  overrides: Record<string, unknown> = {},
  sourceMode: 'smart' | 'full' = 'full',
  sourceIdentity: { readonly sessionId: string; readonly rolloutRevisionId: string; readonly fingerprint: string } = {
    sessionId: 'source-session-1',
    rolloutRevisionId: 'rollout-1',
    fingerprint: 'fingerprint-123456',
  },
) {
  const created = new Set<string>()
  const mounted: string[] = []
  const sessions = new Map<string, unknown>()
  const create = vi.fn(async (options: {
    readonly sessionId: string
    readonly meta: { readonly cwd: string; readonly agentPreset?: string }
    readonly setup?: (ctx: unknown) => Promise<void> | void
  }) => {
    const candidate = options
    created.add(candidate.sessionId)
    await candidate.setup?.({})
    const pluginSource = sourceMode === 'smart'
      ? {
          kind: 'plugin', plugin: 'dsh-threadbridge', sourceAgent: 'codex',
          sourceSessionId: sourceIdentity.sessionId, rolloutRevisionId: sourceIdentity.rolloutRevisionId,
          fingerprint: sourceIdentity.fingerprint, mode: sourceMode, compilerSchema: '1.0.0',
          form: 'snapshot', sections: [{ name: 'Objective', text: 'Continue the imported task.' }],
        }
      : {
          kind: 'plugin', plugin: 'dsh-threadbridge', sourceAgent: 'codex',
          sourceSessionId: sourceIdentity.sessionId, rolloutRevisionId: sourceIdentity.rolloutRevisionId,
          fingerprint: sourceIdentity.fingerprint, mode: sourceMode, compilerSchema: '1.0.0',
          form: 'notice', summary: 'Imported read-only Codex history; historical tools were not executed.',
        }
    const session = {
      header: {
        id: candidate.sessionId,
        cwd: candidate.meta.cwd,
        isSeeded: false,
        ...(candidate.meta.agentPreset === undefined ? {} : { agentPreset: candidate.meta.agentPreset }),
      },
      snapshotEvents: () => [{
        type: 'user/message',
        data: {
          source: pluginSource,
        },
      }],
    }
    sessions.set(candidate.sessionId, session)
    return {
      agent: { id: candidate.sessionId, session },
      dispose: vi.fn(async () => { created.delete(candidate.sessionId) }),
    }
  })
  const base = {
    agents: { create },
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock' }) },
    sessionQuery: { inspect: async (id: string) => sessions.get(id) },
    sessionPersistence: {},
    workspaceRegistry: {
      resolveByPath: async () => undefined,
      create: async () => ({ attachSession: async () => undefined }),
    },
    storageDomain: { open: vi.fn(async () => ({ table: () => ({}) })) },
    typert: {},
    ...overrides,
  }
  return { base, created, mounted, create, sessions }
}

describe('DshSessionGateway', () => {
  it('uses a dependency-free deterministic SHA-256 seam', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    const identity = computeImportIdentity({ source: prepared().source, mode: 'full', cwd: 'C:\\workspace' })
    expect(ImportIdentitySchema.parse(identity)).toEqual(identity)
  })

  it('checks only the official Host service boundary for compatibility and create', async () => {
    const base = runtime().base
    const invalidRuntimes: DshGatewayRuntime[] = [
      (() => { const { agents: _omit, ...rest } = base; return rest })(),
      (() => { const { sessionQuery: _omit, ...rest } = base; return rest })(),
      (() => { const { storageDomain: _omit, ...rest } = base; return rest })(),
    ]
    for (const invalidRuntime of invalidRuntimes) {
      const gateway = new DshSessionGateway(invalidRuntime, { index: new MemoryImportIndex() })
      expect(gateway.compatibility()).toMatchObject({ compatible: false })
      await expect(gateway.create(prepared(), new AbortController().signal)).rejects.toMatchObject({ code: 'DSH_INCOMPATIBLE' })
    }
    const host = new DshSessionGateway(base, { index: new MemoryImportIndex() })
    expect(host.compatibility()).toMatchObject({ compatible: true })
  })

  it('enumerates SessionQuery before a throwing readSession shim', async () => {
    const fake = runtime()
    const request = prepared()
    const index = new MemoryImportIndex()
    const filterSessions = vi.fn(async () => [...fake.sessions.keys()].map(id => ({ id })))
    const readSession = vi.fn(async (id: string) => {
      if (!fake.sessions.has(id)) throw new Error('readSession absent shim')
      return fake.sessions.get(id)
    })
    const gateway = new DshSessionGateway({
      ...fake.base,
      sessionQuery: { filterSessions, readSession },
    }, { index })
    await expect(gateway.create(request, new AbortController().signal)).resolves.toMatchObject({ state: 'created' })
    expect(filterSessions).toHaveBeenCalled()

    const restarted = new DshSessionGateway({
      ...fake.base,
      sessionQuery: { filterSessions, readSession },
    }, { index })
    // The new gateway has no live handle; a found id must expand through
    // readSession, while an absent id is proven absent without calling it.
    const emptyFilter = vi.fn(async () => [])
    const absent = new DshSessionGateway({
      ...fake.base,
      sessionQuery: { filterSessions: emptyFilter, readSession: vi.fn(async () => { throw new Error('must not read absent') }) },
    }, { index: new MemoryImportIndex() })
    expect(await absent.find(request.identity, new AbortController().signal)).toBeUndefined()
    expect(await restarted.find(request.identity, new AbortController().signal)).toBe(request.identity.destinationSessionId)
    expect(readSession).toHaveBeenCalledWith(request.identity.destinationSessionId)
    const uncertain = new DshSessionGateway({
      ...fake.base,
      sessionQuery: {
        filterSessions: async () => [{ id: request.identity.destinationSessionId }],
        readSession: async () => { throw new Error('read failure') },
      },
    }, { index })
    expect(await uncertain.find(request.identity, new AbortController().signal)).toBeUndefined()
  })

  it('rechecks the source immediately after preset resolution and before Agent.create', async () => {
    const fake = runtime({
      agentPresets: {
        resolve: vi.fn(async () => ({ id: 'preset' })),
        mount: vi.fn(async () => undefined),
      },
    })
    const request = prepared()
    let reads = 0
    const gateway = new DshSessionGateway(fake.base, {
      index: new MemoryImportIndex(),
      fingerprint: async () => {
        reads += 1
        return reads === 1 ? request.sourceFingerprint : 'changed-before-agent-create'
      },
    })
    await expect(gateway.create(request, new AbortController().signal)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' })
    expect(reads).toBe(2)
    expect(fake.create).not.toHaveBeenCalled()
  })

  it('rejects a same-path workspace replacement at create and attach boundaries', async () => {
    const fake = runtime()
    const request = PreparedImportSchema.parse({ ...prepared(), cwdIdentity: { device: 'dev-1', inode: 'ino-1' } })
    let reads = 0
    const cwdIdentity = vi.fn(async () => {
      reads += 1
      return reads === 1 ? { device: 'dev-1', inode: 'ino-1' } : { device: 'dev-2', inode: 'ino-2' }
    })
    const gateway = new DshSessionGateway(fake.base, { index: new MemoryImportIndex(), cwdIdentity })
    await expect(gateway.create(request, new AbortController().signal)).rejects.toMatchObject({ code: 'CWD_NOT_FOUND' })
    expect(fake.create).toHaveBeenCalledTimes(1)
    expect((await (gateway as unknown as { options: { index: MemoryImportIndex } }).options.index.get(request.identity.key))?.state).toBe('created')
  })

  it('keeps pure new requests working but fails closed for durable attach without an identity reader', async () => {
    const fresh = runtime()
    const freshGateway = new DshSessionGateway(fresh.base, { index: new MemoryImportIndex() })
    await expect(freshGateway.create(prepared(), new AbortController().signal)).resolves.toMatchObject({ state: 'created' })

    const index = new MemoryImportIndex()
    const failingWorkspace = runtime({
      workspaceRegistry: {
        resolveByPath: async () => undefined,
        create: async () => { throw new Error('workspace unavailable') },
      },
    })
    const request = prepared()
    const withReader = new DshSessionGateway(failingWorkspace.base, {
      index,
      cwdIdentity: async () => ({ device: 'test-device', inode: 'test-inode' }),
    })
    await expect(withReader.create(request, new AbortController().signal)).resolves.toMatchObject({ state: 'created_unattached' })
    const withoutReader = new DshSessionGateway(failingWorkspace.base, { index })
    await expect(withoutReader.create(request, new AbortController().signal)).rejects.toMatchObject({ code: 'CWD_NOT_FOUND' })
    expect(failingWorkspace.create).toHaveBeenCalledTimes(1)
  })

  it('creates through the public Agent factory with non-fork metadata and mounts the current preset', async () => {
    const mounted: string[] = []
    const fake = runtime({
      agentPresets: {
        resolve: vi.fn(async () => ({ id: 'standard' })),
        mount: vi.fn(async () => { mounted.push('standard') }),
      },
    })
    const gateway = new DshSessionGateway(fake.base, { index: new MemoryImportIndex(), attemptId: () => 'attempt-fixed' })
    const result = await gateway.create(prepared(), new AbortController().signal)
    expect(result).toMatchObject({ state: 'created', workspaceAttached: true })
    expect(fake.create).toHaveBeenCalledTimes(1)
    const options = fake.create.mock.calls[0]![0] as unknown as Record<string, unknown>
    expect(options.meta).toEqual({ cwd: 'C:\\workspace', agentPreset: 'standard' })
    expect(options).not.toHaveProperty('inheritedEventCount')
    expect(options).not.toHaveProperty('parentSession')
    expect(options).not.toHaveProperty('origin')
    expect(options).not.toHaveProperty('delegationDepth')
    expect(mounted).toEqual(['standard'])
  })

  it('is single-flight and idempotent for a destination already visible to DSH', async () => {
    const fake = runtime()
    const gateway = new DshSessionGateway(fake.base, { index: new MemoryImportIndex() })
    const request = prepared()
    const [first, second] = await Promise.all([
      gateway.create(request, new AbortController().signal),
      gateway.create(request, new AbortController().signal),
    ])
    expect(first.state).toBe('created')
    expect(second.state).toBe('created')
    expect(fake.create).toHaveBeenCalledTimes(1)
    await expect(gateway.create(request, new AbortController().signal)).resolves.toMatchObject({
      state: 'existing',
      sessionId: request.identity.destinationSessionId,
    })
    expect(fake.create).toHaveBeenCalledTimes(1)
  })

  it('disposes every live Agent handle during root unload', async () => {
    const fake = runtime()
    const gateway = new DshSessionGateway(fake.base, { index: new MemoryImportIndex() })
    await expect(gateway.create(prepared(), new AbortController().signal)).resolves.toMatchObject({ state: 'created' })
    expect(fake.created.size).toBe(1)
    await gateway.disposeAll()
    expect(fake.created.size).toBe(0)
    // Root unload is idempotent and does not re-dispose an already detached handle.
    await gateway.disposeAll()
    expect(fake.created.size).toBe(0)
  })

  it('keeps the session when workspace attachment fails', async () => {
    const fake = runtime({
      workspaceRegistry: {
        resolveByPath: async () => undefined,
        create: async () => { throw new Error('workspace unavailable') },
      },
    })
    const index = new MemoryImportIndex()
    const gateway = new DshSessionGateway(fake.base, { index })
    await expect(gateway.create(prepared(), new AbortController().signal)).resolves.toMatchObject({
      state: 'created_unattached',
      workspaceAttached: false,
    })
    const row = await index.get(prepared().identity.key)
    expect(row?.state).toBe('created_unattached')
  })

  it('retries a created_unattached row and promotes it after attachment succeeds', async () => {
    const index = new MemoryImportIndex()
    const fake = runtime({
      workspaceRegistry: {
        resolveByPath: async () => undefined,
        create: async () => { throw new Error('workspace unavailable') },
      },
    })
    const request = prepared()
    const first = await new DshSessionGateway(fake.base, { index }).create(request, new AbortController().signal)
    expect(first.state).toBe('created_unattached')
    const restarted = new DshSessionGateway({
      ...fake.base,
      workspaceRegistry: {
        resolveByPath: async () => ({ attachSession: async () => undefined }),
      },
    }, { index, cwdIdentity: async () => ({ device: 'test-device', inode: 'test-inode' }) })
    await expect(restarted.create(request, new AbortController().signal)).resolves.toMatchObject({
      state: 'existing',
      workspaceAttached: true,
    })
    expect((await index.get(request.identity.key))?.state).toBe('created')
  })

  it('keeps a committed row without re-reading a changed source or querying the destination', async () => {
    const fake = runtime()
    const index = new MemoryImportIndex()
    const request = prepared()
    await expect(new DshSessionGateway(fake.base, { index }).create(request, new AbortController().signal)).resolves.toMatchObject({ state: 'created' })
    const inspect = vi.fn(async () => { throw new Error('destination query unavailable') })
    const fingerprintRecord = vi.fn(async () => 'changed-after-commit')
    const restarted = new DshSessionGateway({
      ...fake.base,
      sessionQuery: { inspect },
    }, { index, fingerprintRecord })
    await expect(restarted.recover(new AbortController().signal)).resolves.toMatchObject([{ state: 'created' }])
    expect(inspect).not.toHaveBeenCalled()
    expect(fingerprintRecord).not.toHaveBeenCalled()
  })

  it('keeps created_unattached when a restart destination query is unknown', async () => {
    const index = new MemoryImportIndex()
    const first = runtime({
      workspaceRegistry: {
        resolveByPath: async () => undefined,
        create: async () => { throw new Error('workspace unavailable') },
      },
    })
    const request = prepared()
    await expect(new DshSessionGateway(first.base, { index }).create(request, new AbortController().signal)).resolves.toMatchObject({ state: 'created_unattached' })
    const restarted = new DshSessionGateway({
      ...first.base,
      sessionQuery: { inspect: async () => { throw new Error('query unavailable') } },
    }, { index, cwdIdentity: async () => ({ device: 'test-device', inode: 'test-inode' }) })
    await expect(restarted.recover(new AbortController().signal)).resolves.toMatchObject([{ state: 'created_unattached' }])
    expect((await index.get(request.identity.key))?.state).toBe('created_unattached')
  })

  it('keeps creating when the post-create ledger commit fails', async () => {
    const backing = new MemoryImportIndex()
    const index = {
      get: (key: string) => backing.get(key),
      list: () => backing.list(),
      put: async (record: Parameters<MemoryImportIndex['put']>[0], expected?: Parameters<MemoryImportIndex['put']>[1]) => {
        if (record.state === 'created') throw new Error('durable ledger unavailable')
        await backing.put(record, expected)
      },
    }
    const fake = runtime()
    const request = prepared()
    const gateway = new DshSessionGateway(fake.base, { index })
    await expect(gateway.create(request, new AbortController().signal)).rejects.toMatchObject({ code: 'IMPORT_ID_CONFLICT' })
    expect((await backing.get(request.identity.key))?.state).toBe('creating')
    expect(fake.create).toHaveBeenCalledTimes(1)
  })

  it('recovers a created row when the workspace marker commit crashes after attach', async () => {
    const backing = new MemoryImportIndex()
    let crashMarker = true
    const index = {
      get: (key: string) => backing.get(key),
      list: () => backing.list(),
      put: async (record: Parameters<MemoryImportIndex['put']>[0], expected?: Parameters<MemoryImportIndex['put']>[1]) => {
        if (crashMarker && record.state === 'created' && 'workspaceAttachedAt' in record) {
          crashMarker = false
          throw new Error('crash after workspace attach')
        }
        await backing.put(record, expected)
      },
    }
    const fake = runtime()
    const request = prepared()
    await expect(new DshSessionGateway(fake.base, { index }).create(request, new AbortController().signal)).rejects.toMatchObject({ code: 'IMPORT_ID_CONFLICT' })
    expect((await backing.get(request.identity.key))?.state).toBe('created')
    expect((await backing.get(request.identity.key))).not.toHaveProperty('workspaceAttachedAt')

    const attach = vi.fn(async () => undefined)
    const restarted = new DshSessionGateway({
      ...fake.base,
      workspaceRegistry: { resolveByPath: async () => ({ attachSession: attach }) },
    }, { index, cwdIdentity: async () => ({ device: 'test-device', inode: 'test-inode' }) })
    await expect(restarted.recover(new AbortController().signal)).resolves.toMatchObject([{ state: 'created' }])
    expect(attach).toHaveBeenCalledTimes(1)
    expect((await backing.get(request.identity.key))).toMatchObject({ state: 'created', workspaceAttachedAt: expect.any(String) })
    expect(fake.create).toHaveBeenCalledTimes(1)
  })

  it('fails closed before retry attachment when a created row sees a same-path replacement', async () => {
    const backing = new MemoryImportIndex()
    let failMarker = true
    const index = {
      get: (key: string) => backing.get(key),
      list: () => backing.list(),
      put: async (record: Parameters<MemoryImportIndex['put']>[0], expected?: Parameters<MemoryImportIndex['put']>[1]) => {
        if (failMarker && record.state === 'created' && 'workspaceAttachedAt' in record) {
          failMarker = false
          throw new Error('crash before attachment marker')
        }
        await backing.put(record, expected)
      },
    }
    const fake = runtime()
    const request = prepared()
    await expect(new DshSessionGateway(fake.base, { index }).create(request, new AbortController().signal)).rejects.toMatchObject({ code: 'IMPORT_ID_CONFLICT' })
    const attach = vi.fn(async () => undefined)
    const restarted = new DshSessionGateway({
      ...fake.base,
      workspaceRegistry: { resolveByPath: async () => ({ attachSession: attach }) },
    }, {
      index,
      cwdIdentity: async () => ({ device: 'replacement-device', inode: 'replacement-inode' }),
    })
    await expect(restarted.recover(new AbortController().signal)).resolves.toMatchObject([{ state: 'created_unattached' }])
    expect(attach).not.toHaveBeenCalled()
    expect((await backing.get(request.identity.key))?.state).toBe('created_unattached')
  })

  it('fails closed before retry attachment when a created_unattached row sees a same-path replacement', async () => {
    const backing = new MemoryImportIndex()
    const first = runtime({
      workspaceRegistry: {
        resolveByPath: async () => undefined,
        create: async () => { throw new Error('workspace unavailable') },
      },
    })
    const request = prepared()
    await expect(new DshSessionGateway(first.base, { index: backing }).create(request, new AbortController().signal)).resolves.toMatchObject({ state: 'created_unattached' })
    const attach = vi.fn(async () => undefined)
    const restarted = new DshSessionGateway({
      ...first.base,
      workspaceRegistry: { resolveByPath: async () => ({ attachSession: attach }) },
    }, {
      index: backing,
      cwdIdentity: async () => ({ device: 'replacement-device', inode: 'replacement-inode' }),
    })
    await expect(restarted.recover(new AbortController().signal)).resolves.toMatchObject([{ state: 'created_unattached' }])
    expect(attach).not.toHaveBeenCalled()
    expect((await backing.get(request.identity.key))?.state).toBe('created_unattached')
  })

  it('adopts a creating destination through durable attach and reports attach failure as partial', async () => {
    const backing = new MemoryImportIndex()
    let failCreatedCommit = true
    const index = {
      get: (key: string) => backing.get(key),
      list: () => backing.list(),
      put: async (record: Parameters<MemoryImportIndex['put']>[0], expected?: Parameters<MemoryImportIndex['put']>[1]) => {
        if (failCreatedCommit && record.state === 'created') throw new Error('crash before created index commit')
        await backing.put(record, expected)
      },
    }
    const fake = runtime()
    const request = prepared()
    await expect(new DshSessionGateway(fake.base, { index }).create(request, new AbortController().signal)).rejects.toMatchObject({ code: 'IMPORT_ID_CONFLICT' })
    expect((await backing.get(request.identity.key))?.state).toBe('creating')
    failCreatedCommit = false
    const attach = vi.fn(async () => { throw new Error('workspace unavailable') })
    const adopted = new DshSessionGateway({
      ...fake.base,
      workspaceRegistry: { resolveByPath: async () => ({ attachSession: attach }) },
    }, {
      index,
      cwdIdentity: async () => ({ device: 'test-device', inode: 'test-inode' }),
    })
    await expect(adopted.create(request, new AbortController().signal)).resolves.toMatchObject({ state: 'created_unattached', workspaceAttached: false })
    expect(attach).toHaveBeenCalledTimes(1)
    expect(fake.create).toHaveBeenCalledTimes(1)
    expect((await backing.get(request.identity.key))?.state).toBe('created_unattached')
  })

  it('uses one atomic ledger row with generation and expected-state updates', async () => {
    let row: unknown
    const updates: unknown[] = []
    const table = {
      get: vi.fn(async (key: string) => key === IMPORT_LEDGER.key ? row : undefined),
      put: vi.fn(async (key: string, value: unknown) => { if (key === IMPORT_LEDGER.key) row = value }),
      update: vi.fn(async (key: string, updater: (latest: unknown) => unknown) => {
        if (key !== IMPORT_LEDGER.key) throw new Error('unexpected table key')
        const next = updater(row)
        row = next
        updates.push(next)
        return next
      }),
    }
    const index = new StorageDomainImportIndex(table)
    const request = prepared()
    const at = '2026-01-01T00:00:00.000Z'
    const record = {
      schemaVersion: 2 as const,
      key: request.identity.key,
      sourceSessionId: request.source.sessionId,
      sourceRolloutRevisionId: request.source.rolloutRevisionId,
      sourceFingerprint: request.sourceFingerprint,
      mode: request.mode,
      cwd: request.cwd,
      destinationSessionId: request.identity.destinationSessionId,
      state: 'prepared' as const,
      sourceFingerprintBefore: request.sourceFingerprint,
      attemptId: 'attempt-ledger',
      createdAt: at,
      updatedAt: at,
    }
    await index.initialize()
    await index.put(record)
    expect(table.put).toHaveBeenCalledTimes(1)
    expect(table.update).toHaveBeenCalledTimes(1)
    expect((row as { generation: number }).generation).toBe(1)
    expect((await index.get(request.identity.key))?.state).toBe('prepared')
    expect((await index.list())).toHaveLength(1)
    expect(updates).toHaveLength(1)
  })

  it('opens the official storage-domain shape and initializes before publishing the adapter', async () => {
    let row: unknown
    const table = {
      get: vi.fn((key: string) => key === IMPORT_LEDGER.key ? row : undefined),
      put: vi.fn(async (key: string, value: unknown) => { if (key === IMPORT_LEDGER.key) row = value }),
      update: vi.fn(async (key: string, updater: (latest: unknown) => unknown) => {
        if (key !== IMPORT_LEDGER.key) throw new Error('unexpected table key')
        row = updater(row)
        return row
      }),
    }
    const open = vi.fn(async (spec: { name: string; tables: Record<string, unknown> }) => {
      expect(spec.name).toBe(IMPORT_LEDGER.domain)
      expect(Object.keys(spec.tables)).toEqual([IMPORT_LEDGER.table])
      return { table: (name: string) => {
        expect(name).toBe(IMPORT_LEDGER.table)
        return table
      } }
    })
    const index = await createStorageDomainImportIndex({ open })
    expect(open).toHaveBeenCalledTimes(1)
    expect(table.put).toHaveBeenCalledTimes(1)
    expect(await index.get('missing')).toBeUndefined()
  })

  it('keeps ownership of the official domain handle and closes it before a same-domain reopen', async () => {
    let row: unknown
    let open = false
    let opens = 0
    let closes = 0
    const table = {
      get: vi.fn(async (key: string) => key === IMPORT_LEDGER.key ? row : undefined),
      put: vi.fn(async (key: string, value: unknown) => { if (key === IMPORT_LEDGER.key) row = value }),
      update: vi.fn(async (key: string, updater: (latest: unknown) => unknown) => {
        if (key !== IMPORT_LEDGER.key) throw new Error('unexpected table key')
        row = updater(row)
        return row
      }),
    }
    const storage = {
      open: vi.fn(async () => {
        if (open) throw new Error('domain already open')
        open = true
        opens += 1
        return {
          table: () => table,
          close: async () => { open = false; closes += 1 },
        }
      }),
    }
    const first = await createStorageDomainImportIndex(storage)
    await first.close()
    const second = await createStorageDomainImportIndex(storage)
    await second.close()
    expect(opens).toBe(2)
    expect(closes).toBe(2)
    expect(open).toBe(false)
  })

  it('closes the domain when ledger initialization fails before publication', async () => {
    let closes = 0
    const storage = {
      open: vi.fn(async () => ({
        table: () => ({
          get: async () => { throw new Error('ledger read failed') },
          put: async () => undefined,
          update: async () => undefined,
        }),
        close: async () => { closes += 1 },
      })),
    }
    await expect(createStorageDomainImportIndex(storage)).rejects.toThrow('ledger read failed')
    expect(closes).toBe(1)
  })

  it('coalesces concurrent first initialization into one durable empty-row put', async () => {
    let row: unknown
    let releasePut: () => void = () => undefined
    const putEntered = new Promise<void>(resolve => { releasePut = resolve })
    const table = {
      get: vi.fn((key: string) => key === IMPORT_LEDGER.key ? row : undefined),
      put: vi.fn(async (key: string, value: unknown) => {
        if (key !== IMPORT_LEDGER.key) throw new Error('unexpected table key')
        await putEntered
        row = value
      }),
      update: vi.fn(async () => undefined),
    }
    const first = new StorageDomainImportIndex(table)
    const second = new StorageDomainImportIndex(table)
    const firstInit = first.initialize()
    const secondInit = second.initialize()
    await vi.waitFor(() => expect(table.put).toHaveBeenCalledTimes(1))
    releasePut()
    await Promise.all([firstInit, secondInit])
    expect(table.put).toHaveBeenCalledTimes(1)
    await expect(first.get('missing')).resolves.toBeUndefined()
    await expect(second.list()).resolves.toEqual([])
  })

  it('fails closed when the single ledger row exceeds its record limit', async () => {
    const request = prepared()
    const record = {
      schemaVersion: 2 as const,
      key: request.identity.key,
      sourceSessionId: request.source.sessionId,
      sourceRolloutRevisionId: request.source.rolloutRevisionId,
      sourceFingerprint: request.sourceFingerprint,
      mode: request.mode,
      cwd: request.cwd,
      destinationSessionId: request.identity.destinationSessionId,
      state: 'prepared' as const,
      sourceFingerprintBefore: request.sourceFingerprint,
      attemptId: 'attempt-ledger-limit',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const records: Record<string, unknown> = {}
    for (let index = 0; index <= IMPORT_LEDGER.maxRecords; index += 1) records[`record-${index}`] = record
    const row = { schemaVersion: 1 as const, generation: 0, records }
    const table = {
      get: vi.fn(async () => row),
      put: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
    }
    const index = new StorageDomainImportIndex(table)
    await expect(index.initialize()).rejects.toThrow(/record limit/)
    expect(table.put).not.toHaveBeenCalled()
  })

  it('uses the ledger update boundary to ensure same-key competing gateways create once', async () => {
    let row: unknown
    let updateTail = Promise.resolve()
    const table = {
      get: vi.fn(async (key: string) => key === IMPORT_LEDGER.key ? row : undefined),
      put: vi.fn(async (key: string, value: unknown) => { if (key === IMPORT_LEDGER.key) row = value }),
      update: vi.fn(async (key: string, updater: (latest: unknown) => unknown) => {
        if (key !== IMPORT_LEDGER.key) throw new Error('unexpected table key')
        const previous = updateTail
        let release: () => void = () => undefined
        updateTail = new Promise<void>(resolve => { release = resolve })
        await previous
        try {
          const next = updater(row)
          row = next
          return next
        } finally {
          release()
        }
      }),
    }
    const firstIndex = new StorageDomainImportIndex(table)
    const secondIndex = new StorageDomainImportIndex(table)
    await firstIndex.initialize()
    await secondIndex.initialize()

    const fake = runtime()
    let inspectCount = 0
    let releaseInitialInspect: () => void = () => undefined
    const initialInspect = new Promise<void>(resolve => { releaseInitialInspect = resolve })
    const inspect = fake.base.sessionQuery.inspect
    fake.base.sessionQuery = {
      inspect: async (id: string) => {
        inspectCount += 1
        if (inspectCount === 2) releaseInitialInspect()
        await initialInspect
        return await inspect(id)
      },
    }
    const request = prepared()
    const first = new DshSessionGateway(fake.base, { index: firstIndex, attemptId: () => 'competing-first' })
    const second = new DshSessionGateway(fake.base, { index: secondIndex, attemptId: () => 'competing-second' })
    const results = await Promise.allSettled([
      first.create(request, new AbortController().signal),
      second.create(request, new AbortController().signal),
    ])
    expect(fake.create).toHaveBeenCalledTimes(1)
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(2)
    expect(results.map(result => result.status === 'fulfilled' ? result.value.state : 'rejected')).toEqual(expect.arrayContaining(['created', 'existing']))
    expect((await firstIndex.get(request.identity.key))?.state).toBe('created')
  })

  it('allows different import keys to progress independently on the same ledger row', async () => {
    let row: unknown
    let updateTail = Promise.resolve()
    const table = {
      get: vi.fn(async (key: string) => key === IMPORT_LEDGER.key ? row : undefined),
      put: vi.fn(async (key: string, value: unknown) => { if (key === IMPORT_LEDGER.key) row = value }),
      update: vi.fn(async (key: string, updater: (latest: unknown) => unknown) => {
        if (key !== IMPORT_LEDGER.key) throw new Error('unexpected table key')
        const previous = updateTail
        let release: () => void = () => undefined
        updateTail = new Promise<void>(resolve => { release = resolve })
        await previous
        try {
          const next = updater(row)
          row = next
          return next
        } finally {
          release()
        }
      }),
    }
    const firstIndex = new StorageDomainImportIndex(table)
    const secondIndex = new StorageDomainImportIndex(table)
    await firstIndex.initialize()
    await secondIndex.initialize()
    const firstFake = runtime({}, 'smart')
    const secondFake = runtime()
    const first = new DshSessionGateway(firstFake.base, { index: firstIndex, attemptId: () => 'different-first' })
    const second = new DshSessionGateway(secondFake.base, { index: secondIndex, attemptId: () => 'different-second' })
    const request = prepared('smart')
    const secondRequest = prepared('full')
    const results = await Promise.all([
      first.create(request, new AbortController().signal),
      second.create(secondRequest, new AbortController().signal),
    ])
    expect(results.map(result => result.state)).toEqual(['created', 'created'])
    expect(firstFake.create).toHaveBeenCalledTimes(1)
    expect(secondFake.create).toHaveBeenCalledTimes(1)
  })

  it('recovers the original preset after a restart even when the default changes', async () => {
    const index = new MemoryImportIndex()
    const fake = runtime({
      agentPresets: {
        resolve: vi.fn(async () => ({ id: 'original-preset' })),
        mount: vi.fn(async () => undefined),
      },
    })
    const request = prepared()
    const first = await new DshSessionGateway(fake.base, { index }).create(request, new AbortController().signal)
    expect(first.state).toBe('created')
    const createOptions = fake.create.mock.calls[0]![0] as unknown as { meta: { agentPreset?: string } }
    expect(createOptions.meta.agentPreset).toBe('original-preset')

    const restarted = new DshSessionGateway({
      ...fake.base,
      agentPresets: {
        resolve: vi.fn(async () => ({ id: 'new-default' })),
        mount: vi.fn(async () => undefined),
      },
    }, {
      index,
      fingerprintRecord: async () => request.sourceFingerprint,
    })
    const recovered = await restarted.recover(new AbortController().signal)
    expect(recovered[0]).toMatchObject({ state: 'created', destination: { status: 'verified' } })
    expect(fake.create).toHaveBeenCalledTimes(1)
  })

  it('rejects a changed source before creating and leaves no DSH agent', async () => {
    const fake = runtime()
    const index = new MemoryImportIndex()
    const gateway = new DshSessionGateway(fake.base, {
      index,
      fingerprint: async () => 'changed-fingerprint',
    })
    await expect(gateway.create(prepared(), new AbortController().signal)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' })
    expect(fake.create).not.toHaveBeenCalled()
    expect(await index.get(prepared().identity.key)).toBeUndefined()
  })

  it('rebuilds a prepared recovery intent after restart and creates once with the same identity', async () => {
    const backing = new MemoryImportIndex()
    let crashAtCreating = true
    const index = {
      get: (key: string) => backing.get(key),
      list: () => backing.list(),
      put: async (record: Parameters<MemoryImportIndex['put']>[0], expected?: Parameters<MemoryImportIndex['put']>[1]) => {
        if (crashAtCreating && record.state === 'creating') {
          crashAtCreating = false
          throw new Error('simulated process crash after prepared durable')
        }
        await backing.put(record, expected)
      },
    }
    const fake = runtime()
    const request = prepared()
    const first = new DshSessionGateway(fake.base, { index })
    await expect(first.create(request, new AbortController().signal)).rejects.toMatchObject({ code: 'IMPORT_ID_CONFLICT' })
    const persisted = await backing.get(request.identity.key)
    expect(persisted?.state).toBe('prepared')
    expect(JSON.stringify(persisted)).not.toContain('C:\\workspace\\rollout')

    const restarted = new DshSessionGateway(fake.base, {
      index: backing,
      fingerprintRecord: async record => record.sourceFingerprint,
      rebuildRecord: async record => {
        expect(record.schemaVersion === 2 ? record.recovery?.source.sessionId : undefined).toBe(request.source.sessionId)
        return request
      },
      cwdIdentity: async () => ({ device: 'test-device', inode: 'test-inode' }),
    })
    const recovered = await restarted.recover(new AbortController().signal)
    expect(recovered[0]).toMatchObject({ state: 'created', key: request.identity.key })
    expect(fake.create).toHaveBeenCalledTimes(1)
    expect((await backing.get(request.identity.key))?.state).toBe('created')
  })

  it('adopts a durable destination after the created-index commit crashes without creating twice', async () => {
    const backing = new MemoryImportIndex()
    let failCreatedCommit = true
    const index = {
      get: (key: string) => backing.get(key),
      list: () => backing.list(),
      put: async (record: Parameters<MemoryImportIndex['put']>[0], expected?: Parameters<MemoryImportIndex['put']>[1]) => {
        if (failCreatedCommit && record.state === 'created') throw new Error('simulated crash before created index commit')
        await backing.put(record, expected)
      },
    }
    const fake = runtime()
    const originalCreate = fake.base.agents.create
    fake.base.agents = {
      create: async (options: Parameters<typeof originalCreate>[0]) => {
        const handle = await originalCreate(options)
        // DSH unload is not deletion; preserve the durable destination for
        // restart adoption while still allowing the old handle to be closed.
        return { ...handle, dispose: vi.fn(async () => undefined) }
      },
    } as typeof fake.base.agents
    const request = prepared()
    const first = new DshSessionGateway(fake.base, { index })
    await expect(first.create(request, new AbortController().signal)).rejects.toMatchObject({ code: 'IMPORT_ID_CONFLICT' })
    expect((await backing.get(request.identity.key))?.state).toBe('creating')
    expect(fake.create).toHaveBeenCalledTimes(1)

    failCreatedCommit = false
    const restarted = new DshSessionGateway(fake.base, {
      index: backing,
      fingerprintRecord: async record => record.sourceFingerprint,
      cwdIdentity: async () => ({ device: 'test-device', inode: 'test-inode' }),
    })
    const recovered = await restarted.recover(new AbortController().signal)
    expect(recovered[0]).toMatchObject({ state: 'created', destination: { status: 'verified' } })
    expect(fake.create).toHaveBeenCalledTimes(1)
    expect((await backing.get(request.identity.key))?.state).toBe('created')
  })

  it('adopts a verified destination when Agent.create reports a concurrent collision and finalizes attachment', async () => {
    const fake = runtime()
    const originalCreate = fake.base.agents.create
    const collisionCreate = vi.fn(async (options: Parameters<typeof originalCreate>[0]) => {
      await originalCreate(options)
      throw new Error('destination already exists')
    })
    fake.base.agents = { create: collisionCreate } as typeof fake.base.agents
    const index = new MemoryImportIndex()
    const request = prepared()
    const gateway = new DshSessionGateway(fake.base, {
      index,
      cwdIdentity: async () => ({ device: 'test-device', inode: 'test-inode' }),
    })
    await expect(gateway.create(request, new AbortController().signal)).resolves.toMatchObject({
      state: 'existing',
      sessionId: request.identity.destinationSessionId,
      workspaceAttached: true,
    })
    expect(collisionCreate).toHaveBeenCalledTimes(1)
    expect((await index.get(request.identity.key))).toMatchObject({ state: 'created', workspaceAttachedAt: expect.any(String) })
  })

  it('retries a creating row after the agent boundary crashes before a failed terminal commit', async () => {
    const backing = new MemoryImportIndex()
    let failFailedCommit = true
    const index = {
      get: (key: string) => backing.get(key),
      list: () => backing.list(),
      put: async (record: Parameters<MemoryImportIndex['put']>[0], expected?: Parameters<MemoryImportIndex['put']>[1]) => {
        if (failFailedCommit && record.state === 'failed') throw new Error('simulated crash before failed index commit')
        await backing.put(record, expected)
      },
    }
    const fake = runtime()
    let crashAgent = true
    const originalCreate = fake.base.agents.create
    fake.base.agents = {
      create: async (options: Parameters<typeof originalCreate>[0]) => {
        if (crashAgent) {
          crashAgent = false
          throw new Error('simulated crash after creating durable')
        }
        return originalCreate(options)
      },
    } as typeof fake.base.agents
    const request = prepared()
    const first = new DshSessionGateway(fake.base, { index })
    await expect(first.create(request, new AbortController().signal)).rejects.toMatchObject({ code: 'IMPORT_ID_CONFLICT' })
    expect((await backing.get(request.identity.key))?.state).toBe('creating')
    failFailedCommit = false

    const restarted = new DshSessionGateway(fake.base, {
      index: backing,
      fingerprintRecord: async record => record.sourceFingerprint,
      rebuildRecord: async () => request,
      cwdIdentity: async () => ({ device: 'test-device', inode: 'test-inode' }),
    })
    const recovered = await restarted.recover(new AbortController().signal)
    expect(recovered[0]).toMatchObject({ state: 'created', key: request.identity.key })
    expect(fake.create).toHaveBeenCalledTimes(1)
    expect((await backing.get(request.identity.key))?.state).toBe('created')
  })

  it('orphans recovery when rebuilding the source produces a different seed digest or byte count', async () => {
    const backing = new MemoryImportIndex()
    let crashAtCreating = true
    const index = {
      get: (key: string) => backing.get(key),
      list: () => backing.list(),
      put: async (record: Parameters<MemoryImportIndex['put']>[0], expected?: Parameters<MemoryImportIndex['put']>[1]) => {
        if (crashAtCreating && record.state === 'creating') {
          crashAtCreating = false
          throw new Error('simulated crash after prepared durable')
        }
        await backing.put(record, expected)
      },
    }
    const fake = runtime()
    const request = prepared()
    const first = new DshSessionGateway(fake.base, { index })
    await expect(first.create(request, new AbortController().signal)).rejects.toMatchObject({ code: 'IMPORT_ID_CONFLICT' })
    const changedSeed = PreparedImportSchema.parse({
      ...request,
      seed: [{ type: 'user/message', data: { text: 'changed after crash' } }],
    })
    const restarted = new DshSessionGateway(fake.base, {
      index: backing,
      fingerprintRecord: async record => record.sourceFingerprint,
      rebuildRecord: async () => changedSeed,
      cwdIdentity: async () => ({ device: 'test-device', inode: 'test-inode' }),
    })
    const recovered = await restarted.recover(new AbortController().signal)
    expect(recovered[0]).toMatchObject({ state: 'orphaned', failure: { code: 'SOURCE_CHANGED' } })
    expect(fake.create).not.toHaveBeenCalled()
  })

  it('keeps an already-created destination after the source later changes', async () => {
    const index = new MemoryImportIndex()
    const fake = runtime()
    const request = prepared()
    const first = new DshSessionGateway(fake.base, { index })
    await expect(first.create(request, new AbortController().signal)).resolves.toMatchObject({ state: 'created' })
    const restarted = new DshSessionGateway(fake.base, {
      index,
      fingerprintRecord: async () => 'changed-after-commit',
    })
    const recovered = await restarted.recover(new AbortController().signal)
    expect(recovered[0]).toMatchObject({ state: 'created', destination: { status: 'verified' } })
    expect((await index.get(request.identity.key))?.state).toBe('created')
  })

  it('fails closed for an old v2 row with no opaque recovery intent', async () => {
    const backing = new MemoryImportIndex()
    const request = prepared()
    const legacy = {
      schemaVersion: 2 as const,
      key: request.identity.key,
      sourceSessionId: request.source.sessionId,
      sourceRolloutRevisionId: request.source.rolloutRevisionId,
      sourceFingerprint: request.sourceFingerprint,
      mode: request.mode,
      cwd: request.cwd,
      destinationSessionId: request.identity.destinationSessionId,
      state: 'prepared' as const,
      sourceFingerprintBefore: request.sourceFingerprint,
      attemptId: 'legacy-attempt',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    await backing.put(legacy)
    const fake = runtime()
    const gateway = new DshSessionGateway(fake.base, { index: backing })
    const recovered = await gateway.recover(new AbortController().signal)
    expect(recovered[0]).toMatchObject({ state: 'orphaned', failure: { code: 'RECOVERY_INTENT_UNAVAILABLE' } })
    expect(fake.create).not.toHaveBeenCalled()
  })

  it('keeps the ledger secret-free while recording bounded recovery intent', async () => {
    const backing = new MemoryImportIndex()
    let crashBeforeCreatedCommit = true
    const index = {
      get: (key: string) => backing.get(key),
      list: () => backing.list(),
      put: async (record: Parameters<MemoryImportIndex['put']>[0], expected?: Parameters<MemoryImportIndex['put']>[1]) => {
        if (crashBeforeCreatedCommit && record.state === 'created') {
          crashBeforeCreatedCommit = false
          throw new Error('crash after destination create')
        }
        await backing.put(record, expected)
      },
    }
    const fake = runtime()
    const secret = 'SUPER_SECRET_TRANSCRIPT_VALUE'
    const request = PreparedImportSchema.parse({ ...prepared(), seed: [{ type: 'user/message', data: { token: secret } }] })
    await expect(new DshSessionGateway(fake.base, { index }).create(request, new AbortController().signal)).rejects.toMatchObject({ code: 'IMPORT_ID_CONFLICT' })
    const row = await backing.get(request.identity.key)
    expect(row?.schemaVersion).toBe(2)
    expect(row?.schemaVersion === 2 ? row.recovery?.source : undefined).toMatchObject({ sessionId: request.source.sessionId, rolloutRevisionId: request.source.rolloutRevisionId })
    expect(JSON.stringify(row)).not.toContain(secret)
    expect(JSON.stringify(row)).not.toContain('C:\\workspace\\rollout')
    expect(row?.schemaVersion === 2 ? row.recovery?.seedDigest : undefined).toMatch(/^[a-f0-9]{64}$/)
    const sentSeed = (fake.create.mock.calls[0]?.[0] as unknown as { readonly seed?: unknown } | undefined)?.seed
    expect(JSON.stringify(sentSeed)).not.toContain(secret)
  })

  it.each(['full', 'smart'] as const)('preserves schema-validated %s plugin provenance through the Agent.create boundary', async mode => {
    const request = preparedWithProvenance(mode)
    const sourceIdentity = {
      sessionId: request.source.sessionId,
      rolloutRevisionId: request.source.rolloutRevisionId,
      fingerprint: request.sourceFingerprint,
    }
    const fake = runtime({}, mode, sourceIdentity)
    const gateway = new DshSessionGateway(fake.base, { index: new MemoryImportIndex() })

    await expect(gateway.create(request, new AbortController().signal)).resolves.toMatchObject({ state: 'created' })

    const createOptions = fake.create.mock.calls[0]?.[0] as unknown as { readonly seed?: unknown } | undefined
    const serialized = JSON.stringify(createOptions?.seed)
    expect(serialized).toContain('"sourceSessionId":"123e4567-e89b-12d3-a456-426614174000"')
    expect(serialized).toContain('"rolloutRevisionId":"550e8400-e29b-41d4-a716-446655440000"')
    expect(serialized).not.toContain('gateway-secret')
    expect(serialized).not.toContain('AKIA1234567890ABCDEF')
    expect(serialized).toContain('[REDACTED]')
  })

  it('accepts DSH-sanitized opaque source ids when the immutable Smart provenance still matches', async () => {
    const request = preparedWithProvenance('smart')
    const fake = runtime({}, 'smart', {
      sessionId: '[REDACTED]',
      rolloutRevisionId: '[REDACTED]',
      fingerprint: request.sourceFingerprint,
    })
    const gateway = new DshSessionGateway(fake.base, { index: new MemoryImportIndex() })

    await expect(gateway.create(request, new AbortController().signal)).resolves.toMatchObject({
      state: 'created',
      sessionId: request.identity.destinationSessionId,
    })
  })

  it('re-adopts a matching Smart destination after an earlier verification conflict', async () => {
    const request = preparedWithProvenance('smart')
    const index = new MemoryImportIndex()
    const fake = runtime({}, 'smart', {
      sessionId: 'wrong-source-session',
      rolloutRevisionId: 'wrong-source-revision',
      fingerprint: request.sourceFingerprint,
    })
    const first = new DshSessionGateway(fake.base, { index })

    await expect(first.create(request, new AbortController().signal)).rejects.toMatchObject({ code: 'IMPORT_ID_CONFLICT' })
    expect(await index.get(request.identity.key)).toMatchObject({ state: 'orphaned', failure: { phase: 'destination-verify' } })

    fake.sessions.set(request.identity.destinationSessionId, {
      header: { id: request.identity.destinationSessionId, cwd: request.cwd, isSeeded: false },
      snapshotEvents: () => [{
        type: 'user/message',
        data: {
          source: {
            kind: 'plugin', plugin: 'dsh-threadbridge', sourceAgent: 'codex',
            sourceSessionId: '[REDACTED]', rolloutRevisionId: '[REDACTED]',
            fingerprint: request.sourceFingerprint, mode: 'smart', compilerSchema: '1.0.0',
            form: 'snapshot', sections: [{ name: 'Objective', text: 'Continue the imported task.' }],
          },
        },
      }],
    })
    const restarted = new DshSessionGateway(fake.base, {
      index,
      cwdIdentity: async () => ({ device: 'test-device', inode: 'test-inode' }),
    })

    await expect(restarted.create(request, new AbortController().signal)).resolves.toMatchObject({
      state: 'existing',
      sessionId: request.identity.destinationSessionId,
      workspaceAttached: true,
    })
    expect(fake.create).toHaveBeenCalledTimes(1)
    expect(await index.get(request.identity.key)).toMatchObject({ state: 'created', workspaceAttachedAt: expect.any(String) })
  })

  it('does not create after cancellation', async () => {
    const fake = runtime()
    const index = new MemoryImportIndex()
    const gateway = new DshSessionGateway(fake.base, { index })
    const controller = new AbortController()
    controller.abort()
    await expect(gateway.create(prepared(), controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(fake.create).not.toHaveBeenCalled()
  })
})
