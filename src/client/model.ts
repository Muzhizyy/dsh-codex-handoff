import { ERROR_CODES, type ErrorCode } from '../shared/errors.js'
import { BUDGET_LIMITS } from '../shared/limits.js'
import { DiscoverRequestSchema } from '../shared/schemas.js'
import type { CodexHandoffRemote } from '../shared/ports.js'
import type {
  AnalyzeRequest,
  CompatibilityView,
  Consent,
  CreateOutcome,
  CreateRequest,
  DiscoverRequest,
  ExternalSessionRef,
  ExternalSessionSummary,
  SessionPage,
  SessionPreview,
  SmartPreview,
} from '../shared/types.js'
import { consentFor, isConsentValid, type ConsentSelection } from './consent.js'
import { sessionIds, type ClientSessions, type ClientUiWorkspace, type SessionId } from './types.js'

export type ClientPhase = 'closed' | 'browsing' | 'previewing' | 'ready' | 'analyzing' | 'creating' | 'created' | 'cancelled' | 'error'
export type FocusTarget = 'search' | 'results' | 'preview' | 'mode' | 'consent' | 'create'
export type CwdStatus = 'unknown' | 'valid' | 'missing'

export interface ClientUiError {
  readonly code: ErrorCode
  readonly message: string
  readonly recoverable: boolean
}

export interface BudgetEstimate {
  readonly estimatedTokens: number
  readonly estimatedBytes: number
  readonly warning: boolean
  readonly hardLimit: boolean
  readonly requiresConfirmation: boolean
}

export interface HandoffClientState {
  readonly phase: ClientPhase
  readonly compatibility?: CompatibilityView | undefined
  readonly query: DiscoverRequest
  readonly page?: SessionPage | undefined
  readonly selected?: ExternalSessionSummary | undefined
  readonly preview?: SessionPreview | undefined
  readonly smartPreview?: SmartPreview | undefined
  readonly outcome?: CreateOutcome | undefined
  readonly error?: ClientUiError | undefined
  readonly degraded: boolean
  readonly searchPending: boolean
  readonly cwd: string
  readonly cwdStatus: CwdStatus
  readonly mode: 'smart' | 'full'
  readonly useModel: boolean
  readonly targetTokens: number
  readonly unlimitedTokens: boolean
  readonly fullConfirmed: boolean
  readonly consent?: Consent | undefined
  readonly focus: FocusTarget
  readonly resultIndex: number
  /** Local-only audit timestamp; never sent in shared Create/Analyze DTOs. */
  readonly consentAcceptedAt?: number | undefined
}

export interface HandoffClientModelOptions {
  readonly debounceMs?: number
  readonly now?: () => number
  readonly membershipRetries?: number
  readonly membershipDelayMs?: number
}

export type StateListener = (state: HandoffClientState) => void

const DEFAULT_QUERY = DiscoverRequestSchema.parse({})
const DEFAULT_TARGET_TOKENS = BUDGET_LIMITS.defaultTargetTokens
const KNOWN_CODES = new Set<string>(ERROR_CODES)
const SESSION_OPEN_RETRY_MESSAGE = 'Session created but could not be opened. Retry opening it.'

function errorFrom(value: unknown, fallback: ErrorCode = 'INTERNAL'): ClientUiError {
  const candidate = value !== null && typeof value === 'object' ? value as { code?: unknown; message?: unknown; recoverable?: unknown } : {}
  const code = typeof candidate.code === 'string' && KNOWN_CODES.has(candidate.code) ? candidate.code as ErrorCode : fallback
  const message = safeText(typeof candidate.message === 'string' ? candidate.message : '')
  return {
    code,
    message,
    recoverable: typeof candidate.recoverable === 'boolean' ? candidate.recoverable : code !== 'DSH_INCOMPATIBLE',
  }
}

function isAbort(value: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (value instanceof DOMException && value.name === 'AbortError')
}

function isAbsoluteCwd(cwd: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(cwd)
}

function sourceRef(summary: ExternalSessionSummary): ExternalSessionRef {
  return {
    discoveryId: summary.discoveryId,
    source: summary.source,
    sessionId: summary.sessionId,
    rolloutRevisionId: summary.rolloutRevisionId,
    expectedFingerprint: summary.fingerprint,
    archived: summary.archived,
  }
}

