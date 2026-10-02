import path from 'node:path'
import { realpath } from 'node:fs/promises'
import { CodexSessionSource } from '../codex/resolver.js'
import { resolveCodexHomePath, type CodexHomeOptions } from '../codex/home.js'
import { GitRepositoryInspector } from '../repo/inspector.js'
import type { RepositoryInspector, SessionSource } from '../shared/ports.js'
import { DefaultParseLimits } from '../shared/schemas.js'
import {
  DshSessionGateway,
  MemoryImportIndex,
  createStorageDomainImportIndex,
  computeImportIdentity,
  type DshGatewayRuntime,
  type DshStorageDomainService,
  type ImportIndex,
} from '../dsh/gateway.js'
import { SmartHandoffEngine } from '../handoff/engine.js'
import type { DshLlmRuntime, DshGenerateOptions } from '../handoff/llm-adapter.js'
import { REMOTE_NAMESPACE } from '../shared/remote.js'
import {
  CodexHandoffRemoteService,
  canonicalWorkspace,
  readWorkspaceIdentity,
  type CodexHandoffHostRemoteOptions,
} from './remote.js'
import { HandoffError } from '../shared/errors.js'
import {
  ExternalSessionRefSchema,
  PreparedImportSchema,
  type ImportRecordRead,
  type PreparedImport,
} from '../shared/index.js'
import { HARD_LIMITS, utf8ByteLength } from '../shared/limits.js'
import { compileFullSeed } from '../dsh/seed.js'
import {
  createStorageDomainReturnStore,
  ReturnSyncService,
  type ReturnStore,
} from './return-sync.js'

/** Official Host services required by the DSH composition root. */
export const HOST_INJECT = Object.freeze([
  'agents',
  'agentDefaultModel',
  'sessionQuery',
  'sessionPersistence',
  'workspaceRegistry',
  'storageDomain',
  'typert',
] as const)

export interface HostContextLike extends Record<string, unknown> {
  readonly get?: (name: string) => unknown
  readonly provide?: (name: string, value: unknown) => unknown
  readonly effect?: (setup: () => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>, label?: string) => unknown
  readonly typert?: Record<string, unknown>
}

export interface HostCompositionOptions {
  readonly runtime: DshGatewayRuntime
  readonly source: SessionSource
  readonly repository?: RepositoryInspector
  readonly engine?: SmartHandoffEngine
  readonly index?: ImportIndex
  readonly returnStore?: ReturnStore
  /** Exact CODEX_HOME used by the source resolver and app-server. */
  readonly codexHome?: string
  readonly gateway?: DshSessionGateway
  readonly timeoutMs?: number
  readonly now?: () => Date
}

export interface HostComposition {
  readonly remote: CodexHandoffRemoteService
  readonly gateway: DshSessionGateway
  readonly source: SessionSource
  readonly repository: RepositoryInspector
  readonly engine: SmartHandoffEngine
  readonly runtime: DshGatewayRuntime
  readonly index: ImportIndex
  readonly returnSync?: ReturnSyncService
}

/** Resolve the only Codex home authorized for return: the source root itself. */
export function resolveCodexHomeForSource(source: SessionSource, configuredHome?: string): string | undefined {
  const sourceHome = source instanceof CodexSessionSource ? source.resolver.roots.home : undefined
  const configured = configuredHome === undefined ? undefined : resolveCodexHomePath({ codexHome: configuredHome, platform: process.platform })
  if (sourceHome !== undefined && configured !== undefined) {
    const api = process.platform === 'win32' ? path.win32 : path
    const left = api.normalize(sourceHome)
    const right = api.normalize(configured)
    const same = process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
    if (!same) throw new HandoffError({ code: 'RETURN_NOT_SUPPORTED', message: 'Configured Codex home does not match the imported source root.', recoverable: false })
  }
  return sourceHome ?? configured
}

