import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'

import { createStorageDomainReturnStore, MemoryReturnStore, ReturnSyncService, RETURN_LEDGER_DOMAIN_SPEC, type ReturnStore } from '../../src/host/return-sync.js'
import { createHostCompositionAsync } from '../../src/host/index.js'
import { CodexSessionSource } from '../../src/codex/resolver.js'
import { RETURN_CONTEXT_SOFT_LIMIT_BYTES } from '../../src/shared/return.js'
import { AppServerFailure, type CodexAppServer } from '../../src/codex/app-server.js'
import type { DshGatewayRuntime, DshStorageDomainService, ImportIndex } from '../../src/dsh/gateway.js'
import type { RepositoryInspector, SessionSource } from '../../src/shared/ports.js'
import type { ImportRecordRead, NormalizedSession, RepositoryState } from '../../src/shared/types.js'

class FreshGlobalSingleton {
  private durableValue: unknown
  setCalls = 0
  constructor(private readonly initial: unknown) {}
  get(): unknown { return structuredClone(this.durableValue ?? this.initial) }
  async set(value: unknown): Promise<void> {
    this.setCalls += 1
    this.durableValue = structuredClone(value)
  }
}

function deferred<T = void>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(resolveValue => { resolvePromise = resolveValue })
  return { promise, resolve: resolvePromise }
}

async function freshStore() {
  const global = new FreshGlobalSingleton(RETURN_LEDGER_DOMAIN_SPEC.global.initial)
  const missingTableKeyUpdates = vi.fn(async () => { throw new Error('missing-key') })
  const storageDomain = {
    open: vi.fn(async (spec: typeof RETURN_LEDGER_DOMAIN_SPEC) => {
      expect(spec.global).toBeDefined()
      expect(Object.keys(spec.tables)).toEqual([])
      return {
        global,
        table: () => ({ get: vi.fn(), put: vi.fn(), update: missingTableKeyUpdates }),
        close: vi.fn(async () => undefined),
      }
    }),
  } as unknown as DshStorageDomainService
  const store = await createStorageDomainReturnStore(storageDomain)
  return { store, global, missingTableKeyUpdates }
}

function currentGit(repoRoot: string, changes: Partial<NonNullable<RepositoryState['git']>> = {}): NonNullable<RepositoryState['git']> {
  return {
    repoRoot, branch: 'main', detached: false, head: 'f'.repeat(40), dirty: false,
    modified: [], added: [], deleted: [], renamed: [], untracked: [], staged: [], unstaged: [], recentCommits: [],
    ...changes,
  }
}

