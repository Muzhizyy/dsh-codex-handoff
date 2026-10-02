import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AnalyzeRequest,
  CompatibilityView,
  CreateOutcome,
  CreateRequest,
  DiscoverRequest,
  PreviewRequest,
  SessionPage,
  SessionPreview,
  SmartPreview,
  ReturnPreviewRequest,
  ReturnPreviewResponse,
  ReturnSyncRequest,
  ReturnSyncResponse,
} from './types.ts'

export type * from './types.ts'

export interface CodexHandoffImplementation {
  compatibility(): Promise<CompatibilityView>
  discover(request: DiscoverRequest, signal: AbortSignal): Promise<SessionPage>
  preview(request: PreviewRequest, signal: AbortSignal): Promise<SessionPreview>
  analyze(request: AnalyzeRequest, signal: AbortSignal): Promise<SmartPreview>
  create(request: CreateRequest, signal: AbortSignal): Promise<CreateOutcome>
  returnPreview(request: ReturnPreviewRequest, signal: AbortSignal): Promise<ReturnPreviewResponse>
  returnSync(request: ReturnSyncRequest, signal: AbortSignal): Promise<ReturnSyncResponse>
}

/** Official DSH Typert contributor used by the pinned workspace generator. */
export class CodexHandoffRemote extends TypertRemoteService {
  static inject = ['codexHandoffImplementation', 'typert']

  private get implementation(): CodexHandoffImplementation {
    return this.ctx.get('codexHandoffImplementation') as CodexHandoffImplementation
  }

  constructor(ctx: Context) {
    super(ctx, 'codexHandoff')
  }

  @Remote('compatibility')
  compatibility(): Promise<CompatibilityView> {
    return this.implementation.compatibility()
  }

  @Remote('discover')
  discover(request: DiscoverRequest, signal: AbortSignal): Promise<SessionPage> {
    return this.implementation.discover(request, signal)
  }

  @Remote('preview')
  preview(request: PreviewRequest, signal: AbortSignal): Promise<SessionPreview> {
    return this.implementation.preview(request, signal)
  }

  @Remote('analyze')
  analyze(request: AnalyzeRequest, signal: AbortSignal): Promise<SmartPreview> {
    return this.implementation.analyze(request, signal)
  }

  @Remote('create')
  create(request: CreateRequest, signal: AbortSignal): Promise<CreateOutcome> {
    return this.implementation.create(request, signal)
  }

  @Remote('returnPreview')
  returnPreview(request: ReturnPreviewRequest, signal: AbortSignal): Promise<ReturnPreviewResponse> {
    return this.implementation.returnPreview(request, signal)
  }

  @Remote('returnSync')
  returnSync(request: ReturnSyncRequest, signal: AbortSignal): Promise<ReturnSyncResponse> {
    return this.implementation.returnSync(request, signal)
  }
}

export default CodexHandoffRemote
