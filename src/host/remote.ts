import { promises as fs } from 'node:fs'
import path from 'node:path'

import {
  AnalyzeRequestSchema,
  CompatibilityViewSchema,
  CreateOutcomeSchema,
  CreateRequestSchema,
  DefaultParseLimits,
  DiscoverRequestSchema,
  PreviewRequestSchema,
  SessionPageSchema,
  SessionPreviewSchema,
  SmartPreviewSchema,
  TokenBudgetSchema,
  type CompatibilityView,
  type CreateOutcome,
  type CreateRequest,
  type DiscoverRequest,
  type PreviewRequest,
  type SessionPage,
  type SessionPreview,
  type SmartPreview,
  type NormalizedSession,
  type PreparedImport,
  type ExternalSessionRef,
  redactDiagnostic,
  redactSessionPage,
  redactSessionPreview,
  redactRemoteDetails,
  redactText,
} from '../shared/index.js'
import { utf8ByteLength } from '../shared/limits.js'
import { HandoffError } from '../shared/errors.js'
import type { CodexHandoffRemote, RepositoryInspector, SessionSource } from '../shared/ports.js'
import type { SmartHandoffEngine } from '../handoff/engine.js'
import { compileFullSeed, compileSmartSeed } from '../dsh/seed.js'
import { computeImportIdentity, type DshSessionGateway } from '../dsh/gateway.js'

/** The only methods exposed by the Host namespace. Keep this list in sync with
 * the generated remote/typert artifacts; the build gate asserts all five. */
export const HOST_REMOTE_METHODS = Object.freeze([
  'compatibility',
  'discover',
  'preview',
  'analyze',
  'create',
] as const)

export interface CodexHandoffHostRemoteOptions {
  readonly source: SessionSource
  readonly repository: RepositoryInspector
  readonly engine: SmartHandoffEngine
  readonly gateway: DshSessionGateway
  readonly timeoutMs?: number
}

interface TrustedSession {
  readonly session: NormalizedSession
  readonly cwd: string
  readonly cwdIdentity: { readonly device: string; readonly inode: string }
}

let correlationCounter = 0

function correlationId(): string {
  correlationCounter = (correlationCounter + 1) % 1_000_000
  return `h${Date.now().toString(36)}-${correlationCounter.toString(36)}`
}

function abortError(): HandoffError {
  return new HandoffError({ code: 'CANCELLED', message: 'The handoff operation was cancelled.', recoverable: true })
}

function abortIfNeeded(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}

function asValidationError(message: string, cause: unknown): HandoffError {
  return new HandoffError({
    code: 'DSH_SEED_INVALID',
    message: redactText(message),
    recoverable: false,
    details: { reason: redactText(cause instanceof Error ? cause.message : 'validation') },
  })
}

function withCorrelation(error: unknown, id: string): HandoffError {
  if (error instanceof HandoffError) {
    const sanitizedDetails = redactRemoteDetails(error.details)
    return new HandoffError({
      code: error.code,
      message: redactText(error.message),
      recoverable: error.recoverable,
      details: sanitizedDetails === undefined
        ? { correlationId: id }
        : { ...sanitizedDetails, correlationId: id },
    })
  }
  return new HandoffError({
    code: 'INTERNAL',
    message: 'The handoff operation failed unexpectedly.',
    recoverable: false,
    details: { correlationId: id },
  })
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value)
    const root = path.parse(resolved).root
    return resolved.length > root.length ? resolved.replace(/[\\/]+$/, '') : resolved
  }
  const leftResolved = normalize(left)
  const rightResolved = normalize(right)
  return process.platform === 'win32'
    ? leftResolved.toLowerCase() === rightResolved.toLowerCase()
    : leftResolved === rightResolved
}

