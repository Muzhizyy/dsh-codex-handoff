import { describe, expect, it, vi } from 'vitest'

import { HandoffClientModel } from '../../src/client/model.js'
import { consentFor } from '../../src/client/consent.js'
import { previewFor, FakeRemote, FakeSessions, session } from '../fixtures/client/remote.js'

async function prepared(remote = new FakeRemote(), sessions = new FakeSessions()): Promise<{ model: HandoffClientModel; remote: FakeRemote; sessions: FakeSessions }> {
  const model = new HandoffClientModel(remote, sessions, sessions.navigation, { debounceMs: 25 })
  await model.open()
  model.select(session)
  await model.previewSelected()
  model.acceptConsent()
  return { model, remote, sessions }
}

describe('Codex handoff client state machine', () => {
  it('opens through compatibility, discovers, and defaults to model Smart', async () => {
    const remote = new FakeRemote()
    const sessions = new FakeSessions()
    const model = new HandoffClientModel(remote, sessions, sessions.navigation)
    await model.open()

    expect(model.getState().phase).toBe('browsing')
    expect(model.getState().compatibility?.compatible).toBe(true)
    expect(remote.discoverRequests).toHaveLength(1)
    model.select(session)
    await model.previewSelected()
    expect(model.getState().mode).toBe('smart')
    expect(model.getState().useModel).toBe(true)
    expect(model.getState().unlimitedTokens).toBe(true)
    expect(model.acceptConsent()).toEqual(consentFor({ mode: 'smart', useModel: true }))
  })

  it('omits the token target by default and accepts custom targets above the former 16k ceiling', async () => {
    const { model, remote } = await prepared()
    await model.analyzeSmart()
    expect(remote.analyzeRequests[0]).not.toHaveProperty('targetTokens')
    await model.create()
    expect(remote.createRequests[0]?.mode).toBe('smart')
    expect((remote.createRequests[0] as { smart?: { targetTokens?: number } }).smart).not.toHaveProperty('targetTokens')

    const custom = await prepared()
    custom.model.setTargetTokens(64_000)
    expect(custom.model.getState()).toMatchObject({ unlimitedTokens: false, targetTokens: 64_000 })
    custom.model.acceptConsent()
    await custom.model.analyzeSmart()
    expect(custom.remote.analyzeRequests[0]).toMatchObject({ targetTokens: 64_000 })
  })

  it('fails closed when compatibility is not available', async () => {
    const remote = new FakeRemote()
    remote.compatibilityView = { ...remote.compatibilityView, compatible: false }
    const sessions = new FakeSessions()
    const model = new HandoffClientModel(remote, sessions, sessions.navigation)
    await model.open()
    expect(model.getState().phase).toBe('error')
    expect(model.getState().error?.code).toBe('DSH_INCOMPATIBLE')
    expect(remote.discoverRequests).toHaveLength(0)
  })

  it('debounces remote search and resolves superseded searches as cancelled', async () => {
    vi.useFakeTimers()
    try {
      const remote = new FakeRemote()
      const sessions = new FakeSessions()
      const model = new HandoffClientModel(remote, sessions, sessions.navigation, { debounceMs: 100 })
      const first = model.search('one')
      const second = model.search('two')
      await vi.advanceTimersByTimeAsync(100)
      await expect(first).resolves.toBeUndefined()
      await expect(second).resolves.toEqual(remote.page)
      expect(remote.discoverRequests).toHaveLength(1)
      expect(remote.discoverRequests[0]).toMatchObject({ search: 'two', cursor: undefined })
    } finally {
      vi.useRealTimers()
    }
  })

  it('loads the next remote cursor without dropping the first page', async () => {
    const remote = new FakeRemote()
    const sessions = new FakeSessions()
    const model = new HandoffClientModel(remote, sessions, sessions.navigation)
    await model.open()
    const page = await model.loadMore()
    expect(page?.items).toHaveLength(2)
    expect(remote.discoverRequests.at(-1)).toMatchObject({ cursor: 'cursor-1' })
  })

  it('settles failed discovery and retries discovery instead of silently attempting create', async () => {
    const remote = new FakeRemote()
    let failDiscovery = true
    const originalDiscover = remote.discover.bind(remote)
    remote.discover = async (request, signal) => {
      if (failDiscovery) {
        remote.discoverRequests.push(request)
        throw { code: 'SOURCE_CHANGED', message: 'rollout changed', recoverable: true }
      }
      return originalDiscover(request, signal)
    }
    const sessions = new FakeSessions()
    const model = new HandoffClientModel(remote, sessions, sessions.navigation)

    await model.open()

    expect(model.getState()).toMatchObject({ phase: 'error', searchPending: false })
    expect(model.getState().error?.code).toBe('SOURCE_CHANGED')
    failDiscovery = false
    await model.retry()
    expect(model.getState()).toMatchObject({ phase: 'browsing', searchPending: false })
    expect(model.getState().page?.items).toHaveLength(1)
    expect(remote.discoverRequests).toHaveLength(2)
    expect(remote.createCalls).toBe(0)
  })

  it('refuses preview without an absolute cwd and refuses create when cwd disappeared', async () => {
    const remote = new FakeRemote()
    const sessions = new FakeSessions()
    const model = new HandoffClientModel(remote, sessions, sessions.navigation)
    model.select({ ...session, cwd: undefined })
    await model.previewSelected()
    expect(model.getState().error?.code).toBe('CWD_REQUIRED')
    expect(remote.previewRequests).toHaveLength(0)

    model.select(session)
    remote.previewValue = previewFor(session, 1024, 1000, false)
    await model.previewSelected()
    model.acceptConsent()
    await model.create()
    expect(model.getState().cwdStatus).toBe('missing')
    expect(model.getState().error?.code).toBe('CWD_NOT_FOUND')
    expect(remote.createCalls).toBe(0)
  })

  it('requires full confirmation for a large trajectory and blocks hard limits', async () => {
    const remote = new FakeRemote()
    remote.previewValue = previewFor(session, 17 * 1024 * 1024, 40_000)
    const { model } = await prepared(remote)
    model.setMode('full')
    model.acceptConsent()
    expect(model.getBudgetEstimate().requiresConfirmation).toBe(true)
    await model.create()
    expect(model.getState().error?.code).toBe('TRAJECTORY_CONFIRMATION_REQUIRED')
    expect(remote.createCalls).toBe(0)

    model.setFullConfirmed(true)
    await model.create()
    expect(remote.createCalls).toBe(1)

    const hardRemote = new FakeRemote()
    hardRemote.previewValue = previewFor(session, 65 * 1024 * 1024, 40_000)
    const hard = await prepared(hardRemote)
    hard.model.setMode('full')
    hard.model.acceptConsent()
    hard.model.setFullConfirmed(true)
    await hard.model.create()
    expect(hard.model.getState().error?.code).toBe('TRAJECTORY_TOO_LARGE')
    expect(hardRemote.createCalls).toBe(0)
  })

  it('automatically retries a failed model analysis deterministically and creates from that preview', async () => {
    const remote = new FakeRemote()
    const analyze = remote.analyze.bind(remote)
    remote.analyze = async (request, signal) => {
      if (request.useModel) {
        remote.analyzeRequests.push(request)
        throw { code: 'INTERNAL', message: 'model transport failed', recoverable: false }
      }
      return analyze(request, signal)
    }
    const { model } = await prepared(remote)
    await model.analyzeSmart()
    expect(remote.analyzeRequests).toHaveLength(2)
    expect(remote.analyzeRequests[0]).toMatchObject({ useModel: true, consent: { modelAnalysis: true } })
    expect(remote.analyzeRequests[1]).toMatchObject({ useModel: false, consent: { modelAnalysis: false } })
    expect(model.getState().degraded).toBe(true)
    expect(model.getState().smartPreview?.degraded).toBe(true)
    expect(model.getState().useModel).toBe(false)
    expect(model.getState().consent).toEqual(consentFor({ mode: 'smart', useModel: false }))
    expect(model.getState().error).toBeUndefined()
    await model.create()
    expect(remote.createRequests[0]).toMatchObject({ mode: 'smart', smart: { useModel: false } })
  })

  it('preserves actionable Smart budget errors instead of mislabeling them as analyzer degradation', async () => {
    const remote = new FakeRemote()
    remote.analyze = async request => {
      remote.analyzeRequests.push(request)
      throw { code: 'SMART_CONTEXT_CANNOT_FIT', message: 'budget too small', recoverable: true }
    }
    const { model } = await prepared(remote)
    await model.analyzeSmart()
    expect(remote.analyzeRequests).toHaveLength(1)
    expect(model.getState()).toMatchObject({ degraded: false, smartPreview: undefined, phase: 'ready' })
    expect(model.getState().error?.code).toBe('SMART_CONTEXT_CANNOT_FIT')
    expect(model.getState().useModel).toBe(true)
  })

  it('refreshes, verifies membership, and opens exactly once; unattached is surfaced', async () => {
    const remote = new FakeRemote()
    const sessions = new FakeSessions()
    const { model } = await prepared(remote, sessions)
    const first = model.create()
    const second = model.create()
    expect(first).toBe(second)
    await first
    expect(sessions.refreshCalls).toBe(1)
    expect(sessions.opened).toEqual(['dsh-session-1'])
    expect(model.getState().phase).toBe('closed')

    const unattachedRemote = new FakeRemote()
    unattachedRemote.createOutcome = { state: 'created_unattached', sessionId: 'dsh-session-1', workspaceAttached: false, warnings: [] }
    const unattachedSessions = new FakeSessions()
    const unattached = await prepared(unattachedRemote, unattachedSessions)
    await unattached.model.create()
    expect(unattached.model.getState().outcome?.state).toBe('created_unattached')
    expect(unattached.sessions.opened).toEqual(['dsh-session-1'])
    expect(unattached.model.getState().phase).toBe('created')
  })

  it('does not open a session missing after refresh and keeps a retryable error', async () => {
    const remote = new FakeRemote()
    const sessions = new FakeSessions()
    sessions.visibleAfterRefresh = false
    const { model } = await prepared(remote, sessions)
    const outcome = await model.create()
    expect(outcome?.sessionId).toBe('dsh-session-1')
    expect(model.getState().error?.code).toBe('SESSION_NOT_VISIBLE')
    expect(sessions.opened).toHaveLength(0)
    sessions.visibleAfterRefresh = true
    await model.retry()
    expect(sessions.opened).toEqual(['dsh-session-1'])
  })

  it('keeps a successful create when session refresh throws and retries without creating again', async () => {
    const remote = new FakeRemote()
    const sessions = new FakeSessions()
    const refresh = sessions.refresh.bind(sessions)
    let failRefresh = true
    sessions.refresh = async () => {
      if (failRefresh) {
        sessions.refreshCalls += 1
        throw new Error('session refresh failed')
      }
      await refresh()
    }
    const { model } = await prepared(remote, sessions)

    const outcome = await model.create()
    expect(outcome?.sessionId).toBe('dsh-session-1')
    expect(model.getState().outcome).toEqual(outcome)
    expect(model.getState().error).toMatchObject({
      code: 'SESSION_NOT_VISIBLE',
      message: 'Session created but could not be opened. Retry opening it.',
      recoverable: true,
    })
    expect(sessions.navigation.openCalls).toEqual([])

    failRefresh = false
    await model.retry()
    expect(remote.createCalls).toBe(1)
    expect(sessions.navigation.opened).toEqual(['dsh-session-1'])
  })

  it('keeps a successful create when session navigation throws and retries opening the saved outcome', async () => {
    const remote = new FakeRemote()
    const sessions = new FakeSessions()
    sessions.navigation.failure = new Error('navigation failed')
    const { model } = await prepared(remote, sessions)

    const outcome = await model.create()
    expect(outcome?.sessionId).toBe('dsh-session-1')
    expect(model.getState().outcome).toEqual(outcome)
    expect(model.getState().error?.code).toBe('SESSION_NOT_VISIBLE')
    expect(sessions.navigation.openCalls).toEqual(['dsh-session-1'])

    await model.create()
    expect(model.getState().error?.code).toBe('SESSION_NOT_VISIBLE')
    expect(remote.createCalls).toBe(1)
    expect(sessions.navigation.openCalls).toEqual(['dsh-session-1', 'dsh-session-1'])

    sessions.navigation.failure = undefined
    const finalRetry = model.create()
    expect(model.create()).toBe(finalRetry)
    await finalRetry
    expect(remote.createCalls).toBe(1)
    expect(sessions.navigation.openCalls).toEqual(['dsh-session-1', 'dsh-session-1', 'dsh-session-1'])
    expect(sessions.navigation.opened).toEqual(['dsh-session-1'])
  })

  it('reopens the saved outcome from create after a setting change clears the open error', async () => {
    const remote = new FakeRemote()
    const sessions = new FakeSessions()
    sessions.navigation.failure = new Error('navigation failed')
    const { model } = await prepared(remote, sessions)
    const outcome = await model.create()
    expect(model.getState().error?.code).toBe('SESSION_NOT_VISIBLE')

    model.setMode('full')
    expect(model.getState().error).toBeUndefined()
    expect(model.getState().outcome).toEqual(outcome)
    sessions.navigation.failure = undefined
    await model.create()

    expect(remote.createCalls).toBe(1)
    expect(sessions.navigation.opened).toEqual(['dsh-session-1'])
  })

  it('returns a successfully opened unattached outcome without creating or navigating again', async () => {
    const remote = new FakeRemote()
    remote.createOutcome = { state: 'created_unattached', sessionId: 'dsh-session-1', workspaceAttached: false, warnings: [] }
    const sessions = new FakeSessions()
    const { model } = await prepared(remote, sessions)
    const outcome = await model.create()
    expect(model.getState().phase).toBe('created')

    await expect(model.create()).resolves.toEqual(outcome)
    expect(remote.createCalls).toBe(1)
    expect(sessions.navigation.openCalls).toEqual(['dsh-session-1'])
  })

  it('retryOpen opens an unattached visible session once and keeps the warning overlay', async () => {
    const remote = new FakeRemote()
    remote.createOutcome = { state: 'created_unattached', sessionId: 'dsh-session-1', workspaceAttached: false, warnings: [{ code: 'WORKSPACE_ATTACH_PENDING', severity: 'warning', message: 'workspace attach pending', recoverable: true }] }
    const sessions = new FakeSessions()
    sessions.visibleAfterRefresh = false
    const { model } = await prepared(remote, sessions)
    await model.create()
    expect(model.getState().error?.code).toBe('SESSION_NOT_VISIBLE')
    expect(sessions.opened).toEqual([])
    sessions.visibleAfterRefresh = true
    await model.retry()
    expect(sessions.opened).toEqual(['dsh-session-1'])
    expect(model.getState().phase).toBe('created')
    expect(model.getState().outcome?.warnings[0]?.message).toBe('workspace attach pending')
    expect(sessions.opened).toEqual(['dsh-session-1'])
  })

  it('invalidates consent when mode, cwd, or model selection changes', async () => {
    const { model } = await prepared()
    expect(model.getState().consent).toBeDefined()
    model.setUseModel(false)
    expect(model.getState().consent).toBeUndefined()
    model.acceptConsent()
    model.setCwd('C:\\other')
    expect(model.getState().consent).toBeUndefined()
    model.setMode('full')
    expect(model.getState().consent).toBeUndefined()
  })

  it('handles Escape and safe text without creating markup', async () => {
    const { model } = await prepared()
    model.keyboard('Escape')
    expect(model.getState().phase).toBe('closed')
    const { safeText } = await import('../../src/client/model.js')
    expect(safeText('<img src=x>')).toBe('<img src=x>')
    expect(safeText('\u0000ok')).toBe(' ok')
  })

  it('cancels creating without claiming close and restores the pre-create state', async () => {
    const remote = new FakeRemote()
    const sessions = new FakeSessions()
    const { model } = await prepared(remote, sessions)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const originalCreate = remote.create.bind(remote)
    remote.create = async (request, signal) => {
      await gate
      return originalCreate(request, signal)
    }
    const priorPhase = model.getState().phase
    const pending = model.create()
    await vi.waitFor(() => expect(model.getState().phase).toBe('creating'))
    model.cancel()
    expect(model.getState().phase).toBe(priorPhase)
    expect(model.getState().error).toBeUndefined()
    release()
    await pending
    expect(sessions.navigation.openCalls).toEqual([])
  })

  it('keeps an acknowledged create when cancelled during refresh and retries only opening it', async () => {
    const remote = new FakeRemote()
    const sessions = new FakeSessions()
    let finishRefresh!: () => void
    let markRefreshStarted!: () => void
    const refreshGate = new Promise<void>(resolve => { finishRefresh = resolve })
    const refreshStarted = new Promise<void>(resolve => { markRefreshStarted = resolve })
    const refresh = sessions.refresh.bind(sessions)
    let gateFirstRefresh = true
    sessions.refresh = async () => {
      if (gateFirstRefresh) {
        gateFirstRefresh = false
        markRefreshStarted()
        await refreshGate
      }
      await refresh()
    }
    const { model } = await prepared(remote, sessions)
    const pending = model.create()
    await refreshStarted
    expect(model.getState().outcome?.sessionId).toBe('dsh-session-1')

    model.cancel()
    finishRefresh()
    await pending

    expect(remote.createCalls).toBe(1)
    expect(model.getState()).toMatchObject({
      phase: 'error',
      outcome: remote.createOutcome,
      error: { code: 'SESSION_NOT_VISIBLE', message: 'Session created but could not be opened. Retry opening it.' },
    })
    expect(sessions.navigation.openCalls).toEqual([])

    await model.create()
    expect(remote.createCalls).toBe(1)
    expect(sessions.navigation.openCalls).toEqual(['dsh-session-1'])
    expect(sessions.navigation.opened).toEqual(['dsh-session-1'])
  })
})
