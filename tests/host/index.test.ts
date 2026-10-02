import { describe, expect, it, vi } from 'vitest'

import { HandoffError } from '../../src/shared/errors.js'
import { PreparedImportSchema, type CreateRequest, type ImportRecordRead, type NormalizedSession, type SessionPage, type SessionSource } from '../../src/shared/index.js'
import { compileFullSeed } from '../../src/dsh/seed.js'
import { MemoryImportIndex, computeImportIdentity, type DshGatewayRuntime } from '../../src/dsh/gateway.js'
import { SmartHandoffEngine } from '../../src/handoff/engine.js'
import { apply, createHostComposition, runtimeFromContext } from '../../src/host/index.js'
import { readWorkspaceIdentity } from '../../src/host/remote.js'
import { MINIMAL_DSH_SEED } from '../fixtures/dsh/minimal-seed.js'

function makeSession(cwd: string): NormalizedSession {
  return {
    schemaVersion: 2,
    source: {
      agent: 'codex', sessionId: 'source-session-1', rolloutRevisionId: 'rollout-1',
      fingerprint: 'fingerprint-123456', cwd, archived: false,
    },
    lineage: [{ rolloutRevisionId: 'rollout-1', relation: 'head', representation: 'jsonl' }],
    timeline: [],
    diagnostics: [],
    completeness: { malformedLines: 0, unknownRecords: 0, droppedEncryptedBlocks: 0, danglingToolCalls: 0, orphanToolResults: 0, truncatedRecords: 0 },
  }
}

type RediscoveryCase = 'match' | 'missing' | 'ambiguous' | 'mismatch'

function sourceWithRestart(cwd: string, rediscoveryCase: RediscoveryCase = 'match'): { source: SessionSource; restart: () => void; calls: { load: string[]; discover: number } } {
  const oldRef = 'old-process-handle'
  const newRef = 'new-process-handle'
  let restarted = false
  const normalized = makeSession(cwd)
  const calls = { load: [] as string[], discover: 0 }
  const source: SessionSource = {
    kind: 'codex',
    discover: async (): Promise<SessionPage> => {
      calls.discover += 1
      const item = {
        discoveryId: newRef, source: 'codex' as const, sessionId: normalized.source.sessionId,
        rolloutRevisionId: normalized.source.rolloutRevisionId, fingerprint: normalized.source.fingerprint,
        cwd, updatedAt: '2026-01-01T00:00:00.000Z', archived: false,
        messageCount: 0, toolCallCount: 0, byteSize: 1, parseHealth: 'complete' as const,
      }
      const items = rediscoveryCase === 'missing'
        ? []
        : rediscoveryCase === 'ambiguous'
          ? [item, { ...item, discoveryId: 'another-process-handle' }]
          : rediscoveryCase === 'mismatch'
            ? [{ ...item, fingerprint: 'changed-fingerprint' }]
            : [item]
      return {
        items,
        scannedAt: '2026-01-01T00:00:00.000Z',
      }
    },
    preview: async () => ({
      source: { discoveryId: newRef, source: 'codex', sessionId: normalized.source.sessionId, rolloutRevisionId: normalized.source.rolloutRevisionId, fingerprint: normalized.source.fingerprint, cwd, archived: false, updatedAt: '2026-01-01T00:00:00.000Z', messageCount: 0, toolCallCount: 0, byteSize: 1, parseHealth: 'complete' },
      estimatedTokens: 1, estimator: 'fallback', largestRecords: [], snippets: [], completeness: normalized.completeness, diagnostics: [],
    }),
    load: async ref => {
      calls.load.push(ref.discoveryId)
      if (restarted && ref.discoveryId === oldRef) throw new HandoffError({ code: 'SOURCE_STALE', message: 'old handle', recoverable: true })
      if (ref.discoveryId !== oldRef && ref.discoveryId !== newRef) throw new HandoffError({ code: 'SOURCE_STALE', message: 'unknown handle', recoverable: true })
      return normalized
    },
  }
  return { source, restart: () => { restarted = true }, calls }
}

