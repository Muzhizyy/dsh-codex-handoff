import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { en, NS, zh, type LocaleKey } from './locales.js'
import { safeText } from './model.js'
import { ReturnClientModel, type ReturnClientState } from './return-model.js'
import type { ClientLocale, LocaleSeat, LocaleSeatObject } from './types.js'

const RETURN_KEYS = [
  'returnAction', 'returnTitle', 'returnProject', 'returnExplanation', 'returnPreparing', 'returnSync', 'returnSyncing',
  'returnClose', 'returnContextDetails', 'returnWarnings', 'returnRefresh', 'returnPreviewExpired', 'returnStale',
  'returnSourceMissing', 'returnNotSupported', 'returnTooLarge', 'returnStorageFailed', 'returnPrepareFailed', 'returnSyncFailed',
  'returnUnknown', 'returnUnknownGuidance', 'returnCreated', 'returnExisting', 'returnCopyCommand', 'returnCopied',
  'returnCopyFailed', 'returnSelectCommand', 'returnTechnicalDetails', 'returnPreparedContext', 'returnSourceThread',
  'returnDshSession', 'returnCursor', 'returnRevision', 'returnWorkspace', 'returnWorkspaceIdentity', 'returnGitFingerprint',
  'returnCodexRevision', 'returnCodexFingerprint', 'returnReceipt', 'returnExpires', 'returnBytes', 'returnHash', 'returnForkId',
] as const satisfies readonly LocaleKey[]

type ReturnKey = typeof RETURN_KEYS[number]
type ReturnDictionary = Readonly<Record<ReturnKey, string>>

function useReturnDictionary(seat: LocaleSeat | ClientLocale | undefined): ReturnDictionary {
  const [, redraw] = useState(0)
  const seatObject = typeof seat === 'function' ? undefined : seat
  const locale = seatObject !== undefined && 'bind' in seatObject ? seatObject as ClientLocale : undefined
  const legacy = locale === undefined && seatObject !== undefined ? seatObject as LocaleSeatObject : undefined
  useEffect(() => seatObject?.subscribe?.(() => redraw(value => value + 1)), [seatObject])
  const active = locale?.getSnapshot?.()?.active ?? legacy?.getLanguage?.() ?? legacy?.language
  const fallback = active === 'zh' ? zh : en
  const translate = typeof seat === 'function' ? seat : locale?.bind?.(NS) ?? legacy?.t
  return Object.fromEntries(RETURN_KEYS.map(key => [key, safeText(translate?.(key) ?? fallback[key])])) as ReturnDictionary
}

function projectName(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
  return safeText(parts.at(-1) ?? cwd)
}

function messageFor(dictionary: ReturnDictionary, state: ReturnClientState): string {
  switch (state.error?.code) {
    case 'RETURN_PREVIEW_EXPIRED': return dictionary.returnPreviewExpired
    case 'RETURN_STALE': return dictionary.returnStale
    case 'RETURN_SOURCE_METADATA_MISSING': return dictionary.returnSourceMissing
    case 'RETURN_NOT_SUPPORTED': return dictionary.returnNotSupported
    case 'RETURN_PAYLOAD_TOO_LARGE': return dictionary.returnTooLarge
    case 'RETURN_STORAGE_FAILED': return dictionary.returnStorageFailed
    default: return state.phase === 'previewing' ? dictionary.returnPrepareFailed : dictionary.returnSyncFailed
  }
}

