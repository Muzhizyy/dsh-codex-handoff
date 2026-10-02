import { AgentHandoffManifestSchema, AnalysisClaimsSchema, TokenBudgetSchema } from '../shared/schemas.js'
import { HandoffError } from '../shared/errors.js'
import type { AgentHandoffManifest, AnalysisClaims, EvidenceBundle, NormalizedSession, RepositoryState, TokenBudget } from '../shared/types.js'
import type { ContextCompiler, ConversationAnalyzer, StateReconciler } from '../shared/ports.js'
import { DeterministicConversationAnalyzer, extractDeterministicClaims } from './extractor.js'
import { selectEvidence } from './evidence.js'
import { DshLlmAnalyzer, type DshLlmRuntime } from './llm-adapter.js'
import { DeterministicStateReconciler } from './reconciler.js'
import { DeterministicContextCompiler } from './compiler.js'

export interface SmartHandoffEngineOptions {
  readonly now?: () => Date
  readonly analyzer?: ConversationAnalyzer
  readonly reconciler?: StateReconciler
  readonly compiler?: ContextCompiler
  readonly llmRuntime?: DshLlmRuntime
  readonly llmTimeoutMs?: number
}

export interface SmartBuildResult {
  readonly evidence: EvidenceBundle
  readonly claims: AnalysisClaims
  readonly manifest: AgentHandoffManifest
  readonly context: ReturnType<DeterministicContextCompiler['compile']>
  readonly degraded: boolean
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true
  if (error instanceof HandoffError) return error.code === 'CANCELLED'
  return error instanceof Error && error.name === 'AbortError'
}

function isDeterministicFailure(error: unknown): boolean {
  if (error === null || typeof error !== 'object' || !('code' in error)) return false
  const code = (error as { readonly code?: unknown }).code
  return code === 'SMART_CONTEXT_CANNOT_FIT' || code === 'TRAJECTORY_TOO_LARGE' || code === 'DSH_SEED_INVALID'
}

function degradedDiagnostic(message: string): import('../shared/types.js').Diagnostic {
  return {
    code: 'SMART_ANALYZER_DEGRADED',
    severity: 'warning',
    message,
    recoverable: true,
  }
}

/** Pure Smart pipeline with optional injected, one-shot DSH model enhancement. */
export class SmartHandoffEngine {
  readonly now: () => Date
  readonly deterministic: ConversationAnalyzer
  readonly analyzer: ConversationAnalyzer
  readonly reconciler: StateReconciler
  readonly compiler: ContextCompiler
  readonly model: DshLlmAnalyzer | undefined

  constructor(options: SmartHandoffEngineOptions = {}) {
    this.now = options.now ?? (() => new Date())
    this.deterministic = new DeterministicConversationAnalyzer({ now: this.now })
    this.analyzer = options.analyzer ?? this.deterministic
    this.reconciler = options.reconciler ?? new DeterministicStateReconciler({ now: this.now })
    this.compiler = options.compiler ?? new DeterministicContextCompiler()
    this.model = options.llmRuntime === undefined
      ? undefined
      : new DshLlmAnalyzer(options.llmRuntime, options.llmTimeoutMs === undefined ? {} : { timeoutMs: options.llmTimeoutMs })
  }

  selectEvidence(session: NormalizedSession, repository: RepositoryState): EvidenceBundle {
    return selectEvidence(session, repository)
  }

