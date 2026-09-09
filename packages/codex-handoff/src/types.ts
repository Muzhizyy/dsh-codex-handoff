/**
 * Public, browser-safe DTO vocabulary for the generated Host Remote.
 *
 * This contributor is copied into the pinned DSH workspace solely for the
 * official Typert FaceModel pass. The running implementation remains the
 * root Host composition; keeping these declarations public makes the
 * generated ./remote contract independent of Host-only imports.
 */

export type IsoDateTime = string
export type Severity = 'info' | 'warning' | 'error'
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue }

export interface Diagnostic {
  readonly code: string
  readonly severity: Severity
  readonly message: string
  readonly recoverable: boolean
}

export interface ExternalSessionRef {
  readonly discoveryId: string
  readonly source: 'codex'
  readonly sessionId: string
  readonly rolloutRevisionId: string
  readonly expectedFingerprint?: string
  readonly archived?: boolean
}

export interface ExternalSessionSummary extends ExternalSessionRef {
  readonly fingerprint: string
  readonly title?: string
  readonly cwd?: string
  readonly startedAt?: IsoDateTime
  readonly updatedAt: IsoDateTime
  readonly archived: boolean
  readonly messageCount: number
  readonly toolCallCount: number
  readonly byteSize: number
  readonly parseHealth: 'complete' | 'partial' | 'corrupt' | 'unsupported'
}

export interface SessionPage {
  readonly items: readonly ExternalSessionSummary[]
  readonly nextCursor?: string
  readonly scannedAt: IsoDateTime
}

export interface DiscoverRequest {
  readonly cursor?: string
  readonly search?: string
  readonly archived: 'active' | 'archived' | 'all'
  readonly limit: number
  readonly includeMessageIndex: boolean
}

export interface ParseLimits {
  readonly discoverPageResults: number
  readonly filesScanned: number
  readonly lineBytes: number
  readonly sourceFileBytes: number
  readonly chainDecompressedBytes: number
  readonly chainDepth: number
  readonly chainFiles: number
  readonly records: number
  readonly normalizedTextBytes: number
  readonly normalizedToolResultBytes: number
  readonly previewSnippetBytes: number
}

export interface PreviewRequest {
  readonly source: ExternalSessionRef
  readonly limits?: ParseLimits
}

export interface SourceRef {
  readonly locator: string
  readonly line?: number
  readonly ordinal?: number
  readonly type?: string
}

export interface LargestRecord {
  readonly kind: 'message' | 'tool-result' | 'reasoning' | 'other'
  readonly bytes: number
  readonly source: SourceRef
}

export interface PreviewSnippet {
  readonly source: SourceRef
  readonly role: 'user' | 'assistant' | 'system' | 'tool'
  readonly text: string
  readonly redacted: boolean
}

export interface RepositoryState {
  readonly observedAt: IsoDateTime
  readonly cwd: { readonly requested: string; readonly canonical: string; readonly exists: boolean; readonly writable?: boolean }
  readonly git?: JsonValue
  readonly relevantPaths: readonly JsonValue[]
  readonly diagnostics: readonly Diagnostic[]
}

export interface SessionPreview {
  readonly source: ExternalSessionSummary
  readonly estimatedTokens: number
  readonly estimator: 'dsh' | 'fallback'
  readonly largestRecords: readonly LargestRecord[]
  readonly snippets: readonly PreviewSnippet[]
  readonly repository?: RepositoryState
  readonly completeness: 'complete' | 'partial' | 'corrupt' | 'unsupported'
  readonly diagnostics: readonly Diagnostic[]
}

export interface AnalyzeRequest {
  readonly source: ExternalSessionRef
  readonly cwd: string
  readonly expectedFingerprint: string
  readonly targetTokens?: number
  readonly useModel: boolean
  readonly consent: {
    readonly disclosureVersion: 'smart-v1'
    readonly accepted: true
    readonly acceptedMode: 'smart'
    readonly modelAnalysis: boolean
    readonly fullPersistence: false
  }
}

export interface SmartPreview {
  readonly source: ExternalSessionRef
  readonly manifest: JsonValue
  readonly context: JsonValue
  readonly degraded: boolean
  readonly diagnostics: readonly Diagnostic[]
}

export interface SmartModelCreateRequest {
  readonly source: ExternalSessionRef
  readonly cwd: string
  readonly expectedFingerprint: string
  readonly mode: 'smart'
  readonly consent: {
    readonly disclosureVersion: 'smart-v1'
    readonly accepted: true
    readonly acceptedMode: 'smart'
    readonly modelAnalysis: true
    readonly fullPersistence: false
  }
  readonly smart: { readonly useModel: true; readonly targetTokens?: number }
}

export interface DeterministicSmartCreateRequest {
  readonly source: ExternalSessionRef
  readonly cwd: string
  readonly expectedFingerprint: string
  readonly mode: 'smart'
  readonly consent: {
    readonly disclosureVersion: 'smart-v1'
    readonly accepted: true
    readonly acceptedMode: 'smart'
    readonly modelAnalysis: false
    readonly fullPersistence: false
  }
  readonly smart: { readonly useModel: false; readonly targetTokens?: number }
}

export interface FullCreateRequest {
  readonly source: ExternalSessionRef
  readonly cwd: string
  readonly expectedFingerprint: string
  readonly mode: 'full'
  readonly consent: {
    readonly disclosureVersion: 'full-v1'
    readonly accepted: true
    readonly acceptedMode: 'full'
    readonly modelAnalysis: false
    readonly fullPersistence: true
  }
  readonly full: { readonly confirmedLarge?: boolean }
}

export type CreateRequest = SmartModelCreateRequest | DeterministicSmartCreateRequest | FullCreateRequest

export interface CreateOutcome {
  readonly state: 'created' | 'existing' | 'created_unattached'
  readonly sessionId: string
  readonly workspaceAttached: boolean
  readonly warnings: readonly Diagnostic[]
}

export interface CompatibilityView {
  readonly compatible: boolean
  readonly dshVersion?: string
  readonly observedSessionFormat?: number
  readonly required: {
    readonly agents: boolean
    readonly agentFactory: boolean
    readonly agentDefaultModel: boolean
    readonly sessionQuery: boolean
    readonly sessionPersistence: boolean
    readonly workspaceRegistry: boolean
    readonly storageDomain: boolean
    readonly typert: boolean
    readonly slots: boolean
    readonly remote: boolean
    readonly sessions: boolean
    readonly locale: boolean
    readonly react: boolean
  }
  readonly optional: {
    readonly llm: boolean
    readonly agentPresets: boolean
    readonly conversationSessionHeaderActions: boolean
    readonly settingsSection: boolean
  }
  readonly diagnostics: readonly Diagnostic[]
  readonly checkedAt: IsoDateTime
}
