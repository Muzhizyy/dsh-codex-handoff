import { HandoffClientModel } from './model.js'
import { en, localeParity, NS, zh, type LocaleKey } from './locales.js'
import { adaptCodexHandoffRemote, codexHandoffRemote } from './remote.js'
import { HandoffAction, HandoffOverlay, type HandoffActionProps, type HandoffOverlayProps } from './components.js'
import { ReturnClientModel } from './return-model.js'
import { ReturnHeaderAction, type ReturnHeaderInjected } from './return-components.js'
import type { ClientContext, ClientLocale, ClientRemoteContribution } from './types.js'

/** Dependencies follow the official Cordis client-plugin inject convention. */
export const inject = ['slots', 'locale', 'remote', 'sessions', 'uiWorkspace'] as const

export interface HandoffActionFace extends Omit<HandoffActionProps, 'wide'> {
  readonly labelKey: LocaleKey
}

export interface HandoffOverlayFace extends HandoffOverlayProps {}

function asDisposer(value: unknown): (() => void | Promise<void>) | undefined {
  return typeof value === 'function' ? value as () => void | Promise<void> : undefined
}

function once(disposer: () => void | Promise<void>): () => Promise<void> {
  let settled = false
  return async () => {
    if (settled) return
    settled = true
    await disposer()
  }
}

export async function apply(ctx: ClientContext, contribution: ClientRemoteContribution = codexHandoffRemote): Promise<() => Promise<void>> {
  if (!localeParity()) throw new Error('codex-handoff locale parity failure')
  if (contribution.descriptors.length === 0) throw new Error('DSH_CLIENT_REMOTE_CONTRIBUTION_MISSING')
  const locale: ClientLocale = ctx.locale
  if (locale.bind?.(NS) === undefined || locale.getSnapshot === undefined || locale.subscribe === undefined) throw new Error('DSH_CLIENT_LOCALE_SEAT_MISSING')
  const cleanupStack: Array<() => Promise<void>> = []
  let cleaned = false
  let installDisposer: (() => Promise<void>) | undefined
  const track = (value: unknown): void => {
    const disposer = asDisposer(value)
    if (disposer === undefined) return
    if (disposer === installDisposer) return
    cleanupStack.push(once(disposer))
  }
  const cleanupAll = async (): Promise<void> => {
    if (cleaned) return
    cleaned = true
    let firstError: unknown
    for (const disposer of cleanupStack.reverse()) {
      try { await disposer() } catch (error) { firstError ??= error }
    }
    if (firstError !== undefined) throw firstError
  }

  try {
    // Mount is first in the transaction. Every later stage is tracked and is
    // therefore unwound in exact reverse order if any stage fails.
    track(await ctx.remote.$mount(contribution))
    const install = (scope: ClientContext, model: HandoffClientModel): (() => Promise<void>) => {
      const scopedLocale = scope.locale
      track(scopedLocale.register(NS, { zh, en }))
      const returnModel = new ReturnClientModel(adaptCodexHandoffRemote(scope.remote.codexHandoff))
      track(() => returnModel.dispose())
      track(scope.slots.inject('sidebar.footer.action', () => scope.slots.register(
        {
          name: 'sidebar.footer.action',
          id: 'codex-handoff-action',
          locale: NS,
          inject: () => ({
            model,
            labelKey: 'action',
            locale: scopedLocale,
            onActivate: () => model.open(),
          } satisfies HandoffActionFace),
        },
        HandoffAction,
      )))
      track(scope.slots.inject('shell.overlay', () => scope.slots.register(
        {
          name: 'shell.overlay',
          id: 'codex-handoff-overlay',
          order: 100,
          locale: NS,
          inject: () => ({
            model,
            titleKey: 'title',
            locale: scopedLocale,
            onKey: (key: string) => model.keyboard(key),
          } satisfies HandoffOverlayFace),
        },
        HandoffOverlay,
      )))
      track(scope.slots.inject('conversation.session.header.utilities', () => scope.slots.register(
        {
          name: 'conversation.session.header.utilities',
          id: 'codex-handoff-return',
          order: 100,
          locale: NS,
          inject: () => ({ model: returnModel, locale: scopedLocale } satisfies ReturnHeaderInjected),
        },
        ReturnHeaderAction,
      )))
      installDisposer = once(cleanupAll)
      return installDisposer
    }

    const registerWithEffect = (scope: ClientContext): void | (() => Promise<void>) | Promise<void | (() => Promise<void>)> => {
      // `remote.codexHandoff` is a dynamically mounted Cordis service. Read it
      // only from the scope that explicitly injected that exact namespace.
      const model = new HandoffClientModel(adaptCodexHandoffRemote(scope.remote.codexHandoff), scope.sessions, scope.uiWorkspace)
      track(() => model.dispose())
      const installScoped = (): (() => Promise<void>) => install(scope, model)
      if (scope.effect !== undefined) {
        return Promise.resolve(scope.effect(installScoped, 'codex-handoff client')).then(value => {
          track(value)
          return undefined
        })
      }
      // The no-effect seam must return the disposer to its caller; silently
      // discarding this value used to leak the mount/model registrations.
      return installScoped()
    }
    // The official runtime resolves service faces through ctx.inject. The
    // fallback keeps the local typed fixture usable while F0 wires the loader.
    if (ctx.inject !== undefined) {
      let callbackResult: Promise<unknown> | undefined
      const injectionResult = ctx.inject(['sessions', 'remote', 'remote.codexHandoff', 'slots', 'locale', 'uiWorkspace'], (scope) => {
        const result = registerWithEffect(scope)
        callbackResult = Promise.resolve(result)
        return result
      })
      track(await injectionResult)
      // Some host injectors return void even when they invoke the callback;
      // await the captured callback result as well so effect/install failures
      // cannot escape after apply has resolved.
      if (callbackResult !== undefined) await callbackResult
    } else track(await registerWithEffect(ctx))
    return cleanupAll
  } catch (error) {
    try { await cleanupAll() } catch { /* preserve the original stage error */ }
    throw error
  }
}

export { HandoffAction, HandoffOverlay }
