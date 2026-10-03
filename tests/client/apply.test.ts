import { describe, expect, it } from 'vitest'

import { apply, inject } from '../../src/client/apply.js'
import { ReturnHeaderAction } from '../../src/client/return-components.js'
import { localeParity, NS } from '../../src/client/locales.js'
import { adaptCodexHandoffRemote, codexHandoffRemote } from '../../src/client/remote.js'
import type { CodexHandoffRemote } from '../../src/shared/ports.js'
import type { ClientContext, ClientRemoteContribution } from '../../src/client/types.js'
import { FakeClientRemote, FakeRemote, FakeSessions } from '../fixtures/client/remote.js'

class MountingRemote extends FakeRemote {
  readonly mounts: ClientRemoteContribution[] = []
  mountDisposeCalls = 0
  compatibilityCalls = 0
  private mountedNamespace: {
    compatibility(): Promise<unknown>
    discover(request: Parameters<CodexHandoffRemote['discover']>[0], signal?: AbortSignal): Promise<unknown>
    preview(request: Parameters<CodexHandoffRemote['preview']>[0], signal?: AbortSignal): Promise<unknown>
    analyze(request: Parameters<CodexHandoffRemote['analyze']>[0], signal?: AbortSignal): Promise<unknown>
    create(request: Parameters<CodexHandoffRemote['create']>[0], signal?: AbortSignal): Promise<unknown>
    returnPreview(request: Parameters<CodexHandoffRemote['returnPreview']>[0], signal?: AbortSignal): Promise<unknown>
    returnSync(request: Parameters<CodexHandoffRemote['returnSync']>[0], signal?: AbortSignal): Promise<unknown>
  } | undefined

  get codexHandoff(): CodexHandoffRemote {
    if (this.mountedNamespace === undefined) throw new Error('DSH_CLIENT_REMOTE_NAMESPACE_MISSING')
    return this.mountedNamespace as unknown as CodexHandoffRemote
  }

  override compatibility(): Promise<Awaited<ReturnType<CodexHandoffRemote['compatibility']>>> {
    this.compatibilityCalls += 1
    return super.compatibility()
  }

  async $mount(contribution: ClientRemoteContribution): Promise<() => Promise<void>> {
    this.mounts.push(contribution)
    const methods = new Set(contribution.descriptors.flatMap(descriptor => {
      if (descriptor === null || typeof descriptor !== 'object') return []
      const method = (descriptor as { readonly method?: unknown }).method
      return typeof method === 'string' ? [method] : []
    }))
    const required = ['compatibility', 'discover', 'preview', 'analyze', 'create', 'returnPreview', 'returnSync']
    if (contribution.package !== 'dsh-codex-handoff' || required.some(method => !methods.has(method))) {
      throw new Error('DSH_CLIENT_REMOTE_DESCRIPTOR_INVALID')
    }
    const envelope = async <T>(call: () => Promise<T>): Promise<{ readonly ok: true; readonly value: T }> => ({
      ok: true,
      value: await call(),
    })
    this.mountedNamespace = {
      compatibility: () => envelope(() => this.compatibility()),
      discover: (request, signal) => envelope(() => this.discover(request, signal)),
      preview: (request, signal) => envelope(() => this.preview(request, signal)),
      analyze: (request, signal) => envelope(() => this.analyze(request, signal)),
      create: (request, signal) => envelope(() => this.create(request, signal)),
      returnPreview: (request, signal) => envelope(() => this.returnPreview(request, signal)),
      returnSync: (request, signal) => envelope(() => this.returnSync(request, signal)),
    }
    return async () => { this.mountDisposeCalls += 1; this.mountedNamespace = undefined }
  }
}

