import type { CodexHandoffRemote } from '../shared/ports.js'
import type { ReturnPreviewResponse, ReturnSyncResponse } from '../shared/types.js'

export type ReturnClientPhase = 'closed' | 'previewing' | 'ready' | 'syncing' | 'success' | 'unknown' | 'error'

export interface ReturnClientError {
  readonly code: string
  readonly message?: string
  readonly canRefresh: boolean
}

export interface ReturnClientState {
  readonly phase: ReturnClientPhase
  readonly dshSessionId?: string
  readonly preview?: ReturnPreviewResponse
  readonly outcome?: ReturnSyncResponse
  readonly error?: ReturnClientError
  readonly copied: boolean
  readonly copyFailed: boolean
}

const CLOSED: ReturnClientState = Object.freeze({ phase: 'closed', copied: false, copyFailed: false })

function thrownError(value: unknown): { readonly code: string; readonly message?: string } {
  if (value !== null && typeof value === 'object') {
    const record = value as { readonly code?: unknown; readonly message?: unknown }
    return {
      code: typeof record.code === 'string' ? record.code : 'INTERNAL',
      ...(typeof record.message === 'string' ? { message: record.message } : {}),
    }
  }
  return { code: 'INTERNAL' }
}

function isUnknownError(error: unknown): boolean {
  return thrownError(error).code === 'RETURN_RESULT_UNKNOWN'
}

function canRefreshSyncError(error: unknown): boolean {
  const code = thrownError(error).code
  return code === 'RETURN_STALE' || code === 'RETURN_PREVIEW_EXPIRED'
}

/** One current DSH session, one durable preview receipt, and at most one dispatch. */
export class ReturnClientModel {
  private state: ReturnClientState = CLOSED
  private readonly listeners = new Set<(state: ReturnClientState) => void>()
  private generation = 0
  private previewController: AbortController | undefined
  private syncController: AbortController | undefined
  private previewPromise: Promise<void> | undefined
  private syncPromise: Promise<void> | undefined
  private disposed = false

  constructor(private readonly remote: Pick<CodexHandoffRemote, 'returnPreview' | 'returnSync'>) {}

  getState(): ReturnClientState {
    return this.state
  }

  subscribe(listener: (state: ReturnClientState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  open(dshSessionId: string): Promise<void> {
    if (this.disposed || this.state.phase === 'syncing') return Promise.resolve()
    if (this.previewPromise !== undefined && this.state.dshSessionId === dshSessionId) return this.previewPromise
    this.previewController?.abort()
    const generation = ++this.generation
    const controller = new AbortController()
    this.previewController = controller
    this.setState({ phase: 'previewing', dshSessionId, copied: false, copyFailed: false })

    const pending = Promise.resolve().then(async () => {
      try {
        if (!this.isCurrent(generation)) return
        const preview = await this.remote.returnPreview({ dshSessionId }, controller.signal)
        if (!this.isCurrent(generation)) return
        this.setState({ phase: 'ready', dshSessionId, preview, copied: false, copyFailed: false })
      } catch (error) {
        if (!this.isCurrent(generation) || controller.signal.aborted) return
        const details = thrownError(error)
        this.setState({
          phase: 'error', dshSessionId, copied: false, copyFailed: false,
          error: { ...details, canRefresh: true },
        })
      } finally {
        if (this.previewController === controller) this.previewController = undefined
        if (this.previewPromise === pending) this.previewPromise = undefined
      }
    })
    this.previewPromise = pending
    return pending
  }

  refreshPreview(): Promise<void> {
    const dshSessionId = this.state.dshSessionId
    if (dshSessionId === undefined || this.disposed || this.state.phase === 'syncing') return Promise.resolve()
    return this.open(dshSessionId)
  }

  sync(): Promise<void> {
    if (this.disposed || this.state.phase !== 'ready' || this.state.preview === undefined) return this.syncPromise ?? Promise.resolve()
    if (this.syncPromise !== undefined) return this.syncPromise

    const preview = this.state.preview
    const { receiptId } = preview
    const dshSessionId = this.state.dshSessionId
    if (dshSessionId === undefined) return Promise.resolve()
    const generation = ++this.generation
    const controller = new AbortController()
    this.syncController = controller
    this.setState({ phase: 'syncing', dshSessionId, preview, copied: false, copyFailed: false })

    const pending = Promise.resolve().then(async () => {
      try {
        if (!this.isCurrent(generation)) return
        const outcome = await this.remote.returnSync({ receiptId }, controller.signal)
        if (!this.isCurrent(generation)) return
        this.setState({
          phase: outcome.status === 'unknown' ? 'unknown' : 'success',
          dshSessionId,
          preview,
          outcome,
          copied: false,
          copyFailed: false,
        })
      } catch (error) {
        if (!this.isCurrent(generation) || controller.signal.aborted) return
        if (isUnknownError(error)) {
          this.setState({ phase: 'unknown', dshSessionId, preview, copied: false, copyFailed: false })
          return
        }
        const details = thrownError(error)
        this.setState({
          phase: 'error', dshSessionId, preview, copied: false, copyFailed: false,
          error: { ...details, canRefresh: canRefreshSyncError(error) },
        })
      } finally {
        if (this.syncController === controller) this.syncController = undefined
        if (this.syncPromise === pending) this.syncPromise = undefined
      }
    })
    this.syncPromise = pending
    return pending
  }

  async copyResumeCommand(writeText: (value: string) => Promise<void>): Promise<void> {
    const outcome = this.state.outcome
    if (this.disposed || this.state.phase !== 'success' || outcome === undefined || outcome.status === 'unknown') return
    const generation = this.generation
    const receiptId = outcome.receiptId
    const command = outcome.resume.displayCommand
    try {
      await writeText(command)
      if (this.isCurrent(generation) && this.state.phase === 'success' && this.state.outcome?.receiptId === receiptId) {
        this.setState({ ...this.state, copied: true, copyFailed: false })
      }
    } catch {
      if (this.isCurrent(generation) && this.state.phase === 'success' && this.state.outcome?.receiptId === receiptId) {
        this.setState({ ...this.state, copied: false, copyFailed: true })
      }
    }
  }

  close(): void {
    if (this.disposed || this.state.phase === 'syncing') return
    this.previewController?.abort()
    this.previewController = undefined
    this.previewPromise = undefined
    this.generation += 1
    this.setState(CLOSED)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    this.previewController?.abort()
    this.syncController?.abort()
    this.previewController = undefined
    this.syncController = undefined
    this.previewPromise = undefined
    this.syncPromise = undefined
    this.state = CLOSED
    this.listeners.clear()
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation
  }

  private setState(state: ReturnClientState): void {
    if (this.disposed) return
    this.state = state
    for (const listener of this.listeners) listener(state)
  }
}
