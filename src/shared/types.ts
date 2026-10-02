import type { infer as Infer } from 'zod'

import type * as Schemas from './schemas.js'

export type IsoDateTime = string
export type SessionSourceKind = Infer<typeof Schemas.SessionSourceKindSchema>
export type HandoffMode = Infer<typeof Schemas.HandoffModeSchema>
export type Severity = Infer<typeof Schemas.SeveritySchema>
export type ParseHealth = Infer<typeof Schemas.ParseHealthSchema>
export type DiagnosticRecord = Infer<typeof Schemas.DiagnosticRecordSchema>
export type Diagnostic = Infer<typeof Schemas.DiagnosticSchema>
export type SourceRef = Infer<typeof Schemas.SourceRefSchema>

export type ExternalSessionSummary = Infer<typeof Schemas.ExternalSessionSummarySchema>
export type SessionPage = Infer<typeof Schemas.SessionPageSchema>
export type ExternalSessionRef = Infer<typeof Schemas.ExternalSessionRefSchema>

export type NormalizedEvent = Infer<typeof Schemas.NormalizedEventSchema>
export type LifecyclePayload = Infer<typeof Schemas.LifecyclePayloadSchema>
export type NormalizedSession = Infer<typeof Schemas.NormalizedSessionSchema>
export type NormalizedSessionV1 = Infer<typeof Schemas.NormalizedSessionV1Schema>
export type NormalizedSessionRead = Infer<typeof Schemas.NormalizedSessionReadSchema>
export type PathChange = Infer<typeof Schemas.PathChangeSchema>
export type RepositoryState = Infer<typeof Schemas.RepositoryStateSchema>

export type ProvenanceKind = Infer<typeof Schemas.ProvenanceKindSchema>
export type ProvenanceRecord = Infer<typeof Schemas.ProvenanceRecordSchema>
export type Claim = Infer<typeof Schemas.ClaimSchema>
export type AnalysisClaim = Infer<typeof Schemas.AnalysisClaimSchema>
export type VerificationClaim = Infer<typeof Schemas.VerificationClaimSchema>

export type ManifestText = Infer<typeof Schemas.ManifestTextSchema>
export type WorkItem = Infer<typeof Schemas.WorkItemSchema>
export type Decision = Infer<typeof Schemas.DecisionSchema>
export type FailedAttempt = Infer<typeof Schemas.FailedAttemptSchema>
export type Problem = Infer<typeof Schemas.ProblemSchema>
export type RelevantFile = Infer<typeof Schemas.RelevantFileSchema>
export type CommandRecord = Infer<typeof Schemas.CommandRecordSchema>
export type VerificationItem = Infer<typeof Schemas.VerificationItemSchema>
export type ActionItem = Infer<typeof Schemas.ActionItemSchema>
export type AgentHandoffManifest = Infer<typeof Schemas.AgentHandoffManifestSchema>

export type ImportIdentity = Infer<typeof Schemas.ImportIdentitySchema>
export type ImportRecoveryIntent = Infer<typeof Schemas.ImportRecoveryIntentSchema>
export type ImportRecord = Infer<typeof Schemas.ImportRecordSchema>
export type ImportRecordV1 = Infer<typeof Schemas.ImportRecordV1Schema>
export type ImportRecordRead = Infer<typeof Schemas.ImportRecordReadSchema>
export type DestinationCheck = Infer<typeof Schemas.DestinationCheckSchema>
export type ImportFailure = Infer<typeof Schemas.ImportFailureSchema>
export type ParseLimits = Infer<typeof Schemas.ParseLimitsSchema>
export type ParseLimitsPatch = Infer<typeof Schemas.ParseLimitsPatchSchema>

