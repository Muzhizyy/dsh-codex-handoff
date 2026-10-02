import {
  AnalyzeRequestSchema,
  CompatibilityViewSchema,
  CreateOutcomeSchema,
  CreateRequestSchema,
  DiscoverRequestSchema,
  PreviewRequestSchema,
  SessionPageSchema,
  SessionPreviewSchema,
  SmartPreviewSchema,
  SMART_DISCLOSURE_VERSION,
} from './schemas.js'
export {
  FULL_DISCLOSURE_VERSION,
  SMART_DISCLOSURE_VERSION,
} from './schemas.js'
import type {
  AnalyzeRequest,
  CompatibilityView,
  CreateOutcome,
  CreateRequest,
  DiscoverRequest,
  SessionPage,
  SessionPreview,
  SmartPreview,
} from './types.js'

/** Runtime validators used by both generated Remote adapters and tests. */
export const CodexHandoffRemoteSchemas = Object.freeze({
  compatibility: Object.freeze({ response: CompatibilityViewSchema }),
  discover: Object.freeze({ request: DiscoverRequestSchema, response: SessionPageSchema }),
  preview: Object.freeze({ request: PreviewRequestSchema, response: SessionPreviewSchema }),
  analyze: Object.freeze({ request: AnalyzeRequestSchema, response: SmartPreviewSchema }),
  create: Object.freeze({ request: CreateRequestSchema, response: CreateOutcomeSchema }),
})

export type CodexHandoffRemoteMethod = keyof typeof CodexHandoffRemoteSchemas

export interface CodexHandoffRemoteContract {
  compatibility: { response: CompatibilityView }
  discover: { request: DiscoverRequest; response: SessionPage }
  preview: { request: import('./types.js').PreviewRequest; response: SessionPreview }
  analyze: { request: AnalyzeRequest; response: SmartPreview }
  create: { request: CreateRequest; response: CreateOutcome }
}

export const REMOTE_NAMESPACE = 'codexHandoff' as const
/** Current disclosure version for the default Smart/model flow. */
export const DISCLOSURE_VERSION = SMART_DISCLOSURE_VERSION