async function resolveCanonicalCodexHomeForSource(source: SessionSource, configuredHome?: string): Promise<string | undefined> {
  const sourceHome = resolveCodexHomeForSource(source)
  const configured = configuredHome === undefined ? undefined : resolveCodexHomePath({ codexHome: configuredHome, platform: process.platform })
  if (sourceHome !== undefined && configured !== undefined) {
    const api = process.platform === 'win32' ? path.win32 : path
    const canonical = async (candidate: string): Promise<string> => await realpath(candidate).catch(() => api.resolve(candidate))
    const left = api.normalize(await canonical(sourceHome))
    const right = api.normalize(await canonical(configured))
    const same = process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
    if (!same) throw new HandoffError({ code: 'RETURN_NOT_SUPPORTED', message: 'Configured Codex home does not match the imported source root.', recoverable: false })
  }
  return sourceHome ?? configured
}

/**
 * Adapt the optional official DSH model services at the Host boundary.  The
 * composition root must keep the service receiver intact (the pinned runtime
 * owns its `this` binding), while still allowing Smart to fail closed when a
 * profile does not expose a model or LLM stream.
 */
function defaultSmartEngine(runtime: DshGatewayRuntime): SmartHandoffEngine {
  const defaultModel = runtime.agentDefaultModel
  const modelRuntime = defaultModel !== undefined && typeof defaultModel.currentSelection === 'function'
    ? { agentDefaultModel: { currentSelection: () => defaultModel.currentSelection() } }
    : {}
  const llm = runtime.llm
  const stream = llm !== null && typeof llm === 'object'
    ? (llm as { readonly stream?: unknown }).stream
    : undefined
  const streamRuntime = typeof stream === 'function'
    ? {
      llm: {
        stream: (options: DshGenerateOptions) => (stream as (this: unknown, options: DshGenerateOptions) => unknown).call(llm, options),
      },
    }
    : {}
  const llmRuntime: DshLlmRuntime = { ...modelRuntime, ...streamRuntime }
  // Deliberately pass an object even when both optional services are absent:
  // DshLlmAnalyzer then reports a deterministic, degraded Smart result with a
  // warning instead of claiming that `dsh-model` was used.
  return new SmartHandoffEngine({ llmRuntime })
}

function valueOf(ctx: HostContextLike, name: string): unknown {
  // A fixed Cordis Context is a Proxy: reading an uninjected `ctx[name]`
  // can throw or create a pending service lookup. Only ordinary test doubles
  // with an own data property may be read directly.
  try {
    const descriptor = Object.getOwnPropertyDescriptor(ctx, name)
    if (descriptor !== undefined && 'value' in descriptor && descriptor.value !== undefined) return descriptor.value
  } catch {
    // Fall through to the official service accessor below.
  }
  // Required services remain statically gated by HOST_INJECT at composition
  // time; optional feature probes are safe because get() is contained here.
  try {
    return ctx.get?.(name)
  } catch {
    return undefined
  }
}

/** Convert the official Cordis context to the structural DSH services used by
 * the gateway. No DSH implementation package is imported by the plugin. */
export function runtimeFromContext(ctx: HostContextLike): DshGatewayRuntime {
  const storage = valueOf(ctx, 'storageDomain')
  const runtime = {} as DshGatewayRuntime
  const assign = (name: keyof DshGatewayRuntime, value: unknown): void => {
    if (value !== undefined) (runtime as unknown as Record<string, unknown>)[name] = value
  }
  assign('agents', valueOf(ctx, 'agents'))
  assign('agentDefaultModel', valueOf(ctx, 'agentDefaultModel'))
  assign('agentPresets', valueOf(ctx, 'agentPresets'))
  assign('sessionQuery', valueOf(ctx, 'sessionQuery'))
  assign('sessionPersistence', valueOf(ctx, 'sessionPersistence'))
  assign('workspaceRegistry', valueOf(ctx, 'workspaceRegistry'))
  assign('storageDomain', storage)
  assign('typert', valueOf(ctx, 'typert'))
  assign('llm', valueOf(ctx, 'llm'))
  const dshVersion = valueOf(ctx, 'dshVersion')
  assign('dshVersion', typeof dshVersion === 'string' ? dshVersion : undefined)
  const observedSessionFormat = valueOf(ctx, 'observedSessionFormat')
  assign('observedSessionFormat', typeof observedSessionFormat === 'number' ? observedSessionFormat : undefined)
  return runtime
}