async function createFixture() {
  const cwd = await mkdtemp(resolve(tmpdir(), 'dsh-return-cas-'))
  const fingerprint = 'a'.repeat(64)
  let observedCursor = 7
  let observedRevision: string | undefined = 'revision-7'
  let loadedFingerprint = fingerprint
  let nextCursor: string | undefined
  let withoutGit = false
  let gitChanges: Partial<NonNullable<RepositoryState['git']>> = {}
  let events: readonly unknown[] = [
    { type: 'user/message', seq: 0, data: { source: {
      kind: 'plugin:dsh-codex-handoff', sourceAgent: 'codex', compilerSchema: '1.0.0',
      sourceSessionId: 'codex-source-1', rolloutRevisionId: 'rollout-1', fingerprint, mode: 'full',
    } } },
    { type: 'user/message', seq: 7, data: { content: 'Continue the exact integration task.' } },
    { type: 'tool/result', seq: 8, data: { message: { content: 'The verification command failed.', isError: true } } },
  ]
  const observation = {
    header: { id: 'dsh-session-1', cwd },
    get cursor() { return observedCursor },
    get revision() { return observedRevision },
    get events() { return events },
    [Symbol.dispose]: vi.fn(),
  }
  const sessionQuery = {
    observeSession: vi.fn(async () => observation),
  }
  const importRecord = {
    schemaVersion: 2,
    state: 'created',
    destinationSessionId: 'dsh-session-1',
    cwd,
    sourceSessionId: 'codex-source-1',
    sourceRolloutRevisionId: 'rollout-1',
    sourceFingerprint: fingerprint,
    mode: 'full',
  } as unknown as ImportRecordRead
  const importIndex = { list: vi.fn(async () => [importRecord]) } as unknown as ImportIndex
  const summary = {
    discoveryId: 'opaque-source-ref', source: 'codex', sessionId: 'codex-source-1', rolloutRevisionId: 'rollout-1',
    fingerprint, updatedAt: new Date(0).toISOString(), archived: false, messageCount: 3, toolCallCount: 0,
    byteSize: 100, parseHealth: 'complete', cwd,
  }
  const source: SessionSource = {
    kind: 'codex',
    discover: vi.fn(async () => ({ items: [summary] as never[], ...(nextCursor === undefined ? {} : { nextCursor }), scannedAt: new Date(0).toISOString() })),
    preview: vi.fn(async () => { throw new Error('preview is not used by return synchronization') }),
    load: vi.fn(async () => ({ source: {
      sessionId: 'codex-source-1', rolloutRevisionId: 'rollout-1', fingerprint: loadedFingerprint, cwd, archived: false,
    } } as unknown as NormalizedSession)),
  }
  let observedAt = 0
  const repository: RepositoryInspector = {
    inspect: vi.fn(async canonical => ({
      observedAt: new Date(observedAt++).toISOString(),
      cwd: { requested: canonical, canonical, exists: true },
      ...(withoutGit ? {} : { git: currentGit(canonical, gitChanges) }),
      relevantPaths: [], diagnostics: [],
    } as RepositoryState)),
  }

  return {
    cwd, fingerprint, observation, sessionQuery, importIndex, source, repository,
    setCursor(value: number) { observedCursor = value },
    setRevision(value: string | undefined) { observedRevision = value },
    setFingerprint(value: string) { loadedFingerprint = value },
    setEvents(value: readonly unknown[]) { events = value },
    setNextCursor(value: string | undefined) { nextCursor = value },
    setGit(value: Partial<NonNullable<RepositoryState['git']>> | null) {
      withoutGit = value === null
      gitChanges = value ?? {}
    },
  }
}

function fakeServer(
  options: {
    readonly home?: string
    readonly fork?: CodexAppServer['fork']
    readonly inject?: CodexAppServer['injectUserContext']
  } = {},
): CodexAppServer {
  return {
    binary: '/trusted/codex',
    codexHome: options.home ?? '/trusted/home',
    fork: options.fork ?? vi.fn(async (sourceThreadId: string) => ({ forkId: 'derived-fork', sourceThreadId })),
    injectUserContext: options.inject ?? vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  }
}

function serviceFor(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  options: {
    readonly store?: ReturnStore
    readonly now?: () => Date
    readonly appServerFactory?: (codexHome: string | undefined) => Promise<CodexAppServer>
  } = {},
): ReturnSyncService {
  return new ReturnSyncService({
    source: fixture.source,
    repository: fixture.repository,
    importIndex: fixture.importIndex,
    sessionQuery: fixture.sessionQuery,
    store: options.store ?? new MemoryReturnStore(),
    codexHome: '/trusted/home',
    appServerFactory: options.appServerFactory ?? vi.fn(async () => fakeServer()),
    now: options.now ?? (() => new Date('2026-10-02T00:00:00.000Z')),
  })
}

