import type {
  AgentHandoffManifest,
  AnalysisClaims,
  AnalyzeRequest,
  CompatibilityView,
  CompiledContext,
  CreateOutcome,
  DiscoverQuery,
  EvidenceBundle,
  ExternalSessionRef,
  NormalizedSession,
  PreparedImport,
  RepositoryState,
  SessionPage,
  SessionPreview,
  SmartPreview,
  TokenBudget,
} from './types.js'

export interface SessionSource {
  readonly kind: 'codex'
  discover(query: DiscoverQuery, signal: AbortSignal): Promise<SessionPage>
  preview(ref: ExternalSessionRef, limits: import('./types.js').ParseLimits, signal: AbortSignal): Promise<SessionPreview>
  load(ref: ExternalSessionRef, limits: import('./types.js').ParseLimits, signal: AbortSignal): Promise<NormalizedSession>
}

export interface RepositoryInspector {
  inspect(cwd: string, relevantPaths: readonly string[], signal: AbortSignal): Promise<RepositoryState>
}

export interface ConversationAnalyzer {
  analyze(session: NormalizedSession, redactedEvidence: EvidenceBundle, signal: AbortSignal): Promise<AnalysisClaims>
}

export interface StateReconciler {
  reconcile(session: NormalizedSession, claims: AnalysisClaims, repository: RepositoryState): AgentHandoffManifest
}

export interface ContextCompiler {
  compile(manifest: AgentHandoffManifest, budget: TokenBudget): CompiledContext
}

export interface DshSessionGateway {
  create(request: PreparedImport, signal: AbortSignal): Promise<CreateOutcome>
  find(identity: import('./types.js').ImportIdentity, signal: AbortSignal): Promise<string | undefined>
}

export interface CodexHandoffRemote {
  compatibility(): Promise<CompatibilityView>
  discover(req: import('./types.js').DiscoverRequest, signal?: AbortSignal): Promise<SessionPage>
  preview(req: import('./types.js').PreviewRequest, signal?: AbortSignal): Promise<SessionPreview>
  analyze(req: AnalyzeRequest, signal?: AbortSignal): Promise<SmartPreview>
  create(req: import('./types.js').CreateRequest, signal?: AbortSignal): Promise<CreateOutcome>
  returnPreview(req: import('./return.js').ReturnPreviewRequest, signal?: AbortSignal): Promise<import('./return.js').ReturnPreviewResponse>
  returnSync(req: import('./return.js').ReturnSyncRequest, signal?: AbortSignal): Promise<import('./return.js').ReturnSyncResponse>
}