const RETURN_CSS = `
.dsh-codex-return-action{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:34px;padding:0 11px;border:1px solid var(--dsw-alias-border-secondary,rgba(30,40,60,.12));border-radius:10px;color:var(--dsw-alias-label-primary,#17191f);background:var(--dsw-alias-surface-primary,#fff);font:inherit;font-size:13px;line-height:20px;cursor:pointer;transition:background 140ms ease,border-color 140ms ease}
.dsh-codex-return-action:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.dsh-codex-return-action:disabled{opacity:.55;cursor:default}
.dsh-codex-return-action:focus-visible,.dsh-codex-return-dialog :focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:2px}
.dsh-codex-return-backdrop{position:fixed;z-index:10000;inset:0;display:grid;place-items:center;padding:24px;background:rgba(14,18,28,.38);animation:dsh-codex-return-fade 120ms ease-out}
.dsh-codex-return-dialog{display:flex;flex-direction:column;width:min(520px,100%);max-height:min(760px,calc(100dvh - 48px));overflow:hidden;border:1px solid var(--dsw-alias-border-secondary,rgba(30,40,60,.12));border-radius:18px;background:var(--dsw-alias-surface-primary,#fff);color:var(--dsw-alias-label-primary,#17191f);box-shadow:0 24px 80px rgba(10,16,30,.24)}
.dsh-codex-return-header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:20px 22px 12px}
.dsh-codex-return-header h2{margin:0;font-size:18px;font-weight:650;line-height:26px;letter-spacing:-.02em}
.dsh-codex-return-close{flex:none;width:32px;height:32px;border:0;border-radius:50%;color:inherit;background:transparent;font-size:21px;line-height:1;cursor:pointer}
.dsh-codex-return-body{min-height:0;overflow:auto;padding:0 22px 12px}
.dsh-codex-return-project{margin:0 0 8px;font-size:14px;font-weight:600}
.dsh-codex-return-explanation,.dsh-codex-return-summary{margin:0 0 12px;color:var(--dsw-alias-label-secondary,#646a76);font-size:13px;line-height:20px}
.dsh-codex-return-warnings{margin:12px 0;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-state-warning-tertiary,#fff6e5);color:var(--dsw-alias-state-warning-primary,#79500a);font-size:12px;line-height:18px}
.dsh-codex-return-warnings ul{margin:0;padding-left:18px}
.dsh-codex-return-details{margin:12px 0;color:var(--dsw-alias-label-secondary,#646a76);font-size:12px}
.dsh-codex-return-details summary{width:fit-content;cursor:pointer}
.dsh-codex-return-details pre{max-height:260px;overflow:auto;margin:10px 0;padding:12px;border:1px solid var(--dsw-alias-border-secondary,rgba(30,40,60,.12));border-radius:10px;color:var(--dsw-alias-label-primary,#17191f);background:var(--dsw-alias-surface-secondary,#f7f8fa);font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text}
.dsh-codex-return-details dl{display:grid;grid-template-columns:minmax(100px,auto) 1fr;gap:5px 12px;overflow-wrap:anywhere}
.dsh-codex-return-details dt{color:var(--dsw-alias-label-secondary,#646a76)}
.dsh-codex-return-details dd{margin:0;color:var(--dsw-alias-label-primary,#17191f);user-select:text}
.dsh-codex-return-command{box-sizing:border-box;width:100%;margin:8px 0;padding:8px;border:1px solid var(--dsw-alias-border-secondary,rgba(30,40,60,.12));border-radius:8px;color:inherit;background:transparent;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;user-select:text}
.dsh-codex-return-alert{margin:12px 0;color:var(--dsw-alias-state-danger-primary,#b42318);font-size:13px;line-height:20px}
.dsh-codex-return-status{margin:12px 0;color:var(--dsw-alias-state-success-primary,#28734f);font-size:13px;line-height:20px}
.dsh-codex-return-footer{display:flex;justify-content:flex-end;gap:8px;padding:12px 22px 20px;border-top:1px solid var(--dsw-alias-border-secondary,rgba(30,40,60,.08))}
.dsh-codex-return-primary{min-height:38px;padding:0 15px;border:0;border-radius:11px;color:#fff;background:var(--dsw-alias-state-business-primary,#4176e6);font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.dsh-codex-return-primary:disabled{opacity:.55;cursor:default}
.dsh-codex-return-visually-hidden{position:absolute!important;width:1px!important;height:1px!important;overflow:hidden!important;clip:rect(0 0 0 0)!important;white-space:nowrap!important}
@keyframes dsh-codex-return-fade{from{opacity:0}to{opacity:1}}
@media(max-width:560px){.dsh-codex-return-backdrop{align-items:end;padding:0}.dsh-codex-return-dialog{width:100%;max-height:92dvh;border-radius:18px 18px 0 0}.dsh-codex-return-header{padding:18px 18px 10px}.dsh-codex-return-body{padding:0 18px 12px}.dsh-codex-return-footer{padding:12px 18px max(18px,env(safe-area-inset-bottom))}.dsh-codex-return-primary{width:100%;min-height:44px}}
@media(prefers-reduced-motion:reduce){.dsh-codex-return-backdrop{animation:none}.dsh-codex-return-action{transition:none}}
@media(forced-colors:active){.dsh-codex-return-dialog{border:1px solid CanvasText}.dsh-codex-return-primary{border:1px solid ButtonText;color:ButtonText;background:ButtonFace}}
`

export interface ReturnHeaderInjected {
  readonly model: ReturnClientModel
  readonly locale?: LocaleSeat | ClientLocale
}

export interface ReturnHeaderProps extends ReturnHeaderInjected {
  /** Injected by DSH's session-scoped conversation header slot. */
  readonly sessionId: string
}