describe('ReturnSyncService durable dispatch claims', () => {
  it('rejects a conflicting source home before opening the import domain', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'dsh-return-home-'))
    try {
      const sourceHome = resolve(directory, 'source-home')
      const otherHome = resolve(directory, 'other-home')
      const source = new CodexSessionSource({ codexHome: sourceHome })
      const open = vi.fn()
      const runtime = { storageDomain: { open } } as unknown as DshGatewayRuntime
      await expect(createHostCompositionAsync({ runtime, source, codexHome: otherHome }))
        .rejects.toMatchObject({ code: 'RETURN_NOT_SUPPORTED' })
      expect(open).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  for (const corruption of ['missing', 'conflicting'] as const) {
    it(`fails closed on ${corruption} import provenance without creating a Codex fork`, async () => {
      const fixture = await createFixture()
      const serverFactory = vi.fn(async () => fakeServer())
      const service = serviceFor(fixture, { appServerFactory: serverFactory })
      try {
        const original = fixture.observation.events ?? []
        if (corruption === 'missing') fixture.setEvents(original.slice(1))
        else {
          const first = original[0] as { type: string; seq: number; data: { source: Record<string, unknown> } }
          fixture.setEvents([...original, { ...structuredClone(first), seq: 9, data: { source: { ...first.data.source, fingerprint: 'b'.repeat(64) } } }])
        }
        await expect(service.returnPreview({ dshSessionId: 'dsh-session-1' }))
          .rejects.toMatchObject({ code: 'RETURN_SOURCE_METADATA_MISSING' })
        expect(serverFactory).not.toHaveBeenCalled()
      } finally {
        await service.close()
        await rm(fixture.cwd, { recursive: true, force: true })
      }
    })
  }

  it('requires a reliable Git workspace and refuses sensitive dirty paths without reading their content', async () => {
    const fixture = await createFixture()
    const service = serviceFor(fixture)
    try {
      fixture.setGit(null)
      await expect(service.returnPreview({ dshSessionId: 'dsh-session-1' })).rejects.toMatchObject({ code: 'RETURN_NOT_SUPPORTED' })
      fixture.setGit({ dirty: true, modified: [{ path: '.env', index: false, worktree: true }] })
      await writeFile(resolve(fixture.cwd, '.env'), 'token=secret-material-must-not-leak')
      const failure = await service.returnPreview({ dshSessionId: 'dsh-session-1' }).catch(error => error)
      expect(failure).toMatchObject({ code: 'RETURN_NOT_SUPPORTED' })
      expect(String(failure)).not.toContain('secret-material-must-not-leak')
    } finally {
      await service.close()
      await rm(fixture.cwd, { recursive: true, force: true })
    }
  })

  it('rejects an expired receipt before dispatch', async () => {
    const fixture = await createFixture()
    const now = { value: new Date('2026-10-02T00:00:00.000Z') }
    const factory = vi.fn(async () => fakeServer())
    const service = serviceFor(fixture, { now: () => now.value, appServerFactory: factory })
    try {
      const preview = await service.returnPreview({ dshSessionId: 'dsh-session-1' })
      now.value = new Date(Date.parse(preview.expiresAt) + 1)
      await expect(service.returnSync({ receiptId: preview.receiptId })).rejects.toMatchObject({ code: 'RETURN_PREVIEW_EXPIRED' })
      expect(factory).not.toHaveBeenCalled()
    } finally {
      await service.close()
      await rm(fixture.cwd, { recursive: true, force: true })
    }
  })

  for (const staleCase of ['source fingerprint', 'DSH cursor', 'Git HEAD', 'same-size dirty file contents'] as const) {
    it(`rejects a stale ${staleCase} snapshot before Codex dispatch`, async () => {
      const fixture = await createFixture()
      const factory = vi.fn(async () => fakeServer())
      const service = serviceFor(fixture, { appServerFactory: factory })
      let previous: Awaited<ReturnType<typeof stat>> | undefined
      try {
        if (staleCase === 'same-size dirty file contents') {
          const file = resolve(fixture.cwd, 'tracked.txt')
          await writeFile(file, 'AAAA')
          previous = await stat(file)
          fixture.setGit({ dirty: true, modified: [{ path: 'tracked.txt', index: false, worktree: true }] })
        }
        const preview = await service.returnPreview({ dshSessionId: 'dsh-session-1' })
        if (staleCase === 'source fingerprint') fixture.setFingerprint('b'.repeat(64))
        else if (staleCase === 'DSH cursor') fixture.setCursor(8)
        else if (staleCase === 'Git HEAD') fixture.setGit({ head: 'e'.repeat(40) })
        else {
          const file = resolve(fixture.cwd, 'tracked.txt')
          await writeFile(file, 'BBBB')
          if (previous !== undefined) await utimes(file, previous.atime, previous.mtime)
        }
        await expect(service.returnSync({ receiptId: preview.receiptId })).rejects.toMatchObject({ code: 'RETURN_STALE' })
        expect(factory).not.toHaveBeenCalled()
      } finally {
        await service.close()
        await rm(fixture.cwd, { recursive: true, force: true })
      }
    })
  }

  it('rejects a bounded Codex search that still has a continuation cursor', async () => {
    const fixture = await createFixture()
    const service = serviceFor(fixture)
    try {
      fixture.setNextCursor('still-more')
      await expect(service.returnPreview({ dshSessionId: 'dsh-session-1' })).rejects.toMatchObject({ code: 'RETURN_STALE' })
      expect(fixture.source.discover).toHaveBeenCalled()
    } finally {
      await service.close()
      await rm(fixture.cwd, { recursive: true, force: true })
    }
  })

  it('resets a prepared receipt when app-server setup fails before sending fork, then safely retries', async () => {
    const fixture = await createFixture()
    const server = fakeServer()
    const factory = vi.fn()
      .mockRejectedValueOnce(new Error('isolated server unavailable before request'))
      .mockResolvedValueOnce(server)
    const service = serviceFor(fixture, { appServerFactory: factory })
    try {
      const preview = await service.returnPreview({ dshSessionId: 'dsh-session-1' })
      await expect(service.returnSync({ receiptId: preview.receiptId })).rejects.toMatchObject({ code: 'CODEX_APP_SERVER_UNAVAILABLE' })
      await expect(service.returnSync({ receiptId: preview.receiptId })).resolves.toMatchObject({ status: 'created', codexForkId: 'derived-fork' })
      expect(factory).toHaveBeenCalledTimes(2)
      expect(server.fork).toHaveBeenCalledTimes(1)
      expect(server.injectUserContext).toHaveBeenCalledTimes(1)
    } finally {
      await service.close()
      await rm(fixture.cwd, { recursive: true, force: true })
    }
  })

  for (const ambiguousPhase of ['fork', 'inject'] as const) {
    it(`makes a possibly-sent ${ambiguousPhase} request terminal unknown and never repeats it`, async () => {
      const fixture = await createFixture()
      const fork = vi.fn(async (sourceThreadId: string) => {
        if (ambiguousPhase === 'fork') throw new AppServerFailure({ sent: true, remote: false, method: 'thread/fork' })
        return { forkId: 'ambiguous-fork', sourceThreadId }
      })
      const inject = vi.fn(async () => {
        if (ambiguousPhase === 'inject') throw new AppServerFailure({ sent: true, remote: false, method: 'thread/inject_items' })
      })
      const server = fakeServer({ fork, inject })
      const service = serviceFor(fixture, { appServerFactory: async () => server })
      try {
        const preview = await service.returnPreview({ dshSessionId: 'dsh-session-1' })
        await expect(service.returnSync({ receiptId: preview.receiptId })).resolves.toMatchObject({ status: 'unknown' })
        const reused = await service.returnPreview({ dshSessionId: 'dsh-session-1' })
        expect(reused.receiptId).toBe(preview.receiptId)
        await expect(service.returnSync({ receiptId: preview.receiptId })).resolves.toMatchObject({ status: 'unknown' })
        expect(fork).toHaveBeenCalledTimes(1)
        expect(inject).toHaveBeenCalledTimes(ambiguousPhase === 'inject' ? 1 : 0)
      } finally {
        await service.close()
        await rm(fixture.cwd, { recursive: true, force: true })
      }
    })
  }

  it('does not inject when persisting the fork transition fails and records an unknown result', async () => {
    const fixture = await createFixture()
    const store = new MemoryReturnStore()
    const persist = store.update.bind(store)
    let failForkTransition = true
    vi.spyOn(store, 'update').mockImplementation(async (receiptId, expected, expectedAttemptId, next) => {
      if (failForkTransition && next.state === 'forked') {
        failForkTransition = false
        throw new Error('synthetic durable commit failure')
      }
      return await persist(receiptId, expected, expectedAttemptId, next)
    })
    const fork = vi.fn(async (sourceThreadId: string) => ({ forkId: 'committed-fork', sourceThreadId }))
    const inject = vi.fn(async () => undefined)
    const service = serviceFor(fixture, { store, appServerFactory: async () => fakeServer({ fork, inject }) })
    try {
      const preview = await service.returnPreview({ dshSessionId: 'dsh-session-1' })
      await expect(service.returnSync({ receiptId: preview.receiptId })).resolves.toMatchObject({ status: 'unknown', codexForkId: 'committed-fork' })
      await expect(service.returnSync({ receiptId: preview.receiptId })).resolves.toMatchObject({ status: 'unknown' })
      expect(fork).toHaveBeenCalledOnce()
      expect(inject).not.toHaveBeenCalled()
    } finally {
      await service.close()
      await rm(fixture.cwd, { recursive: true, force: true })
    }
  })

  it('returns an ACK-known fork id as unknown even if durable recovery writes also fail', async () => {
    const fixture = await createFixture()
    const store = new MemoryReturnStore()
    const persist = store.update.bind(store)
    vi.spyOn(store, 'update').mockImplementation(async (receiptId, expected, expectedAttemptId, next) => {
      if (next.state === 'forked' || next.state === 'unknown') throw new Error('synthetic durable commit failure')
      return await persist(receiptId, expected, expectedAttemptId, next)
    })
    const fork = vi.fn(async (sourceThreadId: string) => ({ forkId: 'ack-known-fork', sourceThreadId }))
    const inject = vi.fn(async () => undefined)
    const service = serviceFor(fixture, { store, appServerFactory: async () => fakeServer({ fork, inject }) })
    try {
      const preview = await service.returnPreview({ dshSessionId: 'dsh-session-1' })
      await expect(service.returnSync({ receiptId: preview.receiptId })).resolves.toMatchObject({
        status: 'unknown', codexForkId: 'ack-known-fork', retry: 'reconcile-only',
      })
      await expect(service.returnSync({ receiptId: preview.receiptId })).resolves.toMatchObject({ status: 'unknown' })
      expect(fork).toHaveBeenCalledOnce()
      expect(inject).not.toHaveBeenCalled()
    } finally {
      await service.close()
      await rm(fixture.cwd, { recursive: true, force: true })
    }
  })

  it('rejects a server bound to a different Codex home before fork or injection', async () => {
    const fixture = await createFixture()
    const server = fakeServer({ home: '/untrusted/other-home' })
    const service = serviceFor(fixture, { appServerFactory: async () => server })
    try {
      const preview = await service.returnPreview({ dshSessionId: 'dsh-session-1' })
      await expect(service.returnSync({ receiptId: preview.receiptId })).rejects.toMatchObject({ code: 'CODEX_PROTOCOL_MISMATCH' })
      expect(server.close).toHaveBeenCalledOnce()
      expect(server.fork).not.toHaveBeenCalled()
      expect(server.injectUserContext).not.toHaveBeenCalled()
    } finally {
      await service.close()
      await rm(fixture.cwd, { recursive: true, force: true })
    }
  })

  it('discloses per-event clipping once across goal, latest intent, recent activity, and failures', async () => {
    const fixture = await createFixture()
    const secret = 'return-secret-should-not-leak'
    const oversized = `token=${secret}\n${'界'.repeat(4_000)}`
    fixture.setEvents([
      { type: 'user/message', seq: 0, data: { source: {
        kind: 'plugin:dsh-codex-handoff', sourceAgent: 'codex', compilerSchema: '1.0.0',
        sourceSessionId: 'codex-source-1', rolloutRevisionId: 'rollout-1', fingerprint: fixture.fingerprint, mode: 'full',
      } } },
      { type: 'user/message', seq: 1, data: { content: oversized } },
      { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: oversized }] } } },
      { type: 'tool/call', seq: 3, data: { name: 'compile', arguments: oversized } },
      { type: 'user/message', seq: 4, data: { content: oversized } },
      { type: 'tool/result', seq: 5, data: { message: { content: [{ type: 'text', text: oversized }], isError: true } } },
    ])
    const service = new ReturnSyncService({
      source: fixture.source,
      repository: fixture.repository,
      importIndex: fixture.importIndex,
      sessionQuery: fixture.sessionQuery,
      store: new MemoryReturnStore(),
      now: () => new Date('2026-10-02T00:00:00.000Z'),
    })
    try {
      const preview = await service.returnPreview({ dshSessionId: 'dsh-session-1' })
      const clippingWarnings = preview.warnings.filter(warning => warning.includes('per-event operational limit'))
      expect(clippingWarnings).toHaveLength(1)
      expect(preview.context).toContain('DSH event #5')
      expect(preview.context).toContain('tool result (reported failure)')
      expect(preview.context).not.toContain(secret)
      expect(preview.contextBytes).toBe(Buffer.byteLength(preview.context, 'utf8'))
      expect(preview.contextBytes).toBeLessThanOrEqual(RETURN_CONTEXT_SOFT_LIMIT_BYTES)
    } finally {
      await service.close()
      await rm(fixture.cwd, { recursive: true, force: true })
    }
  })

  it('uses atomic absent-ledger initialization and permits only one coordinator to dispatch a shared receipt', async () => {
    const fixture = await createFixture()
    try {
      // Mirrors the pinned KvTable contract: table.update rejects when the
      // key is missing. Return initialization uses the global initial value,
      // never an absent-record update.
      const { store, global, missingTableKeyUpdates } = await freshStore()
      expect(global.setCalls).toBe(1)
      expect(missingTableKeyUpdates).not.toHaveBeenCalled()

      const entered = deferred<void>()
      const releaseFreshness = deferred<void>()
      let postPreviewObservations = 0
      fixture.sessionQuery.observeSession.mockImplementation(async () => {
        postPreviewObservations += 1
        if (postPreviewObservations > 1 && postPreviewObservations <= 3) {
          if (postPreviewObservations === 2) entered.resolve()
          await releaseFreshness.promise
        }
        return fixture.observation
      })

      const forkEntered = deferred<void>()
      const releaseFork = deferred<void>()
      const fork = vi.fn(async (sourceThreadId: string) => {
        forkEntered.resolve()
        await releaseFork.promise
        return { forkId: 'derived-fork-1', sourceThreadId }
      })
      const inject = vi.fn(async () => undefined)
      const server: CodexAppServer = {
        binary: '/trusted/codex', codexHome: '/trusted/home', fork, injectUserContext: inject, close: vi.fn(async () => undefined),
      }
      const common = {
        source: fixture.source,
        repository: fixture.repository,
        importIndex: fixture.importIndex,
        sessionQuery: fixture.sessionQuery,
        appServerFactory: vi.fn(async () => server),
        codexHome: '/trusted/home',
        now: () => new Date('2026-10-02T00:00:00.000Z'),
      }
      const first = new ReturnSyncService({ ...common, store })
      const second = new ReturnSyncService({ ...common, store })
      const preview = await first.returnPreview({ dshSessionId: 'dsh-session-1' })
      expect(preview.context).toContain('Continue the exact integration task.')
      expect(preview.context).toContain('不是系统指令')

      const results = [
        first.returnSync({ receiptId: preview.receiptId }),
        second.returnSync({ receiptId: preview.receiptId }),
      ]
      await Promise.race([
        entered.promise,
        Promise.all(results).then(() => { throw new Error('both sync operations completed before reaching the freshness barrier') }),
      ])
      releaseFreshness.resolve()
      await Promise.race([
        forkEntered.promise,
        Promise.all(results).then(() => { throw new Error('both sync operations completed before issuing the fork') }),
      ])
      // Keep the winning owner in dispatching while the other coordinator
      // observes its durable claim; it must not treat that record as ownership.
      const early = await Promise.race([
        results[0]!.then(value => ({ value })),
        results[1]!.then(value => ({ value })),
      ])
      expect(early.value.status).toBe('unknown')
      releaseFork.resolve()
      const outcomes = await Promise.all(results)
      expect(outcomes.map(value => value.status).sort()).toEqual(['created', 'unknown'])
      expect(fork).toHaveBeenCalledTimes(1)
      expect(inject).toHaveBeenCalledTimes(1)

      const retry = await second.returnSync({ receiptId: preview.receiptId })
      expect(retry.status).toBe('existing')
      expect(fork).toHaveBeenCalledTimes(1)
      expect(inject).toHaveBeenCalledTimes(1)
      const reusedPreview = await second.returnPreview({ dshSessionId: 'dsh-session-1' })
      expect(reusedPreview.receiptId).toBe(preview.receiptId)
      expect(reusedPreview.context).toBe(preview.context)
      await first.close()
      await second.close()
    } finally {
      await rm(fixture.cwd, { recursive: true, force: true })
    }
  })
})