/** Canonicalize and verify both sides of the user/source workspace binding. */
export async function canonicalWorkspace(sourceCwd: string, requestedCwd: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted === true) throw abortError()
  try {
    const [sourceReal, requestedReal] = await Promise.all([fs.realpath(sourceCwd), fs.realpath(requestedCwd)])
    const [sourceStat, requestedStat] = await Promise.all([fs.stat(sourceReal), fs.stat(requestedReal)])
    if (!sourceStat.isDirectory() || !requestedStat.isDirectory() || !samePath(sourceReal, requestedReal)) {
      throw new HandoffError({ code: 'CWD_NOT_FOUND', message: 'The selected workspace is not a trusted directory.', recoverable: false })
    }
    return sourceReal
  } catch (error) {
    if (error instanceof HandoffError) throw error
    // Any realpath/stat failure is fail-closed. Never allow a missing or
    // replaced/junction-like workspace to reach repository or DSH creation.
    throw new HandoffError({ code: 'CWD_NOT_FOUND', message: 'The selected workspace could not be verified.', recoverable: false })
  }
}

/** Capture a stable directory identity in addition to its canonical path. */
export async function readWorkspaceIdentity(cwd: string, signal?: AbortSignal): Promise<{ readonly device: string; readonly inode: string }> {
  if (signal?.aborted === true) throw abortError()
  try {
    const stat = await fs.stat(cwd, { bigint: true })
    if (!stat.isDirectory()) throw new Error('workspace is not a directory')
    const device = String(stat.dev)
    const inode = String(stat.ino)
    if (device === '0' && inode === '0') throw new Error('directory identity unavailable')
    return { device, inode }
  } catch (error) {
    if (error instanceof HandoffError) throw error
    throw new HandoffError({ code: 'CWD_NOT_FOUND', message: 'The workspace identity could not be verified.', recoverable: false })
  }
}

/**
 * Read the source only through an inventory-bound opaque ref. `cwd` is an
 * acknowledgement of the discovered source metadata, never an authority for
 * selecting a file. A mismatch is rejected before repository inspection.
 */
async function loadTrustedSession(
  source: SessionSource,
  ref: ExternalSessionRef,
  cwd: string,
  signal: AbortSignal,
): Promise<TrustedSession> {
  abortIfNeeded(signal)
  let session: NormalizedSession
  try {
    session = await source.load(ref, DefaultParseLimits, signal)
  } catch (error) {
    throw error instanceof HandoffError ? error : asValidationError('The selected source could not be loaded.', error)
  }
  if (session.source.sessionId !== ref.sessionId || session.source.rolloutRevisionId !== ref.rolloutRevisionId) {
    throw new HandoffError({ code: 'SOURCE_STALE', message: 'The selected Codex session handle is stale.', recoverable: true })
  }
  if (ref.expectedFingerprint !== undefined && session.source.fingerprint !== ref.expectedFingerprint) {
    throw new HandoffError({ code: 'SOURCE_CHANGED', message: 'The selected Codex rollout changed; preview it again.', recoverable: true })
  }
  const sourceCwd = session.source.cwd
  if (sourceCwd === undefined || sourceCwd.trim() === '') {
    throw new HandoffError({ code: 'CWD_REQUIRED', message: 'The selected Codex session has no trusted workspace.', recoverable: false })
  }
  // The client acknowledges the displayed discovery value. It may be the
  // shared redacted rendering, but it is never a filesystem authority.
  if (cwd !== sourceCwd && cwd !== redactText(sourceCwd)) {
    throw new HandoffError({ code: 'CWD_NOT_FOUND', message: 'The selected workspace acknowledgement is stale.', recoverable: false })
  }
  const trustedCwd = await canonicalWorkspace(sourceCwd, sourceCwd, signal)
  const cwdIdentity = await readWorkspaceIdentity(trustedCwd, signal)
  return { session, cwd: trustedCwd, cwdIdentity }
}

function repositoryPaths(session: NormalizedSession): string[] {
  // Source locators are logical rollout references, not filesystem paths. Do
  // not pass them to the repository inspector; it must only inspect the
  // discovered workspace root.
  void session
  return []
}

function budget(targetTokens: number | undefined) {
  return TokenBudgetSchema.parse(targetTokens === undefined ? {} : { targetTokens })
}

function seedBytes(seed: readonly unknown[]): number {
  const json = JSON.stringify(seed)
  if (json === undefined) throw asValidationError('The imported seed is not JSON serializable.', undefined)
  return utf8ByteLength(json)
}

