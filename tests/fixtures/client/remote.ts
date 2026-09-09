import type { CodexHandoffRemote } from '../../../src/shared/ports.js'
import type {
  CompatibilityView,
  CreateOutcome,
  CreateRequest,
  ExternalSessionSummary,
  SessionPage,
  SessionPreview,
  SmartPreview,
} from '../../../src/shared/types.js'
import type { ClientRemoteContribution, ClientSessionListSnapshot, ClientSessions, SessionId } from '../../../src/client/types.js'

export const session: ExternalSessionSummary = {
  discoveryId: 'discovery-1',
  source: 'codex',
  sessionId: 'session-1',
  rolloutRevisionId: 'rollout-1',
  fingerprint: 'fingerprint-1',
  title: 'A source session',
  cwd: 'C:\\work\\dshp',
  updatedAt: '2026-09-05T00:00:00.000Z',
  archived: false,
  messageCount: 3,
  toolCallCount: 1,
  byteSize: 1024,
  parseHealth: 'complete',
}

export const page: SessionPage = {
  items: [session],
  scannedAt: '2026-09-05T00:00:00.000Z',
  nextCursor: 'cursor-1',
}

export const compatibility: CompatibilityView = {
  compatible: true,
  dshVersion: '2.0.0',
  observedSessionFormat: 2,
  required: {
    agents: true,
    agentDefaultModel: true,
    sessionQuery: true,
    sessionPersistence: true,
    workspaceRegistry: true,
    storageDomain: true,
    typert: true,
  },
  optional: { llm: false, agentPresets: false, conversationSessionHeaderActions: false, settingsSection: false },
  diagnostics: [],
  checkedAt: '2026-09-05T00:00:00.000Z',
}

export function previewFor(source: ExternalSessionSummary = session, bytes = source.byteSize, tokens = 1000, cwdExists = true): SessionPreview {
  return {
    source: { ...source, byteSize: bytes },
    estimatedTokens: tokens,
    estimator: 'fallback',
    largestRecords: [],
    snippets: [],
    repository: {
      observedAt: '2026-09-05T00:00:00.000Z',
      cwd: { requested: source.cwd ?? 'C:\\work\\dshp', canonical: source.cwd ?? 'C:\\work\\dshp', exists: cwdExists },
      relevantPaths: [],
      diagnostics: [],
    },
    completeness: {
      malformedLines: 0,
      unknownRecords: 0,
      droppedEncryptedBlocks: 0,
      danglingToolCalls: 0,
      orphanToolResults: 0,
      truncatedRecords: 0,
    },
    diagnostics: [],
  }
}

export class FakeRemote implements CodexHandoffRemote {
  compatibilityView = compatibility
  page = { ...page }
  previewValue = previewFor()
  analyzeValue = { degraded: false } as SmartPreview
  createOutcome: CreateOutcome = { state: 'created', sessionId: 'dsh-session-1', workspaceAttached: true, warnings: [] }
  discoverRequests: unknown[] = []
  previewRequests: unknown[] = []
  analyzeRequests: unknown[] = []
  createRequests: CreateRequest[] = []
  createCalls = 0
  createShouldFail = false

  compatibility(): Promise<CompatibilityView> {
    return Promise.resolve(this.compatibilityView)
  }

  discover(request: Parameters<CodexHandoffRemote['discover']>[0], signal?: AbortSignal): Promise<SessionPage> {
    this.discoverRequests.push(request)
    if (signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'))
    return Promise.resolve(this.page)
  }

  preview(request: Parameters<CodexHandoffRemote['preview']>[0], signal?: AbortSignal): Promise<SessionPreview> {
    this.previewRequests.push(request)
    if (signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'))
    return Promise.resolve(this.previewValue)
  }

  analyze(request: Parameters<CodexHandoffRemote['analyze']>[0], signal?: AbortSignal): Promise<SmartPreview> {
    this.analyzeRequests.push(request)
    if (signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'))
    return Promise.resolve(this.analyzeValue)
  }

  create(request: CreateRequest, signal?: AbortSignal): Promise<CreateOutcome> {
    this.createCalls += 1
    this.createRequests.push(request)
    if (signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'))
    if (this.createShouldFail) return Promise.reject({ code: 'INTERNAL', message: 'test failure', recoverable: true })
    return Promise.resolve(this.createOutcome)
  }
}

/** Local typed stand-in for the generated Host contribution until F0 emits ./remote. */
export class FakeClientRemote extends FakeRemote {
  readonly codexHandoff: CodexHandoffRemote = this
  readonly mounts: ClientRemoteContribution[] = []
  readonly disposeMount = async (): Promise<void> => undefined
  async $mount(contribution: ClientRemoteContribution): Promise<() => Promise<void>> {
    this.mounts.push(contribution)
    return this.disposeMount
  }
}

export class FakeSessions implements ClientSessions {
  ids: SessionId[] = []
  visibleAfterRefresh = true
  refreshCalls = 0
  opened: string[] = []
  private readonly listeners = new Set<() => void>()
  readonly list = {
    getSnapshot: (): ClientSessionListSnapshot => ({ ids: this.ids }),
    subscribe: (listener: () => void): (() => void) => {
      this.listeners.add(listener)
      return () => this.listeners.delete(listener)
    },
  }

  async refresh(): Promise<void> {
    this.refreshCalls += 1
    if (this.visibleAfterRefresh) this.ids = ['dsh-session-1' as SessionId]
    for (const listener of this.listeners) listener()
  }

  open(id: SessionId): void {
    this.opened.push(id)
  }
}