function selectionFor(state: Pick<HandoffClientState, 'mode' | 'useModel'>): ConsentSelection {
  return { mode: state.mode, useModel: state.mode === 'smart' && state.useModel }
}

export function safeText(value: unknown, maximum = 4096): string {
  let cleaned = ''
  for (const character of String(value ?? '')) {
    const codePoint = character.codePointAt(0) ?? 0
    cleaned += (codePoint <= 8 || codePoint === 11 || codePoint === 12 || (codePoint >= 14 && codePoint <= 31) || codePoint === 127) ? ' ' : character
  }
  // React receives this value as a text child. Do not entity-encode here: doing
  // so displays the encoding and makes the sanitization contract differ between
  // React and non-React consumers. React's text renderer provides the markup
  // boundary; this helper only removes controls and bounds diagnostics.
  return Array.from(cleaned).slice(0, maximum).join('')
}

export class HandoffClientModel {
  private readonly listeners = new Set<StateListener>()
  private readonly debounceMs: number
  private readonly now: () => number
  private readonly membershipRetries: number
  private readonly membershipDelayMs: number
  private state: HandoffClientState = {
    phase: 'closed',
    query: DEFAULT_QUERY,
    degraded: false,
    searchPending: false,
    cwd: '',
    cwdStatus: 'unknown',
    mode: 'smart',
    useModel: true,
    targetTokens: DEFAULT_TARGET_TOKENS,
    unlimitedTokens: true,
    fullConfirmed: false,
    focus: 'search',
    resultIndex: 0,
  }
  private activeController: AbortController | undefined
  private operationId = 0
  private searchTimer: ReturnType<typeof setTimeout> | undefined
  private searchResolve: ((page: SessionPage | undefined) => void) | undefined
  private createPromise: Promise<CreateOutcome | undefined> | undefined
  private creatingReturnState: HandoffClientState | undefined

  constructor(
    private readonly remote: CodexHandoffRemote,
    private readonly sessions: ClientSessions,
    private readonly uiWorkspace: ClientUiWorkspace,
    options: HandoffClientModelOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 250
    this.now = options.now ?? (() => Date.now())
    this.membershipRetries = Math.max(1, Math.min(5, Math.trunc(options.membershipRetries ?? 3)))
    this.membershipDelayMs = Math.max(0, Math.min(1000, Math.trunc(options.membershipDelayMs ?? 50)))
  }

