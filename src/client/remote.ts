import generatedRemote from '../../packages/codex-handoff/generated/remote.js'
import type { CodexHandoffRemote } from '../shared/ports.js'
import type {
  AnalyzeRequest,
  CompatibilityView,
  CreateOutcome,
  CreateRequest,
  DiscoverRequest,
  PreviewRequest,
  ReturnPreviewRequest,
  ReturnPreviewResponse,
  ReturnSyncRequest,
  ReturnSyncResponse,
  SessionPage,
  SessionPreview,
  SmartPreview,
} from '../shared/types.js'
import type { ClientRemoteContribution } from './types.js'

/**
 * The official generator's default `./remote` contribution. Keep this as a
 * value import: the client bundle must carry the generated descriptors and
 * strict codecs, rather than a hand-written empty sentinel.
 */
export const codexHandoffRemote: ClientRemoteContribution = generatedRemote as unknown as ClientRemoteContribution
export const officialCodexHandoffRemote = codexHandoffRemote

interface RemoteResultSuccess<T> {
  readonly ok: true
  readonly value: T
}

interface RemoteResultFailure {
  readonly ok: false
  readonly error: unknown
}

type RemoteResultLike<T> = RemoteResultSuccess<T> | RemoteResultFailure

function isRemoteResult<T>(value: unknown): value is RemoteResultLike<T> {
  return value !== null && typeof value === 'object' && 'ok' in value && typeof value.ok === 'boolean'
}

/**
 * Convert official `RemoteResult<T>` calls to the business-value contract used
 * by the client model. The plain-value branch is retained for local fixtures;
 * real mounted DSH services always take the envelope branch.
 */
async function unwrap<T>(call: Promise<unknown>): Promise<T> {
  const result = await call
  if (!isRemoteResult<T>(result)) return result as T
  if (result.ok) return result.value
  throw result.error
}

interface GeneratedCodexHandoffRemote {
  compatibility(): Promise<unknown>
  discover(request: DiscoverRequest, signal?: AbortSignal): Promise<unknown>
  preview(request: PreviewRequest, signal?: AbortSignal): Promise<unknown>
  analyze(request: AnalyzeRequest, signal?: AbortSignal): Promise<unknown>
  create(request: CreateRequest, signal?: AbortSignal): Promise<unknown>
  returnPreview(request: ReturnPreviewRequest, signal?: AbortSignal): Promise<unknown>
  returnSync(request: ReturnSyncRequest, signal?: AbortSignal): Promise<unknown>
}

/** Adapt the generated namespace without leaking its envelope into the model. */
export function adaptCodexHandoffRemote(remote: CodexHandoffRemote | GeneratedCodexHandoffRemote): CodexHandoffRemote {
  const generated = remote as GeneratedCodexHandoffRemote
  return {
    compatibility: () => unwrap<CompatibilityView>(generated.compatibility()),
    discover: (request, signal) => unwrap<SessionPage>(generated.discover(request, signal)),
    preview: (request, signal) => unwrap<SessionPreview>(generated.preview(request, signal)),
    analyze: (request, signal) => unwrap<SmartPreview>(generated.analyze(request, signal)),
    create: (request, signal) => unwrap<CreateOutcome>(generated.create(request, signal)),
    returnPreview: (request, signal) => unwrap<ReturnPreviewResponse>(generated.returnPreview(request, signal)),
    returnSync: (request, signal) => unwrap<ReturnSyncResponse>(generated.returnSync(request, signal)),
  }
}