export function createHostComposition(options: HostCompositionOptions): HostComposition {
  const repository = options.repository ?? new GitRepositoryInspector()
  const engine = options.engine ?? defaultSmartEngine(options.runtime)
  const index = options.index ?? new MemoryImportIndex()
  const fingerprint = async (request: import('../shared/types.js').PreparedImport, signal: AbortSignal): Promise<string> => {
    const loaded = await options.source.load(request.source, DefaultParseLimits, signal)
    if (loaded.source.sessionId !== request.source.sessionId || loaded.source.rolloutRevisionId !== request.source.rolloutRevisionId) {
      throw new HandoffError({ code: 'SOURCE_STALE', message: 'The selected Codex session handle is stale.', recoverable: true })
    }
    if (loaded.source.cwd === undefined) {
      throw new HandoffError({ code: 'CWD_REQUIRED', message: 'The selected Codex session has no trusted workspace.', recoverable: false })
    }
    // This callback is invoked immediately before and after Agent.create by
    // DshSessionGateway, closing the cwd/junction replacement window.
    await canonicalWorkspace(loaded.source.cwd, request.cwd, signal)
    return loaded.source.fingerprint
  }
  const rediscoverRecoverySource = async (record: ImportRecordRead, signal: AbortSignal): Promise<{ readonly ref: import('../shared/types.js').ExternalSessionRef; readonly loaded: import('../shared/types.js').NormalizedSession }> => {
    const persisted = record.schemaVersion === 2 ? record.recovery?.source : undefined
    // V2 recovery has an archived bit in its durable intent. V1 has no opaque
    // source handle, so migration may only perform a bounded all-state search
    // and proceed when the session/revision/fingerprint tuple is unique.
    if (record.schemaVersion === 2 && (persisted === undefined || persisted.archived === undefined)) {
      throw new HandoffError({ code: 'SOURCE_STALE', message: 'The durable recovery source handle is incomplete.', recoverable: true })
    }
    const page = await options.source.discover({
      search: record.sourceSessionId,
      archived: persisted?.archived === undefined ? 'all' : persisted.archived ? 'archived' : 'active',
      limit: HARD_LIMITS.discoverPageResults,
      includeMessageIndex: false,
    }, signal)
    // A cursor means the bounded search was not exhaustive. Do not guess an
    // opaque handle from a partial result set.
    if (page.nextCursor !== undefined) {
      throw new HandoffError({ code: 'SOURCE_STALE', message: 'The durable recovery source search was not bounded to a unique result.', recoverable: true })
    }
    const matches = page.items.filter(item => item.sessionId === record.sourceSessionId
      && item.rolloutRevisionId === record.sourceRolloutRevisionId
      && (persisted?.archived === undefined || item.archived === persisted.archived)
      && item.fingerprint === record.sourceFingerprint)
    if (matches.length !== 1) {
      throw new HandoffError({ code: matches.length === 0 ? 'SOURCE_STALE' : 'SOURCE_CHANGED', message: 'The durable recovery source could not be rediscovered uniquely.', recoverable: true })
    }
    const item = matches[0]!
    const ref = ExternalSessionRefSchema.parse({
      discoveryId: item.discoveryId,
      source: item.source,
      sessionId: item.sessionId,
      rolloutRevisionId: item.rolloutRevisionId,
      expectedFingerprint: record.sourceFingerprint,
      archived: item.archived,
    })
    const loaded = await options.source.load(ref, DefaultParseLimits, signal)
    if (loaded.source.sessionId !== record.sourceSessionId || loaded.source.rolloutRevisionId !== record.sourceRolloutRevisionId || loaded.source.fingerprint !== record.sourceFingerprint) {
      throw new HandoffError({ code: 'SOURCE_CHANGED', message: 'The rediscovered source changed during recovery.', recoverable: true })
    }
    return { ref, loaded }
  }
  const fingerprintRecord = async (record: import('../shared/types.js').ImportRecordRead, signal: AbortSignal): Promise<string> => {
    const recovery = record.schemaVersion === 2 ? record.recovery : undefined
    const { loaded } = await rediscoverRecoverySource(record, signal)
    if (loaded.source.cwd === undefined || loaded.source.cwd.trim() === '') {
      throw new HandoffError({ code: 'CWD_REQUIRED', message: 'The persisted source has no trusted workspace.', recoverable: false })
    }
    await canonicalWorkspace(loaded.source.cwd, record.cwd, signal)
    if (recovery?.cwdIdentity !== undefined) {
      const current = await readWorkspaceIdentity(record.cwd, signal)
      if (current.device !== recovery.cwdIdentity.device || current.inode !== recovery.cwdIdentity.inode) {
        throw new HandoffError({ code: 'CWD_NOT_FOUND', message: 'The persisted workspace directory was replaced.', recoverable: true })
      }
    }
    if (loaded.source.fingerprint !== record.sourceFingerprint) {
      throw new HandoffError({ code: 'SOURCE_CHANGED', message: 'The persisted source rollout changed.', recoverable: true })
    }
    return loaded.source.fingerprint
  }
  const rebuildRecord = async (record: ImportRecordRead, signal: AbortSignal): Promise<PreparedImport> => {
    const recovery = record.schemaVersion === 2 ? record.recovery : undefined
    const { ref, loaded } = await rediscoverRecoverySource(record, signal)
    if (loaded.source.cwd === undefined || loaded.source.cwd.trim() === '') {
      throw new HandoffError({ code: 'CWD_REQUIRED', message: 'The persisted source has no trusted workspace.', recoverable: false })
    }
    const cwd = await canonicalWorkspace(loaded.source.cwd, record.cwd, signal)
    const cwdIdentity = await readWorkspaceIdentity(cwd, signal)
    if (recovery?.cwdIdentity !== undefined
      && (cwdIdentity.device !== recovery.cwdIdentity.device || cwdIdentity.inode !== recovery.cwdIdentity.inode)) {
      throw new HandoffError({ code: 'CWD_NOT_FOUND', message: 'The persisted workspace directory was replaced.', recoverable: true })
    }
    let seed: readonly import('../shared/schemas.js').JsonValue[]
    if (record.mode === 'full') {
      seed = compileFullSeed(loaded).seed
    } else if (recovery?.seed !== undefined) {
      // The durable Smart recovery intent contains the already-redacted,
      // compiled artifact. Replaying it avoids re-running an analyzer or
      // reading a mutable repository after a crash.
      seed = [...recovery.seed]
    } else {
      throw new HandoffError({ code: 'SOURCE_CHANGED', message: 'The durable Smart recovery artifact is unavailable.', recoverable: true })
    }
    const serialized = JSON.stringify(seed)
    if (serialized === undefined) throw new HandoffError({ code: 'DSH_SEED_INVALID', message: 'Recovered seed is not JSON-serializable.', recoverable: false })
    const bytes = utf8ByteLength(serialized)
    const prepared = PreparedImportSchema.parse({
      source: ref,
      sourceFingerprint: loaded.source.fingerprint,
      mode: record.mode,
      cwd,
      seed: [...seed],
      seedBytes: bytes,
      totalBytes: bytes,
      identity: computeImportIdentity({ source: ref, sourceFingerprint: loaded.source.fingerprint, mode: record.mode, cwd }),
      ...(recovery?.targetTokens === undefined ? {} : { targetTokens: recovery.targetTokens }),
      ...(recovery?.useModel === undefined ? {} : { useModel: recovery.useModel }),
      ...(recovery?.cwdIdentity === undefined ? {} : { cwdIdentity }),
    })
    if (prepared.identity.key !== record.key || prepared.identity.destinationSessionId !== record.destinationSessionId) {
      throw new HandoffError({ code: 'SOURCE_CHANGED', message: 'Recovered source identity does not match the durable import.', recoverable: true })
    }
    return prepared
  }
  const gateway = options.gateway ?? new DshSessionGateway(options.runtime, {
    index,
    ...(options.now === undefined ? {} : { now: options.now }),
    fingerprint,
    cwdIdentity: readWorkspaceIdentity,
    fingerprintRecord,
    rebuildRecord,
  })
  const codexHome = resolveCodexHomeForSource(options.source, options.codexHome)
  const query = options.runtime.sessionQuery
  const returnSync = options.returnStore !== undefined && codexHome !== undefined
    && query !== undefined && typeof query.observeSession === 'function'
    ? new ReturnSyncService({ source: options.source, repository, importIndex: index, sessionQuery: query, store: options.returnStore, codexHome, ...(options.now === undefined ? {} : { now: options.now }) })
    : undefined
  const remoteOptions: CodexHandoffHostRemoteOptions = {
    source: options.source,
    repository,
    engine,
    gateway,
    ...(returnSync === undefined ? {} : { returnSync }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  }
  return {
    remote: new CodexHandoffRemoteService(remoteOptions),
    gateway,
    source: options.source,
    repository,
    engine,
    runtime: options.runtime,
    index,
    ...(returnSync === undefined ? {} : { returnSync }),
  }
}

export async function createHostCompositionAsync(options: Omit<HostCompositionOptions, 'index'> & { readonly index?: ImportIndex }): Promise<HostComposition> {
  // Validate the trusted import source root before opening any Host-owned
  // storage domain. A configured-home mismatch is a setup error, not a reason
  // to leak an already-opened import index.
  const sourceHome = await resolveCanonicalCodexHomeForSource(options.source, options.codexHome)
  const storage = options.runtime.storageDomain
  const storageService = storage !== undefined && typeof (storage as DshStorageDomainService).open === 'function'
    ? storage as DshStorageDomainService
    : undefined
  const index = options.index ?? (storageService === undefined ? undefined : await createStorageDomainImportIndex(storageService))
  const canUseReturnSync = sourceHome !== undefined
    && options.runtime.sessionQuery !== undefined
    && typeof options.runtime.sessionQuery.observeSession === 'function'
  let returnStore = options.returnStore
  let ownsReturnStore = false
  try {
    if (returnStore === undefined && canUseReturnSync && storageService !== undefined) {
      returnStore = await createStorageDomainReturnStore(storageService)
      ownsReturnStore = true
    }
    return createHostComposition({
      ...options,
      ...(index === undefined ? {} : { index }),
      ...(returnStore === undefined ? {} : { returnStore }),
      ...(sourceHome === undefined ? {} : { codexHome: sourceHome }),
    })
  } catch (error) {
    if (ownsReturnStore) {
      try { await returnStore?.close?.() } catch { /* preserve composition failure */ }
    }
    if (options.index === undefined && index !== undefined) {
      try { await (index as ImportIndex & { close?: () => Promise<void> }).close?.() } catch { /* preserve composition failure */ }
    }
    throw error
  }
}

const disposedCompositions = new WeakSet<object>()

async function disposeComposition(composition: HostComposition): Promise<void> {
  if (disposedCompositions.has(composition)) return
  disposedCompositions.add(composition)
  const failures: unknown[] = []
  try {
    await composition.gateway.disposeAll()
  } catch (error) {
    failures.push(error)
  }
  if (composition.returnSync !== undefined) {
    try { await composition.returnSync.close() } catch (error) { failures.push(error) }
  }
  const closeIndex = (composition.index as ImportIndex & { close?: () => Promise<void> }).close
  if (typeof closeIndex === 'function') {
    try {
      await closeIndex.call(composition.index)
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    throw new HandoffError({
      code: 'INTERNAL',
      message: 'One or more Host composition resources could not be disposed.',
      recoverable: false,
      details: { count: failures.length },
      cause: failures[0],
    })
  }
}

async function publish(ctx: HostContextLike, composition: HostComposition): Promise<() => Promise<void>> {
  const service = composition.remote
  const disposers: Array<() => void | Promise<void>> = []
  let disposed = false
  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    // Unload must await live Agent handles before tearing down the remote
    // contribution, otherwise a root reload can leave DSH sessions attached.
    const failures: unknown[] = []
    try { await disposeComposition(composition) } catch (error) { failures.push(error) }
    for (const disposer of disposers.reverse()) {
      try {
        await disposer()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new HandoffError({
        code: 'INTERNAL',
        message: 'One or more Host resources could not be disposed.',
        recoverable: false,
        details: { count: failures.length },
        cause: failures[0],
      })
    }
  }
  try {
    if (typeof ctx.provide === 'function') await ctx.provide('codexHandoff', service)
    // The fixed DSH Loader already registers this package's strict `./typert`
    // face and dispatches calls through the active `codexHandoff` binding.
    // Host does not own a Client `remote` service or a `$mount` lifecycle.
    if (typeof ctx.effect === 'function') {
      // Cordis effect invokes setup now and retains the returned disposer for
      // root unload. Passing dispose itself would tear the composition down at
      // mount time.
      await ctx.effect(() => dispose, 'codex-handoff host')
    }
  } catch (error) {
    await dispose().catch(() => undefined)
    throw error
  }
  return dispose
}

export interface ApplyOptions {
  readonly source?: SessionSource
  readonly codexHome?: CodexHomeOptions
  readonly repository?: RepositoryInspector
  readonly engine?: SmartHandoffEngine
  readonly index?: ImportIndex
  readonly timeoutMs?: number
}

/**
 * Host entry point used by the DSH loader. The source resolver is created only
 * after Host services are available; all durable state remains in the official
 * storage-domain adapter owned by DshSessionGateway.
 */
export async function apply(ctx: HostContextLike, options: ApplyOptions = {}): Promise<() => Promise<void>> {
  const runtime = runtimeFromContext(ctx)
  const source = options.source ?? await CodexSessionSource.create(options.codexHome)
  const configuredHome = options.codexHome === undefined ? undefined : resolveCodexHomePath(options.codexHome)
  const codexHome = await resolveCanonicalCodexHomeForSource(source, configuredHome)
  const composition = await createHostCompositionAsync({
    runtime,
    source,
    ...(codexHome === undefined ? {} : { codexHome }),
    ...(options.repository === undefined ? {} : { repository: options.repository }),
    ...(options.engine === undefined ? {} : { engine: options.engine }),
    ...(options.index === undefined ? {} : { index: options.index }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })
  try {
    // Recovery is part of Host startup, before Typert/remote publication. This
    // prevents a newly mounted client from racing a crash-recovery transition.
    // A narrow legacy test/integration gateway may only implement the public
    // create/find port; production DshSessionGateway always exposes recover.
    const recover = (composition.gateway as unknown as { recover?: (signal: AbortSignal) => Promise<unknown> }).recover
    if (typeof recover === 'function') await recover.call(composition.gateway, new AbortController().signal)
    return await publish(ctx, composition)
  } catch (error) {
    await disposeComposition(composition).catch(() => undefined)
    throw error
  }
}

/** Formal DSH Host service metadata. The class is intentionally structural so
 * the package can compile against the pinned workspace without bundling DSH. */
export class CodexHandoffHostService {
  static readonly inject = HOST_INJECT
  static readonly namespace = REMOTE_NAMESPACE

  static apply = apply
}

export { HOST_REMOTE_METHODS, CodexHandoffRemoteService } from './remote.js'
export type { CodexHandoffHostRemoteOptions } from './remote.js'