  getState(): HandoffClientState {
    return this.state
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener)
    listener(this.state)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.abortActive()
    this.clearSearchTimer()
    this.listeners.clear()
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state)
  }

  private setState(patch: Partial<HandoffClientState>): void {
    this.state = { ...this.state, ...patch }
    this.emit()
  }

  private abortActive(): void {
    this.activeController?.abort()
    this.activeController = undefined
    this.operationId += 1
  }

  private beginOperation(): { readonly controller: AbortController; readonly id: number } {
    this.abortActive()
    const controller = new AbortController()
    const id = this.operationId
    this.activeController = controller
    return { controller, id }
  }

  private finishOperation(id: number): void {
    if (this.operationId === id) this.activeController = undefined
  }

  private clearSearchTimer(): void {
    if (this.searchTimer !== undefined) clearTimeout(this.searchTimer)
    this.searchTimer = undefined
    this.searchResolve?.(undefined)
    this.searchResolve = undefined
  }

  private setOperationError(error: unknown, fallback: ErrorCode = 'INTERNAL', phase: ClientPhase = 'error'): ClientUiError {
    const uiError = errorFrom(error, fallback)
    // Any failed operation is settled. Leaving searchPending set traps the
    // dialog in its busy state and makes every primary action look inert.
    this.setState({ error: uiError, phase, searchPending: false })
    return uiError
  }

  private sessionOpenError(): ClientUiError {
    return { code: 'SESSION_NOT_VISIBLE', message: SESSION_OPEN_RETRY_MESSAGE, recoverable: true }
  }

  private setSessionOpenError(): void {
    this.setOperationError(this.sessionOpenError())
  }

  async open(): Promise<void> {
    this.clearSearchTimer()
    this.setState({
      phase: 'browsing',
      compatibility: undefined,
      query: DEFAULT_QUERY,
      page: undefined,
      selected: undefined,
      preview: undefined,
      smartPreview: undefined,
      outcome: undefined,
      error: undefined,
      degraded: false,
      cwd: '',
      cwdStatus: 'unknown',
      consent: undefined,
      consentAcceptedAt: undefined,
      mode: 'smart',
      useModel: true,
      targetTokens: DEFAULT_TARGET_TOKENS,
      unlimitedTokens: true,
      fullConfirmed: false,
      focus: 'search',
      resultIndex: 0,
      searchPending: false,
    })
    try {
      await this.loadCompatibility()
      await this.discover()
    } catch (error) {
      if (!(error instanceof Error && (error.message === 'cancelled' || error.message === 'incompatible'))) this.setOperationError(error)
    }
  }

  async loadCompatibility(): Promise<CompatibilityView> {
    try {
      const compatibility = await this.remote.compatibility()
      this.setState({ compatibility })
      if (!compatibility.compatible || Object.values(compatibility.required).some(value => !value)) {
        this.setOperationError({ code: 'DSH_INCOMPATIBLE', message: '', recoverable: false }, 'DSH_INCOMPATIBLE')
        throw new Error('incompatible')
      }
      return compatibility
    } catch (error) {
      if (error instanceof Error && error.message === 'incompatible') throw error
      this.setOperationError(error)
      throw error
    }
  }

  private async ensureCompatible(): Promise<void> {
    if (this.state.compatibility?.compatible === true) return
    const compatibility = await this.loadCompatibility()
    if (!compatibility.compatible) throw new Error('incompatible')
  }

  private async runDiscover(query: DiscoverRequest, controller: AbortController, id: number): Promise<SessionPage | undefined> {
    try {
      const page = await this.remote.discover(query, controller.signal)
      if (controller.signal.aborted || id !== this.operationId) return undefined
      const mergedPage = query.cursor !== undefined && this.state.page !== undefined
        ? { ...page, items: [...this.state.page.items, ...page.items] }
        : page
      this.setState({ page: mergedPage, query, phase: 'browsing', searchPending: false, error: undefined, resultIndex: query.cursor === undefined ? 0 : this.state.resultIndex })
      return mergedPage
    } catch (error) {
      if (isAbort(error, controller.signal)) return undefined
      if (id === this.operationId) this.setOperationError(error)
      throw error
    } finally {
      this.finishOperation(id)
    }
  }

  async discover(patch: Partial<DiscoverRequest> = {}): Promise<SessionPage | undefined> {
    const query = DiscoverRequestSchema.parse({ ...this.state.query, ...patch })
    const { controller, id } = this.beginOperation()
    this.setState({ query, phase: 'browsing', searchPending: true })
    return this.runDiscover(query, controller, id)
  }

  loadMore(): Promise<SessionPage | undefined> {
    const cursor = this.state.page?.nextCursor
    return cursor === undefined ? Promise.resolve(this.state.page) : this.discover({ cursor })
  }

  search(value: string): Promise<SessionPage | undefined> {
    this.clearSearchTimer()
    this.activeController?.abort()
    const controller = new AbortController()
    this.activeController = controller
    const id = ++this.operationId
    const query = DiscoverRequestSchema.parse({ ...this.state.query, search: value || undefined, cursor: undefined })
    this.setState({ query, searchPending: true, focus: 'results' })
    return new Promise(resolve => {
      this.searchResolve = resolve
      this.searchTimer = setTimeout(() => {
        this.searchTimer = undefined
        this.searchResolve = undefined
        void this.runDiscover(query, controller, id).then(resolve).catch(() => resolve(undefined))
      }, this.debounceMs)
    })
  }

  select(summary: ExternalSessionSummary): void {
    this.abortActive()
    this.clearSearchTimer()
    this.setState({
      selected: summary,
      cwd: summary.cwd ?? '',
      cwdStatus: 'unknown',
      preview: undefined,
      smartPreview: undefined,
      consent: undefined,
      outcome: undefined,
      error: undefined,
      degraded: false,
      mode: 'smart',
      useModel: true,
      targetTokens: DEFAULT_TARGET_TOKENS,
      unlimitedTokens: true,
      fullConfirmed: false,
      phase: 'browsing',
      focus: 'preview',
      resultIndex: Math.max(0, this.state.page?.items.findIndex(item => item.sessionId === summary.sessionId) ?? this.state.resultIndex),
    })
  }

  setCwd(cwd: string): void {
    this.setState({ cwd, cwdStatus: 'unknown', preview: undefined, smartPreview: undefined, consent: undefined, consentAcceptedAt: undefined, degraded: false, error: undefined })
  }

  setMode(mode: 'smart' | 'full'): void {
    this.setState({ mode, useModel: mode === 'smart' ? this.state.useModel : false, consent: undefined, consentAcceptedAt: undefined, smartPreview: undefined, degraded: false, fullConfirmed: false, error: undefined })
  }

  setUseModel(useModel: boolean): void {
    this.setState({ useModel, consent: undefined, consentAcceptedAt: undefined, smartPreview: undefined, degraded: false, error: undefined })
  }

  /** Let a user leave a stalled/degraded model preview and continue with the deterministic path. */
  continueDeterministic(): void {
    if (this.state.mode !== 'smart') return
    this.abortActive()
    this.setState({
      useModel: false,
      consent: undefined,
      consentAcceptedAt: undefined,
      smartPreview: undefined,
      degraded: this.state.degraded,
      error: undefined,
      phase: 'ready',
      focus: 'consent',
    })
  }

  setTargetTokens(targetTokens: number): void {
    const normalized = Number.isSafeInteger(targetTokens) ? Math.trunc(targetTokens) : DEFAULT_TARGET_TOKENS
    const bounded = Math.max(BUDGET_LIMITS.minimumTargetTokens, normalized)
    this.setState({ targetTokens: bounded, unlimitedTokens: false, consent: undefined, consentAcceptedAt: undefined, smartPreview: undefined, degraded: false, error: undefined })
  }

  setUnlimitedTokens(unlimitedTokens: boolean): void {
    this.setState({ unlimitedTokens, consent: undefined, consentAcceptedAt: undefined, smartPreview: undefined, degraded: false, error: undefined })
  }

  setFullConfirmed(fullConfirmed: boolean): void {
    this.setState({ fullConfirmed })
  }

  setArchived(archived: DiscoverRequest['archived']): Promise<SessionPage | undefined> {
    return this.discover({ archived, cursor: undefined })
  }

  setFocus(focus: FocusTarget): void {
    this.setState({ focus })
  }

  async previewSelected(): Promise<SessionPreview | undefined> {
    const selected = this.state.selected
    if (selected === undefined) {
      this.setOperationError({ code: 'SESSION_NOT_VISIBLE', message: '', recoverable: true })
      return undefined
    }
    // PreviewRequest has no cwd override in the shared contract. Keep the UI
    // and repository facts tied to the discovered source cwd instead of
    // pretending a locally edited path was inspected.
    if (selected.cwd === undefined || !isAbsoluteCwd(this.state.cwd) || this.state.cwd !== selected.cwd) {
      this.setOperationError({ code: 'CWD_REQUIRED', message: '', recoverable: true })
      return undefined
    }
    const { controller, id } = this.beginOperation()
    this.setState({ phase: 'previewing', error: undefined, focus: 'preview' })
    try {
      const preview = await this.remote.preview({ source: sourceRef(selected) }, controller.signal)
      if (controller.signal.aborted || id !== this.operationId) return undefined
      const cwdStatus = preview.repository?.cwd.exists === false ? 'missing' : 'valid'
      this.setState({ preview, cwdStatus, phase: 'ready', error: undefined })
      return preview
    } catch (error) {
      if (isAbort(error, controller.signal)) return undefined
      this.setOperationError(error)
      throw error
    } finally {
      this.finishOperation(id)
    }
  }

  getBudgetEstimate(): BudgetEstimate {
    const estimatedTokens = this.state.preview?.estimatedTokens ?? 0
    const estimatedBytes = this.state.preview?.source.byteSize ?? 0
    const warning = estimatedTokens > BUDGET_LIMITS.recommendedWarningTokens || estimatedBytes > BUDGET_LIMITS.recommendedWarningBytes
    const hardLimit = estimatedTokens > BUDGET_LIMITS.hardTrajectoryTokens || estimatedBytes > BUDGET_LIMITS.hardTrajectoryBytes
    return {
      estimatedTokens,
      estimatedBytes,
      warning,
      hardLimit,
      requiresConfirmation: this.state.mode === 'full' && warning,
    }
  }

  acceptConsent(): Consent | undefined {
    if (this.state.selected === undefined || this.state.preview === undefined || this.state.selected.cwd === undefined || !isAbsoluteCwd(this.state.cwd) || this.state.cwd !== this.state.selected.cwd) {
      this.setOperationError({ code: 'CWD_REQUIRED', message: '', recoverable: true })
      return undefined
    }
    const consent = consentFor(selectionFor(this.state))
    this.setState({ consent, consentAcceptedAt: this.now(), phase: 'ready', error: undefined })
    return consent
  }

  async analyzeSmart(): Promise<SmartPreview | undefined> {
    if (this.state.mode !== 'smart' || this.state.selected === undefined || this.state.preview === undefined) {
      this.setOperationError({ code: 'SMART_CONTEXT_CANNOT_FIT', message: '', recoverable: true })
      return undefined
    }
    const consent = consentFor(selectionFor(this.state))
    if (!isConsentValid(this.state.consent, selectionFor(this.state))) {
      this.setOperationError({ code: 'TRAJECTORY_CONFIRMATION_REQUIRED', message: '', recoverable: true })
      return undefined
    }
    const budget = this.state.unlimitedTokens ? {} : { targetTokens: this.state.targetTokens }
    const request: AnalyzeRequest = this.state.useModel
      ? {
          source: sourceRef(this.state.selected),
          cwd: this.state.cwd,
          expectedFingerprint: this.state.selected.fingerprint,
          ...budget,
          useModel: true,
          consent: consent as Extract<Consent, { readonly modelAnalysis: true }>,
        }
      : {
          source: sourceRef(this.state.selected),
          cwd: this.state.cwd,
          expectedFingerprint: this.state.selected.fingerprint,
          ...budget,
          useModel: false,
          consent: consent as Extract<Consent, { readonly modelAnalysis: false; readonly acceptedMode: 'smart' }>,
        }
    const { controller, id } = this.beginOperation()
    this.setState({ phase: 'analyzing', error: undefined })
    try {
      const smartPreview = await this.remote.analyze(request, controller.signal)
      if (controller.signal.aborted || id !== this.operationId) return undefined
      const deterministicConsent = consentFor({ mode: 'smart', useModel: false }) as Extract<Consent, { readonly modelAnalysis: false; readonly acceptedMode: 'smart' }>
      // A successful degraded response already contains a usable deterministic
      // preview. Downshift the pending create request too, otherwise Create
      // would invoke the failing model path a second time.
      this.setState({
        smartPreview,
        degraded: smartPreview.degraded,
        useModel: smartPreview.degraded ? false : this.state.useModel,
        consent: smartPreview.degraded ? deterministicConsent : this.state.consent,
        phase: 'ready',
        error: undefined,
      })
      return smartPreview
    } catch (error) {
      if (isAbort(error, controller.signal)) return undefined
      const uiError = errorFrom(error)
      // The Host normally performs this fallback inside the Smart engine. A
      // transport/runtime INTERNAL or an explicit analyzer-degraded response
      // can still escape that boundary, so retry exactly once without a model.
      // Known source, consent, budget, and validation failures remain visible
      // instead of being mislabeled as a successful degradation.
      if (request.useModel && (uiError.code === 'INTERNAL' || uiError.code === 'SMART_ANALYZER_DEGRADED')) {
        const deterministicConsent = consentFor({ mode: 'smart', useModel: false }) as Extract<Consent, { readonly modelAnalysis: false; readonly acceptedMode: 'smart' }>
        try {
          const fallbackPreview = await this.remote.analyze({
            source: request.source,
            cwd: request.cwd,
            expectedFingerprint: request.expectedFingerprint,
            ...(request.targetTokens === undefined ? {} : { targetTokens: request.targetTokens }),
            useModel: false,
            consent: deterministicConsent,
          }, controller.signal)
          if (controller.signal.aborted || id !== this.operationId) return undefined
          const degradedPreview: SmartPreview = { ...fallbackPreview, degraded: true }
          this.setState({
            smartPreview: degradedPreview,
            degraded: true,
            useModel: false,
            consent: deterministicConsent,
            phase: 'ready',
            error: undefined,
          })
          return degradedPreview
        } catch (fallbackError) {
          if (isAbort(fallbackError, controller.signal)) return undefined
          const fallbackUiError = errorFrom(fallbackError)
          this.setState({ smartPreview: undefined, degraded: false, phase: 'ready', error: fallbackUiError })
          return undefined
        }
      }
      this.setState({ smartPreview: undefined, degraded: false, phase: 'ready', error: uiError })
      return undefined
    } finally {
      this.finishOperation(id)
    }
  }

  private buildCreateRequest(): CreateRequest | undefined {
    const selected = this.state.selected
    if (selected === undefined || this.state.preview === undefined) {
      this.setOperationError({ code: 'SMART_CONTEXT_CANNOT_FIT', message: '', recoverable: true })
      return undefined
    }
    if (selected.cwd === undefined || !isAbsoluteCwd(this.state.cwd) || this.state.cwd !== selected.cwd) {
      this.setOperationError({ code: 'CWD_REQUIRED', message: '', recoverable: true })
      return undefined
    }
    if (this.state.cwdStatus === 'missing' || this.state.preview.repository?.cwd.exists === false) {
      this.setOperationError({ code: 'CWD_NOT_FOUND', message: '', recoverable: true })
      return undefined
    }
    const estimate = this.getBudgetEstimate()
    if (estimate.hardLimit) {
      this.setOperationError({ code: 'TRAJECTORY_TOO_LARGE', message: '', recoverable: false })
      return undefined
    }
    if (estimate.requiresConfirmation && !this.state.fullConfirmed) {
      this.setOperationError({ code: 'TRAJECTORY_CONFIRMATION_REQUIRED', message: '', recoverable: true })
      return undefined
    }
    if (!isConsentValid(this.state.consent, selectionFor(this.state))) {
      this.setOperationError({ code: 'TRAJECTORY_CONFIRMATION_REQUIRED', message: '', recoverable: true })
      return undefined
    }
    const consent = consentFor(selectionFor(this.state))
    const source = sourceRef(selected)
    if (this.state.mode === 'full') {
      return {
        source,
        cwd: this.state.cwd,
        expectedFingerprint: selected.fingerprint,
        mode: 'full',
        consent: consent as Extract<Consent, { readonly acceptedMode: 'full' }>,
        full: { confirmedLarge: this.state.fullConfirmed },
      }
    }
    if (this.state.useModel) {
      return {
        source,
        cwd: this.state.cwd,
        expectedFingerprint: selected.fingerprint,
        mode: 'smart',
        consent: consent as Extract<Consent, { readonly modelAnalysis: true }>,
        smart: { useModel: true, ...(this.state.unlimitedTokens ? {} : { targetTokens: this.state.targetTokens }) },
      }
    }
    return {
      source,
      cwd: this.state.cwd,
      expectedFingerprint: selected.fingerprint,
      mode: 'smart',
      consent: consent as Extract<Consent, { readonly modelAnalysis: false; readonly acceptedMode: 'smart' }>,
      smart: { useModel: false, ...(this.state.unlimitedTokens ? {} : { targetTokens: this.state.targetTokens }) },
    }
  }

  create(): Promise<CreateOutcome | undefined> {
    if (this.createPromise !== undefined) return this.createPromise
    if (this.state.outcome !== undefined) {
      if (this.state.phase === 'created') return Promise.resolve(this.state.outcome)
      this.createPromise = this.retryOpen()
    } else this.createPromise = this.performCreate()
    return this.createPromise
  }

  private async performCreate(): Promise<CreateOutcome | undefined> {
    let operationId: number | undefined
    let outcome: CreateOutcome | undefined
    try {
      await this.ensureCompatible()
      const request = this.buildCreateRequest()
      if (request === undefined) return undefined
      const { controller, id } = this.beginOperation()
      operationId = id
      this.creatingReturnState = this.state
      this.setState({ phase: 'creating', error: undefined, focus: 'create' })
      outcome = await this.remote.create(request, controller.signal)
      if (controller.signal.aborted || id !== this.operationId) return undefined
      this.setState({ outcome })
      const visible = await this.refreshUntilVisible(outcome.sessionId, controller.signal)
      if (controller.signal.aborted || id !== this.operationId) return undefined
      if (!visible) {
        this.setSessionOpenError()
        return outcome
      }
      // Membership proves the destination session exists, regardless of
      // whether workspace attachment completed. Open it exactly once; an
      // unattached result keeps this overlay alive so its warning can be read
      // and explicitly dismissed.
      this.uiWorkspace.openSession(outcome.sessionId as SessionId)
      if (outcome.state === 'created_unattached') {
        this.setState({ outcome, phase: 'created', error: undefined, focus: 'create' })
      } else {
        // An attached destination is now owned by the DSH session surface; the
        // handoff overlay must not remain mounted over the newly opened session.
        this.close()
      }
      return outcome
    } catch (error) {
      if (error instanceof Error && error.message === 'incompatible') return undefined
      if (operationId !== undefined && (operationId !== this.operationId || this.activeController?.signal.aborted)) return undefined
      if (this.state.outcome !== undefined) {
        this.setSessionOpenError()
        return this.state.outcome
      }
      this.setOperationError(error)
      return undefined
    } finally {
      if (this.createPromise !== undefined) this.createPromise = undefined
      if (operationId !== undefined && this.operationId === operationId) this.creatingReturnState = undefined
      if (operationId !== undefined) this.finishOperation(operationId)
    }
  }

  private async waitForVisibleSnapshot(sessionId: string, signal: AbortSignal): Promise<boolean> {
    const list = this.sessions.list
    if (signal.aborted) return false
    const subscribe = list.subscribe
    if (subscribe === undefined) {
      await new Promise<void>(resolve => setTimeout(resolve, this.membershipDelayMs))
      return !signal.aborted && sessionIds(list.getSnapshot()).includes(sessionId as SessionId)
    }
    return new Promise(resolve => {
      let settled = false
      let unsubscribe = (): void => undefined
      const timerRef: { value?: ReturnType<typeof setTimeout> } = {}
      const finish = (visible: boolean) => {
        if (settled) return
        settled = true
        if (timerRef.value !== undefined) clearTimeout(timerRef.value)
        unsubscribe()
        signal.removeEventListener('abort', onAbort)
        resolve(visible)
      }
      const onAbort = () => finish(false)
      unsubscribe = subscribe(() => {
        if (sessionIds(list.getSnapshot()).includes(sessionId as SessionId)) finish(true)
      })
      if (settled) {
        unsubscribe()
        return
      }
      timerRef.value = setTimeout(() => finish(sessionIds(list.getSnapshot()).includes(sessionId as SessionId)), this.membershipDelayMs)
      signal.addEventListener('abort', onAbort, { once: true })
      if (sessionIds(list.getSnapshot()).includes(sessionId as SessionId)) finish(true)
    })
  }

  private async refreshUntilVisible(sessionId: string, signal: AbortSignal): Promise<boolean> {
    for (let attempt = 0; attempt < this.membershipRetries; attempt += 1) {
      if (signal.aborted) return false
      await this.sessions.refresh()
      if (sessionIds(this.sessions.list.getSnapshot()).includes(sessionId as SessionId)) return true
      if (await this.waitForVisibleSnapshot(sessionId, signal)) return true
    }
    return false
  }

  async retry(): Promise<CreateOutcome | undefined> {
    if (this.state.error?.code === 'SESSION_NOT_VISIBLE' && this.state.outcome !== undefined) return this.create()
    // Retry the stage that produced the visible error. A discovery failure has
    // no selected source, while a preview failure has no accepted preview yet.
    // Falling through to create in either state is a silent no-op because no
    // valid CreateRequest can be built.
    if (this.state.compatibility === undefined) {
      await this.open()
      return undefined
    }
    if (this.state.selected === undefined) {
      await this.discover()
      return undefined
    }
    if (this.state.preview === undefined) {
      await this.previewSelected()
      return undefined
    }
    if (this.state.mode === 'smart' && this.state.smartPreview === undefined && this.state.error !== undefined
      && ['INTERNAL', 'SMART_ANALYZER_DEGRADED', 'SMART_CONTEXT_CANNOT_FIT'].includes(this.state.error.code)) {
      await this.analyzeSmart()
      return undefined
    }
    return this.create()
  }

  private async retryOpen(): Promise<CreateOutcome | undefined> {
    const outcome = this.state.outcome
    if (outcome === undefined) return undefined
    const { controller, id } = this.beginOperation()
    this.creatingReturnState = this.state
    this.setState({ phase: 'creating', error: undefined, focus: 'create' })
    try {
      const visible = await this.refreshUntilVisible(outcome.sessionId, controller.signal)
      if (controller.signal.aborted || id !== this.operationId) return undefined
      if (!visible) {
        this.setSessionOpenError()
        return outcome
      }
      this.uiWorkspace.openSession(outcome.sessionId as SessionId)
      if (outcome.state === 'created_unattached') {
        this.setState({ phase: 'created', error: undefined, focus: 'create' })
      } else {
        this.close()
      }
      return outcome
    } catch (error) {
      if (isAbort(error, controller.signal) || id !== this.operationId) return outcome
      this.setSessionOpenError()
      return outcome
    } finally {
      if (this.createPromise !== undefined) this.createPromise = undefined
      this.finishOperation(id)
    }
  }

  cancel(): void {
    if (this.state.phase === 'creating' && this.creatingReturnState !== undefined) {
      const prior = this.creatingReturnState
      const acknowledgedOutcome = this.state.outcome
      this.creatingReturnState = undefined
      this.abortActive()
      this.clearSearchTimer()
      // Before the remote acknowledges creation, restore the browse/ready
      // state. After acknowledgement, keep the outcome for an open-only retry.
      this.setState(acknowledgedOutcome === undefined
        ? { ...prior, searchPending: false, error: undefined }
        : { ...prior, outcome: acknowledgedOutcome, phase: 'error', searchPending: false, error: this.sessionOpenError() })
      return
    }
    this.abortActive()
    this.clearSearchTimer()
    this.setState({ phase: 'cancelled', searchPending: false, error: errorFrom({ code: 'CANCELLED', message: '', recoverable: true }, 'CANCELLED') })
  }

  keyboard(key: string): void {
    if (key === 'Escape') {
      if (this.state.phase === 'creating') this.cancel()
      else this.close()
    } else if (key === 'ArrowDown' || key === 'ArrowUp') {
      this.moveResult(key === 'ArrowDown' ? 1 : -1)
    } else if (key === 'Enter' && this.state.focus === 'results') {
      this.activateResult()
    } else if (key === 'Enter' && this.state.focus === 'create') {
      void this.create()
    }
  }

  moveResult(delta: number): void {
    const items = this.state.page?.items ?? []
    if (items.length === 0) return
    const next = (this.state.resultIndex + delta + items.length) % items.length
    this.setState({ resultIndex: next, focus: 'results' })
  }

  activateResult(): void {
    const item = this.state.page?.items[this.state.resultIndex]
    if (item !== undefined) {
      this.select(item)
      void this.previewSelected()
    }
  }

  close(): void {
    this.creatingReturnState = undefined
    this.abortActive()
    this.clearSearchTimer()
    this.setState({
      phase: 'closed',
      compatibility: undefined,
      query: DEFAULT_QUERY,
      page: undefined,
      selected: undefined,
      preview: undefined,
      smartPreview: undefined,
      outcome: undefined,
      searchPending: false,
      cwd: '',
      cwdStatus: 'unknown',
      mode: 'smart',
      useModel: true,
      targetTokens: DEFAULT_TARGET_TOKENS,
      unlimitedTokens: true,
      fullConfirmed: false,
      consent: undefined,
      consentAcceptedAt: undefined,
      degraded: false,
      error: undefined,
      focus: 'search',
      resultIndex: 0,
    })
  }
}