export type DiscoverQuery = Infer<typeof Schemas.DiscoverQuerySchema>
export type DiscoverRequest = Infer<typeof Schemas.DiscoverRequestSchema>
export type LargestRecord = Infer<typeof Schemas.LargestRecordSchema>
export type PreviewSnippet = Infer<typeof Schemas.PreviewSnippetSchema>
export type SessionPreview = Infer<typeof Schemas.SessionPreviewSchema>
export type PluginSource = Infer<typeof Schemas.PluginSourceSchema>
export type PluginSourceNotice = Infer<typeof Schemas.PluginSourceNoticeSchema>
export type PluginSourceSnapshot = Infer<typeof Schemas.PluginSourceSnapshotSchema>
export type CompiledContext = Infer<typeof Schemas.CompiledContextSchema>
export type TokenBudget = Infer<typeof Schemas.TokenBudgetSchema>
export type EvidenceItem = Infer<typeof Schemas.EvidenceItemSchema>
export type EvidenceBundle = Infer<typeof Schemas.EvidenceBundleSchema>
export type AnalysisClaimsV1 = Infer<typeof Schemas.AnalysisClaimsV1Schema>
export type AnalysisClaimsV2 = Infer<typeof Schemas.AnalysisClaimsV2Schema>
type ClaimRecencyOptional = Partial<Pick<Infer<typeof Schemas.AnalysisClaimSchema>, 'scope' | 'order' | 'timestamp'>>
type CompatClaim<T> = T & ClaimRecencyOptional
type CompatClaimsBase = Omit<AnalysisClaimsV1, 'schemaVersion' | 'objective' | 'completed' | 'inProgress' | 'blocked' | 'decisions' | 'failedAttempts' | 'currentProblems' | 'relevantFiles' | 'commandsRun' | 'testsPassed' | 'testsFailed' | 'constraints' | 'openQuestions' | 'nextActions'>
/**
 * Producer-facing shape during the v1→v2 migration. Runtime schemas remain
 * strict; this type only lets existing readers observe optional recency fields
 * while v1 writers and v2 readers are migrated independently.
 */
export type AnalysisClaims = CompatClaimsBase & {
  readonly schemaVersion: 1 | 2
  readonly objective?: CompatClaim<NonNullable<AnalysisClaimsV1['objective']>> | undefined
  readonly completed: CompatClaim<AnalysisClaimsV1['completed'][number]>[]
  readonly inProgress: CompatClaim<AnalysisClaimsV1['inProgress'][number]>[]
  readonly blocked: CompatClaim<AnalysisClaimsV1['blocked'][number]>[]
  readonly decisions: CompatClaim<AnalysisClaimsV1['decisions'][number]>[]
  readonly failedAttempts: CompatClaim<AnalysisClaimsV1['failedAttempts'][number]>[]
  readonly currentProblems: CompatClaim<AnalysisClaimsV1['currentProblems'][number]>[]
  readonly relevantFiles: CompatClaim<AnalysisClaimsV1['relevantFiles'][number]>[]
  readonly commandsRun: CompatClaim<AnalysisClaimsV1['commandsRun'][number]>[]
  readonly testsPassed: CompatClaim<AnalysisClaimsV1['testsPassed'][number]>[]
  readonly testsFailed: CompatClaim<AnalysisClaimsV1['testsFailed'][number]>[]
  readonly constraints: CompatClaim<AnalysisClaimsV1['constraints'][number]>[]
  readonly openQuestions: CompatClaim<AnalysisClaimsV1['openQuestions'][number]>[]
  readonly nextActions: CompatClaim<AnalysisClaimsV1['nextActions'][number]>[]
  /** Optional overlap marker keeps legacy evidence boundary casts explicit. */
  readonly items?: readonly unknown[]
}
export type AnalysisClaimsRead = AnalysisClaimsV1 | AnalysisClaimsV2
export type SmartPreview = Infer<typeof Schemas.SmartPreviewSchema>
export type PreparedImport = Infer<typeof Schemas.PreparedImportSchema>
export type CompatibilityView = Infer<typeof Schemas.CompatibilityViewSchema>
export type PreviewRequest = Infer<typeof Schemas.PreviewRequestSchema>
export type AnalyzeRequest = Infer<typeof Schemas.AnalyzeRequestSchema>
export type Consent = Infer<typeof Schemas.ConsentSchema>
export type SmartModelConsent = Infer<typeof Schemas.SmartModelConsentSchema>
export type DeterministicSmartConsent = Infer<typeof Schemas.DeterministicSmartConsentSchema>
export type FullConsent = Infer<typeof Schemas.FullConsentSchema>
export type DisclosureVersion = Infer<typeof Schemas.DisclosureVersionSchema>
export type ModelSmartCreateRequest = Infer<typeof Schemas.ModelSmartCreateRequestSchema>
export type DeterministicSmartCreateRequest = Infer<typeof Schemas.DeterministicSmartCreateRequestSchema>
export type FullCreateRequest = Infer<typeof Schemas.FullCreateRequestSchema>
export type SmartCreateRequest = Infer<typeof Schemas.SmartCreateRequestSchema>
export type CreateRequest = Infer<typeof Schemas.CreateRequestSchema>
export type CreateOutcome = Infer<typeof Schemas.CreateOutcomeSchema>
export type RemoteError = Infer<typeof Schemas.RemoteErrorSchema>