/** Single conversation-header action plus its current-session return preview. */
export function ReturnHeaderAction({ model, sessionId, locale }: ReturnHeaderProps): ReactElement {
  const dictionary = useReturnDictionary(locale)
  const [state, setState] = useState<ReturnClientState>(() => model.getState())
  const triggerRef = useRef<HTMLButtonElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const wasOpen = useRef(false)

  useEffect(() => model.subscribe(setState), [model])
  const activeSession = String(sessionId)
  const open = state.phase !== 'closed' && state.dshSessionId === activeSession
  const busy = state.phase === 'previewing' || state.phase === 'syncing'

  useEffect(() => {
    if (!open && wasOpen.current && state.phase === 'closed') {
      const target = previousFocus.current?.isConnected ? previousFocus.current : triggerRef.current
      target?.focus()
    }
    wasOpen.current = open
  }, [open, state.phase])

  return (
    <>
      <style data-dsh-codex-return-style="true">{RETURN_CSS}</style>
      <button
        ref={triggerRef}
        className="dsh-codex-return-action"
        type="button"
        aria-label={dictionary.returnAction}
        disabled={busy || open}
        onClick={() => {
          previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : triggerRef.current
          void model.open(activeSession)
        }}
      >
        <span aria-hidden="true">↩</span>{dictionary.returnAction}
      </button>
      {open ? <ReturnDialog model={model} state={state} dictionary={dictionary} /> : null}
    </>
  )
}