  async analyze(session: NormalizedSession, evidence: EvidenceBundle, signal: AbortSignal, useModel = false): Promise<{ claims: AnalysisClaims; degraded: boolean; diagnostics: readonly import('../shared/types.js').Diagnostic[] }> {
    if (useModel) {
      if (this.model === undefined) {
        const claims = await this.deterministic.analyze(session, evidence, signal)
        const warning = degradedDiagnostic('Smart model analysis was requested but no model or selection is available; deterministic analysis was used.')
        const parsed = AnalysisClaimsSchema.parse({ ...claims, diagnostics: [...claims.diagnostics, warning] }) as unknown as AnalysisClaims
        return { claims: parsed, degraded: true, diagnostics: [warning] }
      }
      try {
        const result = await this.model.analyze(evidence, async () => this.deterministic.analyze(session, evidence, signal), signal)
        const claims = result.claims ?? await this.deterministic.analyze(session, evidence, signal)
        const diagnostics = result.degraded
          ? [...claims.diagnostics, ...result.diagnostics, degradedDiagnostic('Smart model analysis was unavailable or its selection was invalid; deterministic analysis was used.')]
          : [...claims.diagnostics, ...result.diagnostics]
        const parsed = AnalysisClaimsSchema.parse({ ...claims, diagnostics }) as unknown as AnalysisClaims
        return { claims: parsed, degraded: result.degraded, diagnostics: result.diagnostics }
      } catch (error) {
        if (isCancellation(error, signal)) throw error
        const claims = await this.deterministic.analyze(session, evidence, signal)
        const warning = degradedDiagnostic('Model-derived claims were invalid; deterministic analysis was used.')
        const parsed = AnalysisClaimsSchema.parse({ ...claims, diagnostics: [...claims.diagnostics, warning] }) as unknown as AnalysisClaims
        return { claims: parsed, degraded: true, diagnostics: [warning] }
      }
    }
    return { claims: await this.analyzer.analyze(session, evidence, signal), degraded: false, diagnostics: [] }
  }

  reconcile(session: NormalizedSession, claims: AnalysisClaims, repository: RepositoryState, analyzer: 'dsh-model' | 'deterministic-fallback' = 'deterministic-fallback'): AgentHandoffManifest {
    const reconciler = this.reconciler instanceof DeterministicStateReconciler ? new DeterministicStateReconciler({ now: this.now, analyzer }) : this.reconciler
    return AgentHandoffManifestSchema.parse(reconciler.reconcile(session, claims, repository))
  }

  compile(manifest: AgentHandoffManifest, budget: TokenBudget) {
    return this.compiler.compile(manifest, TokenBudgetSchema.parse(budget))
  }

  async build(session: NormalizedSession, repository: RepositoryState, budget: TokenBudget, signal: AbortSignal = new AbortController().signal, useModel = false): Promise<SmartBuildResult> {
    const evidence = this.selectEvidence(session, repository)
    const analysis = await this.analyze(session, evidence, signal, useModel)
    let claims = analysis.claims
    let degraded = analysis.degraded
    let manifest: AgentHandoffManifest
    try {
      manifest = this.reconcile(session, claims, repository, degraded ? 'deterministic-fallback' : useModel ? 'dsh-model' : 'deterministic-fallback')
    } catch (error) {
      // A deterministic error (budget, required fact, or cancellation) is
      // actionable and must remain visible. Only a successful model pass whose
      // claims fail downstream validation is eligible for a deterministic
      // retry; this keeps Smart from swallowing hard Full/Smart invariants.
      if (!useModel || analysis.degraded || isCancellation(error, signal) || isDeterministicFailure(error)) throw error
      claims = await this.deterministic.analyze(session, evidence, signal)
      manifest = AgentHandoffManifestSchema.parse(new DeterministicStateReconciler({ now: this.now, analyzer: 'deterministic-fallback' }).reconcile(session, claims, repository))
      degraded = true
    }
    // Keep compilation outside the model fallback catch. Budget and required
    // fact failures are deterministic contract errors and must propagate even
    // when the model-derived claims needed reconciliation fallback.
    const context = this.compile(manifest, budget)
    return { evidence, claims, manifest, context, degraded }
  }
}

export const buildSmartHandoff = async (session: NormalizedSession, repository: RepositoryState, budget: TokenBudget, options?: SmartHandoffEngineOptions, signal?: AbortSignal, useModel = false): Promise<SmartBuildResult> => new SmartHandoffEngine(options).build(session, repository, budget, signal, useModel)

export { extractDeterministicClaims }