function runtimeFor(sourceMode: 'smart' | 'full' = 'full'): DshGatewayRuntime {
  const sessions = new Map<string, unknown>()
  const observeSession = async (id: string) => {
    const session = sessions.get(String(id)) as {
      readonly header: Record<string, unknown>
      snapshotEvents(): readonly unknown[]
    } | undefined
    if (session === undefined) {
      throw Object.assign(new Error('session not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
    }
    const header = structuredClone(session.header)
    const events = session.snapshotEvents().map(event => structuredClone(event))
    const makeLease = () => ({
      source: 'live' as const,
      header,
      events,
      cursor: events.length === 0 ? -1 : (events.at(-1) as { seq: number }).seq,
      inheritedEventCount: 0,
      retain: makeLease,
      [Symbol.dispose]: () => undefined,
    })
    return makeLease()
  }
  return {
    agents: {
      create: async (options: { readonly sessionId: string; readonly meta: { readonly cwd: string } }) => {
        const events = [{
          type: 'user/message',
          seq: 0,
          time: 0,
          surfaceOp: 'append',
          data: {
            id: 'codex-handoff-notice',
            role: 'user',
            content: [{ type: 'text', text: 'Imported read-only Codex history; historical tools were not executed.' }],
            source: {
              kind: 'plugin:dsh-codex-handoff', sourceAgent: 'codex', sourceSessionId: 'source-session-1',
              rolloutRevisionId: 'rollout-1', fingerprint: 'fingerprint-123456', mode: sourceMode, compilerSchema: '1.0.0',
              form: 'notice', summary: 'Imported read-only Codex history; historical tools were not executed.',
            },
          },
        }]
        const session = {
          header: { version: 4, id: options.sessionId, cwd: options.meta.cwd, isSeeded: false },
          snapshotEvents: () => events,
        }
        sessions.set(options.sessionId, session)
        return { agent: { id: options.sessionId, session }, dispose: async () => undefined }
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock' }) },
    sessionQuery: { observeSession },
    sessionPersistence: {},
    workspaceRegistry: { resolveByPath: async () => ({ attachSession: async () => undefined }) },
    storageDomain: { open: async () => ({ table: () => ({}) }) },
    typert: {},
  } as unknown as DshGatewayRuntime
}

describe('Host recovery source rediscovery', () => {
  it('replaces a process-bound discovery handle through bounded rediscovery after restart', async () => {
    const cwd = process.cwd()
    const sourceState = sourceWithRestart(cwd)
    const normalized = makeSession(cwd)
    const cwdIdentity = await readWorkspaceIdentity(cwd, new AbortController().signal)
    const oldSource = { discoveryId: 'old-process-handle', source: 'codex' as const, sessionId: 'source-session-1', rolloutRevisionId: 'rollout-1', expectedFingerprint: 'fingerprint-123456', archived: false }
    const seed = compileFullSeed(normalized).seed
    const request = PreparedImportSchema.parse({
      source: oldSource,
      sourceFingerprint: normalized.source.fingerprint,
      mode: 'full', cwd, seed,
      identity: computeImportIdentity({ source: oldSource, sourceFingerprint: normalized.source.fingerprint, mode: 'full', cwd }),
      cwdIdentity,
    })
    const backing = new MemoryImportIndex()
    let crashAtCreating = true
    const crashingIndex = {
      get: (key: string) => backing.get(key),
      list: () => backing.list(),
      put: async (record: Parameters<MemoryImportIndex['put']>[0], expected?: Parameters<MemoryImportIndex['put']>[1]) => {
        if (crashAtCreating && record.state === 'creating') { crashAtCreating = false; throw new Error('crash after prepared') }
        await backing.put(record, expected)
      },
    }
    const first = createHostComposition({ runtime: runtimeFor(), source: sourceState.source, repository: { inspect: async () => ({ observedAt: new Date().toISOString(), cwd: { requested: cwd, canonical: cwd, exists: true }, relevantPaths: [], diagnostics: [] }) } as never, engine: new SmartHandoffEngine(), index: crashingIndex })
    await expect(first.gateway.create(request, new AbortController().signal)).rejects.toMatchObject({ code: 'IMPORT_ID_CONFLICT' })
    expect((await backing.get(request.identity.key))?.state).toBe('prepared')

    sourceState.restart()
    const restarted = createHostComposition({ runtime: runtimeFor(), source: sourceState.source, repository: { inspect: async () => ({ observedAt: new Date().toISOString(), cwd: { requested: cwd, canonical: cwd, exists: true }, relevantPaths: [], diagnostics: [] }) } as never, engine: new SmartHandoffEngine(), index: backing })
    const recovered = await restarted.gateway.recover(new AbortController().signal)
    expect(recovered[0]).toMatchObject({ state: 'created' })
    expect(sourceState.calls.discover).toBeGreaterThan(0)
    expect(sourceState.calls.load).toContain('new-process-handle')
    expect((await backing.get(request.identity.key))?.state).toBe('created')
  })

  it.each(['missing', 'ambiguous', 'mismatch'] as const)('fails closed for %s rediscovery without loading the stale handle or creating a destination', async (rediscoveryCase) => {
    const cwd = process.cwd()
    const sourceState = sourceWithRestart(cwd, rediscoveryCase)
    const normalized = makeSession(cwd)
    const oldSource = { discoveryId: 'old-process-handle', source: 'codex' as const, sessionId: 'source-session-1', rolloutRevisionId: 'rollout-1', expectedFingerprint: 'fingerprint-123456', archived: false }
    const seed = compileFullSeed(normalized).seed
    const request = PreparedImportSchema.parse({
      source: oldSource,
      sourceFingerprint: normalized.source.fingerprint,
      mode: 'full', cwd, seed,
      identity: computeImportIdentity({ source: oldSource, sourceFingerprint: normalized.source.fingerprint, mode: 'full', cwd }),
    })
    const backing = new MemoryImportIndex()
    let crashAtCreating = true
    const crashingIndex = {
      get: (key: string) => backing.get(key),
      list: () => backing.list(),
      put: async (record: Parameters<MemoryImportIndex['put']>[0], expected?: Parameters<MemoryImportIndex['put']>[1]) => {
        if (crashAtCreating && record.state === 'creating') { crashAtCreating = false; throw new Error('crash after prepared') }
        await backing.put(record, expected)
      },
    }
    const first = createHostComposition({ runtime: runtimeFor(), source: sourceState.source, repository: { inspect: async () => ({ observedAt: new Date().toISOString(), cwd: { requested: cwd, canonical: cwd, exists: true }, relevantPaths: [], diagnostics: [] }) } as never, engine: new SmartHandoffEngine(), index: crashingIndex })
    await expect(first.gateway.create(request, new AbortController().signal)).rejects.toMatchObject({ code: 'IMPORT_ID_CONFLICT' })
    expect((await backing.get(request.identity.key))?.state).toBe('prepared')

    sourceState.restart()
    const loadsBeforeRecovery = sourceState.calls.load.length
    const restarted = createHostComposition({ runtime: runtimeFor(), source: sourceState.source, repository: { inspect: async () => ({ observedAt: new Date().toISOString(), cwd: { requested: cwd, canonical: cwd, exists: true }, relevantPaths: [], diagnostics: [] }) } as never, engine: new SmartHandoffEngine(), index: backing })
    const recovered = await restarted.gateway.recover(new AbortController().signal)
    expect(recovered[0]).toMatchObject({ state: 'orphaned', failure: { code: 'SOURCE_FINGERPRINT_UNAVAILABLE' } })
    expect(sourceState.calls.load.slice(loadsBeforeRecovery)).not.toContain('old-process-handle')
    expect((await backing.get(request.identity.key))?.state).toBe('orphaned')
  })

  it('migrates a v1 row only after a unique all-state fingerprint search', async () => {
    const cwd = process.cwd()
    const sourceState = sourceWithRestart(cwd)
    const requestKey = computeImportIdentity({
      source: { sessionId: 'source-session-1', rolloutRevisionId: 'rollout-1', source: 'codex' as const, discoveryId: 'legacy-ref' },
      sourceFingerprint: 'fingerprint-123456', mode: 'full', cwd,
    })
    let row: ImportRecordRead = {
      schemaVersion: 1,
      key: requestKey.key,
      sourceSessionId: 'source-session-1',
      sourceRolloutRevisionId: 'rollout-1',
      sourceFingerprint: 'fingerprint-123456',
      mode: 'full',
      cwd,
      destinationSessionId: requestKey.destinationSessionId,
      state: 'prepared',
      sourceFingerprintBefore: 'fingerprint-123456',
      attemptId: 'legacy-attempt',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const index = {
      get: async () => row,
      list: async () => [row],
      put: async (next: Parameters<MemoryImportIndex['put']>[0]) => { row = next },
    }
    const composition = createHostComposition({ runtime: runtimeFor(), source: sourceState.source, repository: { inspect: async () => ({ observedAt: new Date().toISOString(), cwd: { requested: cwd, canonical: cwd, exists: true }, relevantPaths: [], diagnostics: [] }) } as never, engine: new SmartHandoffEngine(), index })
    const recovered = await composition.gateway.recover(new AbortController().signal)
    expect(recovered[0]).toMatchObject({ schemaVersion: 2, state: 'prepared' })
    expect(row.schemaVersion).toBe(2)
    expect(sourceState.calls.discover).toBe(1)
    expect(sourceState.calls.load).toContain('new-process-handle')
  })

  it('replays an enhanced Smart seed without repository or analyzer work after restart', async () => {
    const cwd = process.cwd()
    const sourceState = sourceWithRestart(cwd)
    const source = { discoveryId: 'old-process-handle', source: 'codex' as const, sessionId: 'source-session-1', rolloutRevisionId: 'rollout-1', expectedFingerprint: 'fingerprint-123456', archived: false }
    const cwdIdentity = await readWorkspaceIdentity(cwd, new AbortController().signal)
    const seed = [...MINIMAL_DSH_SEED]
    const request = PreparedImportSchema.parse({
      source,
      sourceFingerprint: source.expectedFingerprint,
      mode: 'smart',
      cwd,
      seed,
      targetTokens: 4096,
      useModel: true,
      identity: computeImportIdentity({ source, sourceFingerprint: source.expectedFingerprint, mode: 'smart', cwd }),
      cwdIdentity,
    })
    const backing = new MemoryImportIndex()
    let crashAtCreating = true
    const crashingIndex = {
      get: (key: string) => backing.get(key),
      list: () => backing.list(),
      put: async (record: Parameters<MemoryImportIndex['put']>[0], expected?: Parameters<MemoryImportIndex['put']>[1]) => {
        if (crashAtCreating && record.state === 'creating') { crashAtCreating = false; throw new Error('crash before Smart create') }
        await backing.put(record, expected)
      },
    }
    const repository = { inspect: vi.fn(async () => ({ observedAt: new Date().toISOString(), cwd: { requested: cwd, canonical: cwd, exists: true }, relevantPaths: [], diagnostics: [] })) }
    const engine = new SmartHandoffEngine()
    const build = vi.spyOn(engine, 'build')
    const first = createHostComposition({ runtime: runtimeFor('smart'), source: sourceState.source, repository: repository as never, engine, index: crashingIndex })
    await expect(first.gateway.create(request, new AbortController().signal)).rejects.toMatchObject({ code: 'IMPORT_ID_CONFLICT' })
    const preparedRow = await backing.get(request.identity.key)
    expect(preparedRow).toMatchObject({ state: 'prepared', recovery: { targetTokens: 4096, useModel: true, seed } })
    expect(JSON.stringify(preparedRow)).not.toContain('super-secret-canary')
    sourceState.restart()
    const restarted = createHostComposition({ runtime: runtimeFor('smart'), source: sourceState.source, repository: repository as never, engine, index: backing })
    await expect(restarted.gateway.recover(new AbortController().signal)).resolves.toMatchObject([{ state: 'created' }])
    expect(build).not.toHaveBeenCalled()
    expect((await backing.get(request.identity.key))?.state).toBe('created')
  })

  it('derives archived from the loaded session when the client omits the optional hint', async () => {
    const cwd = process.cwd()
    const sourceState = sourceWithRestart(cwd)
    const index = new MemoryImportIndex()
    const composition = createHostComposition({
      runtime: {
        ...runtimeFor(),
        workspaceRegistry: {
          resolveByPath: async () => undefined,
          create: async () => { throw new Error('workspace attach intentionally unavailable') },
        },
      },
      source: sourceState.source,
      repository: { inspect: async () => ({ observedAt: new Date().toISOString(), cwd: { requested: cwd, canonical: cwd, exists: true }, relevantPaths: [], diagnostics: [] }) } as never,
      index,
    })
    const request: CreateRequest = {
      source: { discoveryId: 'old-process-handle', source: 'codex', sessionId: 'source-session-1', rolloutRevisionId: 'rollout-1', expectedFingerprint: 'fingerprint-123456' },
      cwd,
      expectedFingerprint: 'fingerprint-123456',
      mode: 'full',
      consent: { disclosureVersion: 'full-v1', accepted: true, acceptedMode: 'full', modelAnalysis: false, fullPersistence: true },
      full: {},
    }
    await expect(composition.remote.create(request, new AbortController().signal)).resolves.toMatchObject({ state: 'created_unattached' })
    const row = await index.get(computeImportIdentity({ source: request.source, mode: 'full', cwd }).key)
    expect(row?.schemaVersion === 2 ? row.recovery?.source : undefined).toMatchObject({ archived: false, expectedFingerprint: 'fingerprint-123456' })
  })
})

describe('Host storage-domain lifecycle', () => {
  it('reads optional DSH services through a contained official getter', () => {
    const requested: string[] = []
    const optional = {
      agentPresets: { resolve: async () => ({ id: 'default' }), mount: async () => undefined },
      llm: { stream: () => undefined },
      dshVersion: '2.0.0',
      observedSessionFormat: 2,
    }
    const ctx = {
      ...runtimeFor(),
      typert: {},
      get: (name: string) => {
        requested.push(name)
        if (name in optional) return optional[name as keyof typeof optional]
        throw new Error(`unknown service: ${name}`)
      },
    }
    const runtime = runtimeFromContext(ctx)
    expect(runtime.agents).toBeDefined()
    expect(runtime.agentPresets).toBe(optional.agentPresets)
    expect(runtime.llm).toBe(optional.llm)
    expect(runtime.dshVersion).toBe('2.0.0')
    expect(runtime.observedSessionFormat).toBe(2)
    expect(requested).toEqual(['agentPresets', 'llm', 'dshVersion', 'observedSessionFormat'])
  })

  it('does not read missing optional services through a throwing Cordis proxy', () => {
    const requested: string[] = []
    const ctx = new Proxy(runtimeFor() as Record<string, unknown>, {
      get(target, property, receiver) {
        if (property === 'get') return (name: string) => { requested.push(name); throw new Error(`unknown service: ${name}`) }
        if (typeof property === 'string' && !(property in target)) throw new Error(`uninjected property: ${property}`)
        return Reflect.get(target, property, receiver)
      },
    })
    const runtime = runtimeFromContext(ctx)
    expect(runtime.agents).toBeDefined()
    expect(runtime.agentPresets).toBeUndefined()
    expect(runtime.llm).toBeUndefined()
    expect(runtime.dshVersion).toBeUndefined()
    expect(runtime.observedSessionFormat).toBeUndefined()
    expect(requested).toEqual(['agentPresets', 'llm', 'dshVersion', 'observedSessionFormat'])
  })

  it('closes the owned ledger domain on dispose so apply can reopen the same name', async () => {
    let row: unknown
    let open = false
    let opens = 0
    let closes = 0
    const table = {
      get: async (key: string) => key === 'imports' ? row : undefined,
      put: async (key: string, value: unknown) => { if (key === 'imports') row = value },
      update: async (key: string, updater: (latest: unknown) => unknown) => {
        if (key !== 'imports') throw new Error('unexpected table key')
        row = updater(row)
        return row
      },
    }
    const storageDomain = {
      open: async () => {
        if (open) throw new Error('domain already open')
        open = true
        opens += 1
        return { table: () => table, close: async () => { open = false; closes += 1 } }
      },
    }
    const sourceState = sourceWithRestart(process.cwd())
    const disposers: Array<() => Promise<void>> = []
    let effectLabel: string | undefined
    const runtime = runtimeFor()
    const ctx = {
      ...runtime,
      storageDomain,
      typert: {},
      provide: async () => undefined,
      effect: async (setup: () => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>, label?: string) => {
        effectLabel = label
        const dispose = await setup()
        if (typeof dispose === 'function') disposers.push(async () => { await dispose() })
      },
    }
    const options = {
      source: sourceState.source,
      repository: { inspect: async () => ({ observedAt: new Date().toISOString(), cwd: { requested: process.cwd(), canonical: process.cwd(), exists: true }, relevantPaths: [], diagnostics: [] }) } as never,
    }
    await apply(ctx, options)
    expect(opens).toBe(1)
    expect(effectLabel).toBe('codex-handoff host')
    await disposers.shift()!()
    expect(closes).toBe(1)
    await apply(ctx, options)
    expect(opens).toBe(2)
    await disposers.shift()!()
    expect(closes).toBe(2)
    expect(open).toBe(false)
  })

  it('rolls back the domain when codexHandoff service binding fails', async () => {
    let row: unknown
    let closes = 0
    const table = {
      get: async (key: string) => key === 'imports' ? row : undefined,
      put: async (key: string, value: unknown) => { if (key === 'imports') row = value },
      update: async (_key: string, updater: (latest: unknown) => unknown) => { row = updater(row); return row },
    }
    const storageDomain = { open: async () => ({ table: () => table, close: async () => { closes += 1 } }) }
    const runtime = runtimeFor()
    const ctx = {
      ...runtime,
      storageDomain,
      typert: {},
      provide: async () => { throw new Error('service binding failed') },
      effect: async () => undefined,
    }
    await expect(apply(ctx, {
      source: sourceWithRestart(process.cwd()).source,
      repository: { inspect: async () => ({ observedAt: new Date().toISOString(), cwd: { requested: process.cwd(), canonical: process.cwd(), exists: true }, relevantPaths: [], diagnostics: [] }) } as never,
    })).rejects.toThrow('service binding failed')
    expect(closes).toBe(1)
  })
})

describe('Host Smart runtime wiring', () => {
  const repository = {
    inspect: async (cwd: string) => ({
      observedAt: new Date().toISOString(),
      cwd: { requested: cwd, canonical: cwd, exists: true },
      relevantPaths: [],
      diagnostics: [],
    }),
  } as never

  function modelRequest(cwd: string) {
    return {
      source: {
        discoveryId: 'old-process-handle',
        source: 'codex' as const,
        sessionId: 'source-session-1',
        rolloutRevisionId: 'rollout-1',
        expectedFingerprint: 'fingerprint-123456',
        archived: false,
      },
      cwd,
      expectedFingerprint: 'fingerprint-123456',
      useModel: true as const,
      consent: {
        disclosureVersion: 'smart-v1' as const,
        accepted: true as const,
        acceptedMode: 'smart' as const,
        modelAnalysis: true as const,
        fullPersistence: false as const,
      },
    }
  }

  it('connects the default Smart engine to the runtime model and llm stream', async () => {
    const cwd = process.cwd()
    const sourceState = sourceWithRestart(cwd)
    const stream = vi.fn(() => (async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: 'fixture stream failure' } }
    })())
    const composition = createHostComposition({
      runtime: { ...runtimeFor(), llm: { stream } },
      source: sourceState.source,
      repository,
    })

    const result = await composition.remote.analyze(modelRequest(cwd))
    expect(stream).toHaveBeenCalledOnce()
    expect(result.degraded).toBe(true)
    expect(result.diagnostics.some(item => item.code === 'SMART_ANALYZER_DEGRADED')).toBe(true)
  })

  it('falls back deterministically and marks degraded when model selection is unavailable', async () => {
    const cwd = process.cwd()
    const sourceState = sourceWithRestart(cwd)
    const stream = vi.fn(() => (async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    })())
    const composition = createHostComposition({
      runtime: {
        ...runtimeFor(),
        agentDefaultModel: { currentSelection: () => undefined } as never,
        llm: { stream },
      },
      source: sourceState.source,
      repository,
    })

    const result = await composition.remote.analyze(modelRequest(cwd))
    expect(result.degraded).toBe(true)
    expect(stream).not.toHaveBeenCalled()
    expect(result.diagnostics.some(item => item.code === 'SMART_ANALYZER_DEGRADED')).toBe(true)
  })
})
