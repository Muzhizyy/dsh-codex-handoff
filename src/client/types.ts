import type { CodexHandoffRemote } from '../shared/ports.js'

/** Structural spelling of the pinned DSH SessionId brand. */
export type SessionId = string & { readonly __dshSessionId: true }

export interface ClientSessionListSnapshot {
  readonly ids?: readonly SessionId[]
  readonly items?: readonly { readonly id?: SessionId }[]
  readonly byId?: Readonly<Record<string, unknown>>
  readonly current?: SessionId
  readonly phase?: string
}

export interface ClientSessions {
  /** Official DSH ObservableSnapshot; the structural seam keeps this package independently buildable. */
  readonly list: { getSnapshot(): unknown; subscribe?(listener: () => void): () => void }
  refresh(): Promise<void>
}

export interface ClientUiWorkspace {
  openSession(id: SessionId): void
}

export interface ClientLocale {
  register(
    namespace: string,
    dictionaries: { readonly zh: Record<string, string>; readonly en: Record<string, string> },
  ): void | (() => void)
  /** Reactive locale seat from the official client-locale service. */
  /** Official LocaleRuntime bind: a stable translator that reads active locale at call time. */
  bind?(namespace: string): (key: string) => string | undefined
  /** Official LocaleRuntime snapshot/subscribe face used for reactive rerendering. */
  getSnapshot?(): { readonly active: string; readonly revision: number }
  subscribe?(listener: () => void): () => void
}

export interface LocaleSeatObject {
  readonly language?: 'zh' | 'en'
  readonly getLanguage?: () => 'zh' | 'en'
  readonly t?: (key: string) => string | undefined
  readonly subscribe?: (listener: () => void) => () => void
}
export type LocaleSeat = LocaleSeatObject | ((key: string) => string | undefined)

export interface ClientSlots {
  inject(name: string, effect: () => unknown): unknown
  register(options: Readonly<Record<string, unknown>>, component: unknown): unknown
}

/** Exact generated Typert contribution shape used by `ctx.remote.$mount`. */
export interface ClientRemoteContribution {
  readonly package: string
  readonly descriptors: readonly unknown[]
}

export interface ClientRemote {
  readonly codexHandoff: CodexHandoffRemote
  $mount(contribution: ClientRemoteContribution): Promise<() => void | Promise<void>>
}

export interface ClientContext {
  readonly slots: ClientSlots
  readonly locale: ClientLocale
  readonly remote: ClientRemote
  readonly sessions: ClientSessions
  readonly uiWorkspace: ClientUiWorkspace
  /** Cordis dependency declaration seam used by official Client plugins. */
  readonly inject?: (dependencies: readonly string[], callback: (scope: ClientContext) => unknown) => unknown
  readonly effect?: (effect: () => void | (() => void) | Promise<void | (() => void | Promise<void>)>, label?: string) => unknown
}

export function sessionIds(snapshot: unknown): readonly SessionId[] {
  if (snapshot === null || typeof snapshot !== 'object') return []
  const value = snapshot as ClientSessionListSnapshot
  if (Array.isArray(value.ids)) return value.ids.filter((id): id is string => typeof id === 'string').map(id => id as SessionId)
  if (Array.isArray(value.items)) return value.items.flatMap(item => (typeof item.id === 'string' ? [item.id as SessionId] : []))
  if (value.byId !== undefined && typeof value.byId === 'object') return Object.keys(value.byId).map(id => id as SessionId)
  return []
}