export class CodexHandoffRemoteService implements CodexHandoffRemote {
  readonly namespace = 'codexHandoff' as const
  readonly methods = HOST_REMOTE_METHODS
  /** Formal DSH Gateway binding used to resolve this service by key. */
  readonly typertRemote: {
    readonly service: CodexHandoffRemoteService
    readonly serviceKey: 'codexHandoff'
    readonly namespace: 'codexHandoff'
  } = Object.freeze({ service: this, serviceKey: 'codexHandoff' as const, namespace: 'codexHandoff' as const })
  private readonly timeoutMs: number

  constructor(private readonly options: CodexHandoffHostRemoteOptions) {
    // Smart analysis may use a reasoning-capable default model. Keep the RPC
    // envelope wider than the analyzer's 60-second provider deadline so the
    // analyzer can return its deterministic fallback cleanly.
    this.timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 90_000, 10 * 60_000))
  }

  compatibility(): Promise<CompatibilityView> {
    return this.run('compatibility', async () => CompatibilityViewSchema.parse(this.options.gateway.compatibility()))
  }

  discover(req: DiscoverRequest, signal?: AbortSignal): Promise<SessionPage> {
    return this.run('discover', async operationSignal => {
      let request: DiscoverRequest
      try {
        request = DiscoverRequestSchema.parse(req)
      } catch (error) {
        throw asValidationError('The discovery request is invalid.', error)
      }
      return redactSessionPage(SessionPageSchema.parse(await this.options.source.discover(request, operationSignal)))
    }, signal)
  }

  preview(req: PreviewRequest, signal?: AbortSignal): Promise<SessionPreview> {
    return this.run('preview', async operationSignal => {
      let request: PreviewRequest
      try {
        request = PreviewRequestSchema.parse(req)
      } catch (error) {
        throw asValidationError('The preview request is invalid.', error)
      }
      // The preview DTO is untrusted and may already be redacted by a source
      // adapter. Resolve the raw workspace from the loaded normalized session;
      // output redaction must never become a filesystem input.
      const limits = request.limits ?? DefaultParseLimits
      const trustedSession = await this.options.source.load(request.source, limits, operationSignal)
      const preview = SessionPreviewSchema.parse(await this.options.source.preview(request.source, limits, operationSignal))
      const sourceCwd = trustedSession.source.cwd
      if (sourceCwd === undefined) return SessionPreviewSchema.parse(redactSessionPreview(preview))
      const trustedCwd = await canonicalWorkspace(sourceCwd, sourceCwd, operationSignal)
      const repository = await this.options.repository.inspect(trustedCwd, [], operationSignal)
      return SessionPreviewSchema.parse(redactSessionPreview({ ...preview, repository }))
    }, signal)
  }

  analyze(req: import('../shared/types.js').AnalyzeRequest, signal?: AbortSignal): Promise<SmartPreview> {
    return this.run('analyze', async operationSignal => {
      let request: import('../shared/types.js').AnalyzeRequest
      try {
        request = AnalyzeRequestSchema.parse(req)
      } catch (error) {
        throw asValidationError('The analysis request is invalid.', error)
      }
      const trusted = await loadTrustedSession(this.options.source, request.source, request.cwd, operationSignal)
      const repository = await this.options.repository.inspect(trusted.cwd, repositoryPaths(trusted.session), operationSignal)
      const result = await this.options.engine.build(trusted.session, repository, budget(request.targetTokens), operationSignal, request.useModel)
      const diagnostics = [...trusted.session.diagnostics, ...repository.diagnostics, ...result.context.diagnostics].map(redactDiagnostic)
      if (result.degraded) diagnostics.push({ code: 'SMART_ANALYZER_DEGRADED', severity: 'warning', message: 'Model analysis was unavailable; deterministic analysis was used.', recoverable: true })
      return SmartPreviewSchema.parse({
        source: request.source,
        manifest: result.manifest,
        context: result.context,
        degraded: result.degraded,
        diagnostics: diagnostics.slice(0, 10_000),
      })
    }, signal)
  }

  create(req: CreateRequest, signal?: AbortSignal): Promise<CreateOutcome> {
    return this.run('create', async operationSignal => {
      let request: CreateRequest
      try {
        request = CreateRequestSchema.parse(req)
      } catch (error) {
        throw asValidationError('The create request is invalid.', error)
      }
      const trusted = await loadTrustedSession(this.options.source, request.source, request.cwd, operationSignal)
      // Client refs may omit archived. The loaded canonical session metadata
      // is authoritative and is what the durable recovery intent must carry.
      const canonicalSource: ExternalSessionRef = {
        ...request.source,
        expectedFingerprint: trusted.session.source.fingerprint,
        archived: trusted.session.source.archived,
      }
      let seed: readonly import('../shared/schemas.js').JsonValue[]
      let manifest: import('../shared/types.js').AgentHandoffManifest | undefined
      let context: import('../shared/types.js').CompiledContext | undefined
      if (request.mode === 'full') {
        if (request.consent.fullPersistence !== true || request.consent.modelAnalysis !== false) {
          throw new HandoffError({ code: 'TRAJECTORY_CONFIRMATION_REQUIRED', message: 'Full trajectory persistence requires explicit full consent.', recoverable: false })
        }
        const compilation = compileFullSeed(trusted.session, { includeNotice: true })
        seed = compilation.seed
      } else {
        const repository = await this.options.repository.inspect(trusted.cwd, repositoryPaths(trusted.session), operationSignal)
        const useModel = request.smart.useModel
        if (request.consent.fullPersistence !== false || request.consent.modelAnalysis !== useModel) {
          throw new HandoffError({ code: 'TRAJECTORY_CONFIRMATION_REQUIRED', message: 'Smart creation consent does not match the requested analysis mode.', recoverable: false })
        }
        const result = await this.options.engine.build(trusted.session, repository, budget(request.smart.targetTokens), operationSignal, useModel)
        manifest = result.manifest
        context = result.context
        seed = compileSmartSeed(result.context).seed
      }
      // Re-check canonical identity at the create boundary after all parsing,
      // repository inspection, and optional model work. The gateway repeats
      // the source fingerprint check before and after Agent.create.
      await canonicalWorkspace(trusted.cwd, trusted.cwd, operationSignal)
      const bytes = seedBytes(seed)
      const preparedBase = {
        source: canonicalSource,
        sourceFingerprint: trusted.session.source.fingerprint,
        mode: request.mode,
        cwd: trusted.cwd,
        seed: [...seed],
        seedBytes: bytes,
        totalBytes: bytes,
        identity: computeImportIdentity({ source: canonicalSource, sourceFingerprint: trusted.session.source.fingerprint, mode: request.mode, cwd: trusted.cwd }),
        ...(manifest === undefined ? {} : { manifest }),
        ...(context === undefined ? {} : { context }),
        ...(request.mode === 'smart' ? {
          ...(request.smart.targetTokens === undefined ? {} : { targetTokens: request.smart.targetTokens }),
          useModel: request.smart.useModel,
        } : {}),
        cwdIdentity: trusted.cwdIdentity,
      }
      const prepared: PreparedImport = preparedBase
      return CreateOutcomeSchema.parse(await this.options.gateway.create(prepared, operationSignal))
    }, signal)
  }

  private async run<T>(operation: string, fn: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const id = correlationId()
    const controller = new AbortController()
    const sourceSignal = signal
    const abort = (): void => controller.abort()
    sourceSignal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      abortIfNeeded(controller.signal)
      return await fn(controller.signal)
    } catch (error) {
      if (controller.signal.aborted && !(error instanceof HandoffError && error.code === 'SOURCE_STALE')) {
        const timedOut = sourceSignal?.aborted !== true
        throw withCorrelation(new HandoffError({
          code: 'CANCELLED',
          message: timedOut ? 'The handoff operation timed out.' : 'The handoff operation was cancelled.',
          recoverable: true,
          ...(timedOut ? { details: { timeout: true } } : {}),
        }), id)
      }
      throw withCorrelation(error, id)
    } finally {
      clearTimeout(timer)
      sourceSignal?.removeEventListener('abort', abort)
      void operation
    }
  }
}