describe('official-shaped client slot adapter', () => {
  it('fails loudly when the generated remote contribution is empty', async () => {
    const injections: string[] = []
    const registrations: Array<{ options: Readonly<Record<string, unknown>>; component: unknown }> = []
    let locale: unknown
    const fakeRemote = new FakeClientRemote()
    const context: ClientContext = {
      remote: fakeRemote,
      sessions: new FakeSessions(),
      uiWorkspace: new FakeSessions().navigation,
      locale: {
        register: (_namespace, dictionaries) => {
          locale = dictionaries
        },
      },
      slots: {
        inject: (name, effect) => {
          injections.push(name)
          return effect()
        },
        register: (options, component) => {
          registrations.push({ options, component })
          return () => undefined
        },
      },
    }
    await expect(apply(context, { package: 'dsh-codex-handoff', descriptors: [] })).rejects.toThrow('DSH_CLIENT_REMOTE_CONTRIBUTION_MISSING')
    expect(locale).toBeUndefined()
    expect(injections).toEqual([])
    expect(registrations).toEqual([])
    expect(localeParity()).toBe(true)
    expect(NS).toBe('codex-handoff')
    expect(fakeRemote.mounts).toEqual([])
  })

  it('mounts the real generated descriptors and unwraps compatibility/discover results', async () => {
    const injections: string[] = []
    const registrations: Array<{ options: Readonly<Record<string, unknown>>; component: unknown }> = []
    const fakeRemote = new MountingRemote()
    const localeListeners = new Set<() => void>()
    const context: ClientContext = {
      remote: fakeRemote,
      sessions: new FakeSessions(),
      uiWorkspace: new FakeSessions().navigation,
      locale: {
        register: () => undefined,
        bind: () => (key: string) => key,
        getSnapshot: () => ({ active: 'en', revision: 0 }),
        subscribe: listener => { localeListeners.add(listener); return () => localeListeners.delete(listener) },
      },
      slots: {
        inject: (name, effect) => {
          injections.push(name)
          return effect()
        },
        register: (options, component) => {
          registrations.push({ options, component })
          return () => undefined
        },
      },
    }

    await apply(context)

    expect(codexHandoffRemote.descriptors).toHaveLength(7)
    expect(inject).toContain('uiWorkspace')
    expect(fakeRemote.mounts).toEqual([codexHandoffRemote])
    expect(injections).toEqual(['sidebar.footer.action', 'shell.overlay', 'conversation.session.header.utilities'])

    const action = registrations.find(entry => entry.options.id === 'codex-handoff-action')
    expect(action).toBeDefined()
    if (action === undefined) throw new Error('action registration missing')
    const props = (action.options.inject as () => { onActivate: () => Promise<void> })()
    await props.onActivate()
    expect(fakeRemote.compatibilityCalls).toBe(1)
    expect(fakeRemote.discoverRequests).toHaveLength(1)

    const returnAction = registrations.find(entry => entry.options.id === 'codex-handoff-return')
    expect(returnAction).toBeDefined()
    if (returnAction === undefined) throw new Error('return action registration missing')
    expect(returnAction.component).toBe(ReturnHeaderAction)
    expect(returnAction.options.name).toBe('conversation.session.header.utilities')
    const returnProps = (returnAction.options.inject as () => { model: { open(sessionId: string): Promise<void> } })()
    await returnProps.model.open('dsh-session-from-header')
    expect(fakeRemote.returnPreviewRequests).toEqual([{ dshSessionId: 'dsh-session-from-header' }])
    expect(fakeRemote.returnSyncRequests).toEqual([])
  })

  it('turns an official RemoteResult failure into the model-facing rejection', async () => {
    const error = { code: 'gateway/internal', message: 'remote failed', details: {} }
    const adapted = adaptCodexHandoffRemote({
      compatibility: async () => ({ ok: false, error }),
      discover: async () => ({ ok: false, error }),
      preview: async () => ({ ok: false, error }),
      analyze: async () => ({ ok: false, error }),
      create: async () => ({ ok: false, error }),
      returnPreview: async () => ({ ok: false, error }),
      returnSync: async () => ({ ok: false, error }),
    })

    await expect(adapted.compatibility()).rejects.toEqual(error)
  })

  it('reads the mounted namespace only inside its exact Cordis injection scope', async () => {
    const mountedRemote = new MountingRemote()
    let namespaceInjected = false
    let uiWorkspaceInjected = false
    let injectedDependencies: readonly string[] = []
    const sessions = new FakeSessions()
    const guardedRemote: ClientContext['remote'] = {
      $mount: contribution => mountedRemote.$mount(contribution),
      get codexHandoff() {
        if (!namespaceInjected) throw new Error('cannot get property "remote.codexHandoff" without inject')
        return mountedRemote.codexHandoff
      },
    }
    const context: ClientContext = {
      remote: guardedRemote,
      sessions,
      get uiWorkspace() {
        if (!uiWorkspaceInjected) throw new Error('cannot get property "uiWorkspace" without inject')
        return sessions.navigation
      },
      locale: {
        register: () => undefined,
        bind: () => key => key,
        getSnapshot: () => ({ active: 'en', revision: 0 }),
        subscribe: () => () => undefined,
      },
      slots: {
        inject: (_name, effect) => effect(),
        register: () => () => undefined,
      },
      inject: (dependencies, callback) => {
        injectedDependencies = dependencies
        namespaceInjected = dependencies.includes('remote.codexHandoff')
        uiWorkspaceInjected = dependencies.includes('uiWorkspace')
        try { return callback(context) } finally {
          namespaceInjected = false
          uiWorkspaceInjected = false
        }
      },
    }

    const dispose = await apply(context)

    expect(injectedDependencies).toEqual(['sessions', 'remote', 'remote.codexHandoff', 'slots', 'locale', 'uiWorkspace'])
    await dispose()
    expect(mountedRemote.mountDisposeCalls).toBe(1)
  })

  it('unwinds mount, locale, and slot registrations in reverse order on install failure', async () => {
    const remote = new MountingRemote()
    const calls: string[] = []
    const context: ClientContext = {
      remote,
      sessions: new FakeSessions(),
      uiWorkspace: new FakeSessions().navigation,
      locale: {
        register: () => () => { calls.push('locale') },
        bind: () => key => key,
        getSnapshot: () => ({ active: 'en', revision: 0 }),
        subscribe: () => () => undefined,
      },
      slots: {
        inject: (name, effect) => {
          calls.push(`inject:${name}`)
          if (name === 'shell.overlay') throw new Error('overlay install failed')
          return effect()
        },
        register: (options) => {
          calls.push(`register:${String(options.id)}`)
          return () => { calls.push(`dispose:${String(options.id)}`) }
        },
      },
      inject: (_dependencies, callback) => callback(context),
    }
    await expect(apply(context)).rejects.toThrow('overlay install failed')
    expect(calls).toEqual([
      'inject:sidebar.footer.action',
      'register:codex-handoff-action',
      'inject:shell.overlay',
      'dispose:codex-handoff-action',
      'locale',
    ])
    expect(remote.mountDisposeCalls).toBe(1)
  })

  it('preserves and executes the no-effect install disposer exactly once', async () => {
    const remote = new MountingRemote()
    let returned: unknown
    let slotDisposals = 0
    const context: ClientContext = {
      remote,
      sessions: new FakeSessions(),
      uiWorkspace: new FakeSessions().navigation,
      locale: {
        register: () => () => undefined,
        bind: () => key => key,
        getSnapshot: () => ({ active: 'en', revision: 0 }),
        subscribe: () => () => undefined,
      },
      slots: {
        inject: (_name, effect) => effect(),
        register: () => () => { slotDisposals += 1 },
      },
      inject: (_dependencies, callback) => { returned = callback(context); return returned },
    }
    await apply(context)
    expect(typeof returned).toBe('function')
    await (returned as () => Promise<void>)()
    await (returned as () => Promise<void>)()
    expect(slotDisposals).toBe(3)
    expect(remote.mountDisposeCalls).toBe(1)
  })

  it('uses the effect callback disposer and keeps cleanup idempotent', async () => {
    const remote = new MountingRemote()
    let effectDisposer: unknown
    let slotDisposals = 0
    const context: ClientContext = {
      remote,
      sessions: new FakeSessions(),
      uiWorkspace: new FakeSessions().navigation,
      locale: {
        register: () => () => undefined,
        bind: () => key => key,
        getSnapshot: () => ({ active: 'en', revision: 0 }),
        subscribe: () => () => undefined,
      },
      slots: {
        inject: (_name, effect) => effect(),
        register: () => () => { slotDisposals += 1 },
      },
      effect: effect => {
        effectDisposer = effect()
        return effectDisposer
      },
    }
    const dispose = await apply(context)
    expect(typeof effectDisposer).toBe('function')
    await dispose()
    await dispose()
    expect(slotDisposals).toBe(3)
    expect(remote.mountDisposeCalls).toBe(1)
  })
})