function ReturnDialog({ model, state, dictionary }: {
  readonly model: ReturnClientModel
  readonly state: ReturnClientState
  readonly dictionary: ReturnDictionary
}): ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const preview = state.preview
  const syncing = state.phase === 'syncing'
  const close = () => { if (!syncing) model.close() }

  useEffect(() => {
    const timer = window.setTimeout(() => titleRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key !== 'Tab' || dialogRef.current === null) return
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]),summary,[tabindex="0"],input:not([disabled])'))
      .filter(item => !item.closest('details:not([open]) > :not(summary)'))
    const first = focusable[0]
    const last = focusable.at(-1)
    if (first === undefined || last === undefined) return
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }

  const warnings = preview?.warnings ?? []
  const outcome = state.outcome
  const project = preview === undefined ? '' : projectName(preview.workspace.canonicalCwd)

  return (
    <div className="dsh-codex-return-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close() }}>
      <div
        ref={dialogRef}
        className="dsh-codex-return-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dsh-codex-return-title"
        aria-busy={syncing || state.phase === 'previewing'}
        onKeyDown={onKeyDown}
      >
        <header className="dsh-codex-return-header">
          <h2 ref={titleRef} id="dsh-codex-return-title" tabIndex={-1}>{dictionary.returnTitle}</h2>
          <button type="button" className="dsh-codex-return-close" aria-label={dictionary.returnClose} disabled={syncing} onClick={close}>
            <span aria-hidden="true">×</span><span className="dsh-codex-return-visually-hidden">{dictionary.returnClose}</span>
          </button>
        </header>
        <div className="dsh-codex-return-body">
          {state.phase === 'previewing' ? <p className="dsh-codex-return-summary" role="status" aria-live="polite">{dictionary.returnPreparing}</p> : null}

          {preview !== undefined && state.phase !== 'unknown' ? (
            <>
              <p className="dsh-codex-return-project"><span className="dsh-codex-return-visually-hidden">{dictionary.returnProject}: </span>{project}</p>
              <p className="dsh-codex-return-explanation">{dictionary.returnExplanation}</p>
            </>
          ) : null}

          {warnings.length > 0 ? (
            <aside className="dsh-codex-return-warnings" aria-label={dictionary.returnWarnings}>
              <ul>{warnings.map((warning, index) => <li key={`${index}-${warning}`}>{safeText(warning)}</li>)}</ul>
            </aside>
          ) : null}

          {state.phase === 'syncing' ? <p className="dsh-codex-return-summary" role="status" aria-live="polite">{dictionary.returnSyncing}</p> : null}
          {state.phase === 'error' ? <p className="dsh-codex-return-alert" role="alert">{messageFor(dictionary, state)}</p> : null}
          {state.phase === 'unknown' ? <p className="dsh-codex-return-alert" role="alert">{dictionary.returnUnknown} {dictionary.returnUnknownGuidance}</p> : null}

          {state.phase === 'success' && outcome?.status !== 'unknown' ? (
            <>
              <p className="dsh-codex-return-status" role="status">{outcome?.status === 'existing' ? dictionary.returnExisting : dictionary.returnCreated}</p>
              <details className="dsh-codex-return-details" open={state.copyFailed}>
                <summary>{dictionary.returnTechnicalDetails}</summary>
                <dl>
                  <dt>{dictionary.returnForkId}</dt><dd>{outcome?.codexForkId}</dd>
                  <dt>{dictionary.returnSourceThread}</dt><dd>{outcome?.sourceThreadId}</dd>
                  <dt>{dictionary.returnReceipt}</dt><dd>{outcome?.receiptId}</dd>
                </dl>
                <label htmlFor="dsh-codex-return-command">{dictionary.returnSelectCommand}</label>
                <input id="dsh-codex-return-command" className="dsh-codex-return-command" readOnly value={outcome?.resume.displayCommand ?? ''} onFocus={event => event.currentTarget.select()} />
              </details>
              {state.copyFailed ? <p className="dsh-codex-return-alert" role="alert">{dictionary.returnCopyFailed}</p> : null}
              {state.copied ? <p className="dsh-codex-return-status" role="status" aria-live="polite">{dictionary.returnCopied}</p> : null}
            </>
          ) : null}

          {state.phase === 'unknown' && outcome?.status === 'unknown' ? (
            <details className="dsh-codex-return-details">
              <summary>{dictionary.returnTechnicalDetails}</summary>
              <dl>
                <dt>{dictionary.returnSourceThread}</dt><dd>{outcome.sourceThreadId}</dd>
                {outcome.codexForkId !== undefined ? <><dt>{dictionary.returnForkId}</dt><dd>{outcome.codexForkId}</dd></> : null}
                <dt>{dictionary.returnReceipt}</dt><dd>{outcome.receiptId}</dd>
              </dl>
            </details>
          ) : null}

          {preview !== undefined && state.phase !== 'previewing' ? (
            <details className="dsh-codex-return-details" open={state.copyFailed}>
              <summary>{dictionary.returnContextDetails}</summary>
              <h3>{dictionary.returnPreparedContext}</h3>
              <pre>{safeText(preview.context)}</pre>
              <h3>{dictionary.returnWorkspace}</h3>
              <pre>{safeText(preview.workspace.summary)}</pre>
              <h3>{dictionary.returnTechnicalDetails}</h3>
              <dl>
                <dt>{dictionary.returnReceipt}</dt><dd>{preview.receiptId}</dd>
                <dt>{dictionary.returnExpires}</dt><dd>{preview.expiresAt}</dd>
                <dt>{dictionary.returnBytes}</dt><dd>{preview.contextBytes}</dd>
                <dt>{dictionary.returnHash}</dt><dd>{preview.contextSha256}</dd>
                <dt>{dictionary.returnCursor}</dt><dd>{preview.scope.dshCursor}</dd>
                {preview.scope.dshRevision !== undefined ? <><dt>{dictionary.returnRevision}</dt><dd>{preview.scope.dshRevision}</dd></> : null}
                <dt>{dictionary.returnSourceThread}</dt><dd>{preview.source.codexThreadId}</dd>
                <dt>{dictionary.returnDshSession}</dt><dd>{preview.source.dshSessionId}</dd>
                <dt>{dictionary.returnCodexRevision}</dt><dd>{preview.source.codexRolloutRevisionId}</dd>
                <dt>{dictionary.returnCodexFingerprint}</dt><dd>{preview.source.codexFingerprint}</dd>
                <dt>{dictionary.returnWorkspace}</dt><dd>{preview.workspace.canonicalCwd}</dd>
                <dt>{dictionary.returnWorkspaceIdentity}</dt><dd>{preview.workspace.workspaceIdentity}</dd>
                <dt>{dictionary.returnGitFingerprint}</dt><dd>{preview.workspace.gitFingerprint}</dd>
              </dl>
            </details>
          ) : null}
        </div>
        {state.phase === 'success' || state.phase === 'ready' || state.phase === 'error' && state.error?.canRefresh ? (
          <footer className="dsh-codex-return-footer">
            {state.phase === 'success' && outcome?.status !== 'unknown' ? (
              <button className="dsh-codex-return-primary" type="button" onClick={() => {
                void model.copyResumeCommand(value => navigator.clipboard.writeText(value))
              }}>{dictionary.returnCopyCommand}</button>
            ) : null}
            {state.phase === 'ready' ? <button className="dsh-codex-return-primary" type="button" onClick={() => { void model.sync() }}>{dictionary.returnSync}</button> : null}
            {state.phase === 'error' && state.error?.canRefresh ? <button className="dsh-codex-return-primary" type="button" onClick={() => { void model.refreshPreview() }}>{dictionary.returnRefresh}</button> : null}
          </footer>
        ) : null}
      </div>
    </div>
  )
}
