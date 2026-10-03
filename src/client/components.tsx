import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { en, localeKeys, NS, zh, type LocaleKey } from './locales.js'
import { safeText, type HandoffClientModel, type HandoffClientState } from './model.js'
import { BUDGET_LIMITS } from '../shared/limits.js'
import type { ExternalSessionSummary, SmartPreview } from '../shared/types.js'
import type { ClientLocale, LocaleSeat, LocaleSeatObject } from './types.js'

export interface HandoffActionProps {
  readonly model: HandoffClientModel
  readonly labelKey: LocaleKey
  readonly wide: boolean
  readonly onActivate: () => void | Promise<void>
  readonly locale?: LocaleSeat | ClientLocale
}

export interface HandoffOverlayProps {
  readonly model: HandoffClientModel
  readonly titleKey: LocaleKey
  readonly onKey: (key: string) => void
  readonly locale?: LocaleSeat | ClientLocale
  /** Local test seam; production uses the reactive locale seat. */
  readonly language?: 'en' | 'zh'
}

type Dictionary = Readonly<Record<LocaleKey, string>>

function copy(language: 'en' | 'zh' | undefined): Dictionary {
  return language === 'zh' ? zh : en
}

function useDictionary(seat: LocaleSeat | ClientLocale | undefined, language?: 'en' | 'zh'): Dictionary {
  const [, redraw] = useState(0)
  const seatObject = typeof seat === 'function' ? undefined : seat
  const locale = seatObject !== undefined && 'bind' in seatObject ? seatObject as ClientLocale : undefined
  const legacy = locale === undefined && seatObject !== undefined ? seatObject as LocaleSeatObject : undefined
  useEffect(() => seatObject?.subscribe?.(() => redraw(value => value + 1)), [seatObject])
  const active = locale?.getSnapshot?.()?.active ?? legacy?.getLanguage?.() ?? legacy?.language
  const fallback = copy(active === 'zh' || active === 'en' ? active : language)
  const translateFromSeat: ((key: string) => string | undefined) | undefined = typeof seat === 'function'
    ? (seat as (key: string) => string | undefined)
    : undefined
  const translate = translateFromSeat ?? locale?.bind?.(NS) ?? legacy?.t
  if (translate === undefined) return fallback
  return Object.fromEntries(localeKeys.map(key => [key, safeText(translate(key) ?? fallback[key])])) as Dictionary
}

function text(dictionary: Dictionary, key: LocaleKey): string {
  return dictionary[key]
}

function errorText(dictionary: Dictionary, code: string | undefined, unlimitedTokens = false): string {
  switch (code) {
    case 'CODEX_HOME_NOT_FOUND': return dictionary.noInstallation
    case 'CODEX_ACCESS_DENIED': return dictionary.permission
    case 'CODEX_PARTIAL_PARSE': return dictionary.partialIndex
    case 'DSH_INCOMPATIBLE': return dictionary.incompatible
    case 'CWD_REQUIRED': return dictionary.cwdRequired
    case 'CWD_NOT_FOUND': return dictionary.cwdNotFound
    case 'TRAJECTORY_TOO_LARGE': return dictionary.trajectoryTooLarge
    case 'SMART_CONTEXT_CANNOT_FIT': return unlimitedTokens ? dictionary.smartUnlimitedCannotFit : dictionary.smartContextCannotFit
    case 'SOURCE_STALE':
    case 'SOURCE_CHANGED': return dictionary.sourceChanged
    case 'IMPORT_ID_CONFLICT': return dictionary.importConflict
    case 'DSH_SEED_INVALID':
    case 'WORKSPACE_ATTACH_FAILED': return dictionary.createFailed
    case 'TRAJECTORY_CONFIRMATION_REQUIRED': return dictionary.consentRequired
    case 'SESSION_NOT_VISIBLE': return dictionary.sessionNotVisible
    case 'SMART_ANALYZER_DEGRADED': return dictionary.degraded
    case 'INTERNAL': return dictionary.internalError
    case 'CANCELLED': return dictionary.cancelled
    default: return dictionary.permission
  }
}

function errorDetail(code: string | undefined, message: string | undefined): string {
  if (message === undefined || message === '') return ''
  // These cases have complete localized guidance. Avoid appending the Host's
  // intentionally generic English boundary message to a localized UI.
  if (code === 'INTERNAL'
    || code === 'SMART_ANALYZER_DEGRADED'
    || code === 'SMART_CONTEXT_CANNOT_FIT'
    || code === 'SOURCE_STALE'
    || code === 'SOURCE_CHANGED'
    || code === 'IMPORT_ID_CONFLICT'
    || code === 'TRAJECTORY_CONFIRMATION_REQUIRED'
    || code === 'SESSION_NOT_VISIBLE') return ''
  return `: ${safeText(message)}`
}

function sessionLabel(summary: ExternalSessionSummary): string {
  return safeText(summary.title || summary.sessionId)
}

function compactSessionLabel(summary: ExternalSessionSummary): string {
  const label = sessionLabel(summary).replace(/\s+/g, ' ').trim()
  return label.length <= 88 ? label : `${label.slice(0, 87).trimEnd()}…`
}

function compactUpdated(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return safeText(value)
  return new Intl.DateTimeFormat(undefined, {
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed)
}

function repoBasename(cwd: string | undefined, unknown: string): string {
  if (cwd === undefined || cwd.trim() === '') return unknown
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
  return safeText(parts.at(-1) ?? unknown)
}

function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const ACTION_CSS = `
.dsh-codex-handoff-action {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  width: calc(100% + 4px);
  height: 42px;
  min-width: 0;
  margin: 4px -2px;
  padding: 0 10px 0 8px;
  overflow: hidden;
  color: var(--dsw-alias-label-primary, #0f1115);
  background: transparent;
  border: 0;
  border-radius: 12px;
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  text-align: left;
  cursor: pointer;
  transition: background 140ms ease, transform 120ms ease;
}
.dsh-codex-handoff-action:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
}
.dsh-codex-handoff-action:active {
  transform: translateY(1px);
}
.dsh-codex-handoff-action > span:first-child {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 8px;
  color: var(--dsw-alias-state-business-primary, #4176e6);
  background: var(--dsw-alias-state-business-tertiary, #e4edfd);
  font-size: 14px;
  font-weight: 600;
}
.dsh-codex-handoff-action > span:last-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-codex-handoff-action[data-wide="false"] {
  flex: none;
  justify-content: center;
  width: 36px;
  height: 36px;
  margin: 8px 0 10px;
  padding: 0;
  border-radius: 50%;
}
.dsh-codex-handoff-action:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, Highlight);
  outline-offset: 2px;
}
@media (prefers-reduced-motion: reduce) {
  .dsh-codex-handoff-action { transition: none; }
}
@media (forced-colors: active) {
  .dsh-codex-handoff-action > span:first-child {
    color: ButtonText;
    background: ButtonFace;
    border: 1px solid ButtonText;
  }
}
`

/** Sidebar footer action. The shell owns `wide`; this component owns only its label and click. */
export function HandoffAction({ model: _model, labelKey, wide, onActivate, locale }: HandoffActionProps): ReactElement {
  const dictionary = useDictionary(locale)
  return (
    <>
      <style data-dsh-codex-handoff-action-style="true">{ACTION_CSS}</style>
      <button
        type="button"
        className="dsh-codex-handoff-action"
        aria-label={text(dictionary, labelKey)}
        data-wide={wide ? 'true' : 'false'}
        onClick={() => { void onActivate() }}
      >
        <span aria-hidden="true">↗</span>
        {wide ? <span>{text(dictionary, labelKey)}</span> : null}
      </button>
    </>
  )
}

function SessionRow({ summary, selected, onSelect, onFocus, tabIndex, resultIndex, dictionary }: {
  readonly summary: ExternalSessionSummary
  readonly selected: boolean
  readonly onSelect: () => void
  readonly onFocus: () => void
  readonly tabIndex: number
  readonly resultIndex: number
  readonly dictionary: Dictionary
}): ReactElement {
  const label = sessionLabel(summary)
  const accessibleLabel = `${label}. ${dictionary.updated}: ${safeText(summary.updatedAt)}. ${dictionary.repo}: ${repoBasename(summary.cwd, dictionary.unknown)}. ${dictionary.messages}: ${summary.messageCount}. ${dictionary.tools}: ${summary.toolCallCount}. ${dictionary.health}: ${safeText(summary.parseHealth)}. ${dictionary.size}: ${bytesLabel(summary.byteSize)}.`
  return (
    <li className="dsh-codex-handoff-session" data-result-index={resultIndex}>
      <button type="button" aria-label={accessibleLabel} aria-pressed={selected} aria-current={selected ? 'true' : undefined} tabIndex={tabIndex} onClick={onSelect} onFocus={onFocus} data-session-id={safeText(summary.sessionId)}>
        <span className="dsh-codex-handoff-session-title" title={label}>{compactSessionLabel(summary)}</span>
        <small className="dsh-codex-handoff-session-meta">
          <span>{repoBasename(summary.cwd, dictionary.unknown)}</span>
          <span>{compactUpdated(summary.updatedAt)}</span>
        </small>
        <span className="dsh-codex-handoff-session-chevron" aria-hidden="true">›</span>
      </button>
    </li>
  )
}

function PrivacyNotice({ dictionary, mode, useModel }: {
  readonly dictionary: Dictionary
  readonly mode: 'smart' | 'full'
  readonly useModel: boolean
}): ReactElement {
  const disclosure = mode === 'full'
    ? <>{dictionary.fullDisclosure} {dictionary.privacyPersistence} {dictionary.privacyRedaction}</>
    : <>{dictionary.smartDisclosure} {useModel ? dictionary.privacyModel : dictionary.privacyNoModel} {dictionary.privacyRedaction}</>
  return (
    <details className="dsh-codex-handoff-privacy" role="note">
      <summary><span aria-hidden="true">i</span>{dictionary.privacySummary}</summary>
      <p>{disclosure}</p>
    </details>
  )
}

function SmartPreviewView({ preview, dictionary }: { readonly preview: SmartPreview; readonly dictionary: Dictionary }): ReactElement {
  const manifest = preview.manifest
  const degradedDiagnostic = preview.diagnostics.find(item => item.code === 'SMART_ANALYZER_DEGRADED')
  const list = (items: readonly { readonly text: string }[]): ReactElement => (
    items.length === 0 ? <p className="dsh-codex-handoff-empty">{dictionary.none}</p> : <ul>{items.slice(0, 8).map((item, index) => <li key={`${index}-${safeText(item.text)}`}>{safeText(item.text)}</li>)}</ul>
  )
  return (
    <section className="dsh-codex-handoff-smart-preview" aria-label={dictionary.smartPreview} data-state={preview.degraded ? 'degraded' : 'ready'}>
      <header>
        <div><span aria-hidden="true">✓</span><h4>{dictionary.smartPreview}</h4></div>
        <p>{dictionary.analyzer}: {safeText(manifest.completeness.analyzer)} · {dictionary.badgeBudget}: {safeText(String(preview.context.estimatedTokens))} · {dictionary.badgeOmissions}: {Object.values(preview.context.omittedByBudget).reduce((sum, count) => sum + count, 0)}</p>
      </header>
      <section className="dsh-codex-handoff-objective">
        <strong>{dictionary.objective}</strong>
        <p>{safeText(manifest.objective.text)}</p>
      </section>
      <details className="dsh-codex-handoff-preview-details">
        <summary>{dictionary.previewDetails}</summary>
        <section className="dsh-codex-handoff-repository" aria-label={dictionary.currentRepository} data-state="current-repository">
          <h5>{dictionary.currentRepository}</h5>
          <dl>
            <dt>{dictionary.cwd}</dt><dd>{safeText(manifest.workspace.cwd)}</dd>
            <dt>{dictionary.repo}</dt><dd>{safeText(manifest.workspace.repoRoot ?? dictionary.unknown)}</dd>
            <dt>{dictionary.branch}</dt><dd>{safeText(manifest.workspace.branch ?? (manifest.workspace.detached ? dictionary.detached : dictionary.unknown))}</dd>
            <dt>{dictionary.head}</dt><dd>{safeText(manifest.workspace.head ?? dictionary.unknown)}</dd>
            <dt>{dictionary.status}</dt><dd>{manifest.workspace.dirty === undefined ? dictionary.unknown : manifest.workspace.dirty ? dictionary.dirty : dictionary.no}</dd>
          </dl>
        </section>
        <div className="dsh-codex-handoff-preview-columns">
          <section><h5>{dictionary.blockers}</h5>{list(manifest.currentProblems)}</section>
          <section><h5>{dictionary.nextActions}</h5>{list(manifest.nextActions)}</section>
        </div>
        <section><h5>{dictionary.failedApproaches}</h5>{list(manifest.failedAttempts)}</section>
      </details>
      {preview.degraded ? (
        <div className="dsh-codex-handoff-degraded" role="status">
          <p>{dictionary.degraded}</p>
          {degradedDiagnostic === undefined ? null : <small>{dictionary.diagnostics}: {safeText(degradedDiagnostic.message)}</small>}
        </div>
      ) : null}
    </section>
  )
}

const HANDOFF_CSS = `
.dsh-codex-handoff-backdrop {
  position: fixed; inset: 0; z-index: 10000; display: flex; align-items: center; justify-content: center;
  padding: 24px; background: rgba(0,0,0,.22); backdrop-filter: blur(8px);
}
.dsh-codex-handoff-dialog {
  --dsh-handoff-accent: var(--dsw-alias-state-business-primary, #4075e8);
  --surface: var(--dsw-alias-bg-layer-2, #fff);
  --muted: var(--dsw-alias-label-secondary, #666);
  --soft: var(--dsw-specific-tip, #f5f5f5);
  --line: var(--dsw-alias-border-l1, #ececec);
  display: flex; flex-direction: column; width: min(680px, 100%); max-height: calc(100dvh - 48px);
  min-height: 0; overflow: hidden; background: var(--surface); color: var(--dsw-alias-label-primary, #202020);
  border: 1px solid var(--line); border-radius: 20px; box-shadow: 0 20px 70px #0002;
  font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.dsh-codex-handoff-dialog[data-view="browse"] { height: min(590px, calc(100dvh - 48px)); }
.dsh-codex-handoff-dialog, .dsh-codex-handoff-dialog * { box-sizing: border-box; }
.dsh-codex-handoff-dialog h2, .dsh-codex-handoff-dialog h3, .dsh-codex-handoff-dialog h4, .dsh-codex-handoff-dialog h5,
.dsh-codex-handoff-dialog p, .dsh-codex-handoff-dialog ul, .dsh-codex-handoff-dialog dl { margin: 0; }
.dsh-codex-handoff-header { display: flex; align-items: center; justify-content: space-between; padding: 20px 24px 12px; gap: 12px; flex: none; }
.dsh-codex-handoff-title-lockup { display: flex; align-items: center; gap: 8px; }
.dsh-codex-handoff-header h2 { font-size: 15px; font-weight: 600; letter-spacing: -.02em; }
.dsh-codex-handoff-dialog button { font: inherit; cursor: pointer; border: 1px solid var(--line); border-radius: 9px; padding: 7px 12px; color: inherit; background: var(--surface); }
.dsh-codex-handoff-dialog button:hover:not(:disabled) { background: var(--soft); }
.dsh-codex-handoff-dialog button:disabled { opacity: .45; cursor: not-allowed; }
.dsh-codex-handoff-dialog .dsh-codex-handoff-close, .dsh-codex-handoff-dialog .dsh-codex-handoff-back {
  border: 0; background: transparent; width: 30px; height: 30px; padding: 0; font-size: 21px; color: var(--muted);
}
.dsh-codex-handoff-toolbar { padding: 4px 24px 12px; flex: none; }
.dsh-codex-handoff-search { display: flex; gap: 8px; }
.dsh-codex-handoff-search input, .dsh-codex-handoff-search select, .dsh-codex-handoff-dialog input[type="number"] {
  font: inherit; color: inherit; background: var(--soft); border: 1px solid transparent; border-radius: 9px; padding: 9px 12px; min-width: 0;
}
.dsh-codex-handoff-search input { flex: 1; width: 100%; }
.dsh-codex-handoff-search select { width: 112px; font-size: 12px; }
.dsh-codex-handoff-workspace { flex: 1 1 auto; min-height: 0; overflow-y: auto; scrollbar-width: thin; }
.dsh-codex-handoff-results { padding: 0 14px 18px; }
.dsh-codex-handoff-results > ul { list-style: none; padding: 0; }
.dsh-codex-handoff-dialog .dsh-codex-handoff-session > button {
  display: block; position: relative; width: 100%; text-align: left; border: 0; border-radius: 9px; background: transparent; padding: 12px 30px 12px 12px;
}
.dsh-codex-handoff-dialog .dsh-codex-handoff-session > button:hover,
.dsh-codex-handoff-dialog .dsh-codex-handoff-session > button[aria-pressed="true"] { background: var(--soft); }
.dsh-codex-handoff-session-title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 500; }
.dsh-codex-handoff-session-meta { display: flex; gap: 8px; color: var(--muted); font-size: 11px; margin-top: 3px; }
.dsh-codex-handoff-session-meta > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-codex-handoff-session-meta > span + span::before { content: "·"; margin-right: 8px; }
.dsh-codex-handoff-session-chevron { position: absolute; right: 12px; top: 19px; color: var(--muted); font-size: 17px; }
.dsh-codex-handoff-preview { padding: 10px 24px 22px; }
.dsh-codex-handoff-selection-header { margin: 8px 0 20px; }
.dsh-codex-handoff-selection-header h3 { font-size: 20px; font-weight: 600; line-height: 1.45; letter-spacing: -.025em; overflow-wrap: anywhere; }
.dsh-codex-handoff-selection-header p { margin-top: 6px; color: var(--muted); font-size: 12px; }
.dsh-codex-handoff-preview-content { display: flex; flex-direction: column; gap: 12px; }
.dsh-codex-handoff-simple-note { font-size: 12px; color: var(--muted); }
.dsh-codex-handoff-privacy { color: var(--muted); font-size: 11px; }
.dsh-codex-handoff-privacy > summary { cursor: pointer; list-style: none; }
.dsh-codex-handoff-privacy > summary span { display: none; }
.dsh-codex-handoff-privacy p { padding: 10px 0 0; line-height: 1.7; }
.dsh-codex-handoff-actions { position: sticky; bottom: -22px; background: var(--surface); padding: 10px 0; }
.dsh-codex-handoff-dialog .dsh-codex-handoff-primary { width: 100%; min-height: 42px; color: #fff; background: var(--dsh-handoff-accent); border-color: transparent; font-weight: 500; }
.dsh-codex-handoff-dialog .dsh-codex-handoff-primary:hover:not(:disabled) { filter: brightness(.95); background: var(--dsh-handoff-accent); }
.dsh-codex-handoff-options { font-size: 12px; }
.dsh-codex-handoff-options > summary { cursor: pointer; color: var(--muted); font-size: 11px; width: fit-content; }
.dsh-codex-handoff-options[open] > summary { margin-bottom: 14px; }
.dsh-codex-handoff-mode { display: flex; gap: 4px; padding: 4px; border: 0; border-radius: 10px; background: var(--soft); margin: 0 0 12px; }
.dsh-codex-handoff-mode legend, .dsh-codex-handoff-budget legend { font-size: 11px; color: var(--muted); margin-bottom: 6px; }
.dsh-codex-handoff-mode label { flex: 1; text-align: center; padding: 6px; cursor: pointer; border-radius: 7px; }
.dsh-codex-handoff-mode label:has(input:checked) { background: var(--surface); }
.dsh-codex-handoff-mode input { margin-right: 6px; }
.dsh-codex-handoff-setting { background: var(--soft); padding: 14px; border-radius: 10px; }
.dsh-codex-handoff-model-toggle { display: flex; gap: 8px; align-items: center; padding-bottom: 12px; }
.dsh-codex-handoff-dialog input[type="checkbox"], .dsh-codex-handoff-dialog input[type="radio"] { accent-color: var(--dsh-handoff-accent); }
.dsh-codex-handoff-budget { padding: 0; margin: 0; border: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.dsh-codex-handoff-budget-auto { display: flex; align-items: flex-start; gap: 7px; }
.dsh-codex-handoff-budget-auto small, .dsh-codex-handoff-budget > div small { display: block; font-size: 10px; color: var(--muted); margin-top: 4px; }
.dsh-codex-handoff-budget input[type="number"] { width: 100%; background: var(--surface); margin-top: 4px; }
.dsh-codex-handoff-budget > div[data-disabled="true"] { opacity: .45; }
.dsh-codex-handoff-setting-footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 12px; font-size: 11px; color: var(--muted); }
.dsh-codex-handoff-smart-preview { border-top: 1px solid var(--line); padding-top: 14px; }
.dsh-codex-handoff-smart-preview > header { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; }
.dsh-codex-handoff-smart-preview > header > div { display: flex; align-items: center; gap: 6px; }
.dsh-codex-handoff-smart-preview > header span { color: var(--dsh-handoff-accent); }
.dsh-codex-handoff-smart-preview h4, .dsh-codex-handoff-smart-preview h5 { font-size: 12px; }
.dsh-codex-handoff-smart-preview > header > p { display: none; }
.dsh-codex-handoff-objective { padding: 12px 0; }
.dsh-codex-handoff-objective strong { display: none; }
.dsh-codex-handoff-objective p { font-size: 13px; line-height: 1.8; }
.dsh-codex-handoff-preview-details > summary { color: var(--muted); font-size: 11px; cursor: pointer; }
.dsh-codex-handoff-preview-details section { padding: 10px 0; }
.dsh-codex-handoff-preview-details ul { padding-left: 20px; }
.dsh-codex-handoff-repository dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 11px; }
.dsh-codex-handoff-repository dd { margin: 0; overflow-wrap: anywhere; }
.dsh-codex-handoff-repository dt { color: var(--muted); }
.dsh-codex-handoff-notices { padding: 0 24px; flex: none; }
.dsh-codex-handoff-notices:empty, .dsh-codex-handoff-footer:empty { display: none; }
.dsh-codex-handoff-notices p { padding: 8px 0; font-size: 12px; }
.dsh-codex-handoff-notices [role="alert"], .dsh-codex-handoff-footer [role="alert"] { color: var(--dsw-alias-state-error-primary, #bf3838); }
.dsh-codex-handoff-degraded { font-size: 11px; color: var(--muted); margin-top: 10px; }
.dsh-codex-handoff-degraded small { display: block; overflow-wrap: anywhere; }
.dsh-codex-handoff-footer { padding: 10px 24px 18px; font-size: 12px; }
.dsh-codex-handoff-visually-hidden { position: absolute !important; width: 1px !important; height: 1px !important; overflow: hidden !important; clip: rect(0 0 0 0) !important; white-space: nowrap !important; }
.dsh-codex-handoff-dialog :focus-visible { outline: 2px solid var(--dsh-handoff-accent); outline-offset: 2px; }
.dsh-codex-handoff-selection-header h3:focus { outline: none; }
@media (max-width: 760px) {
  .dsh-codex-handoff-backdrop { padding: 16px; }
  .dsh-codex-handoff-dialog { max-height: calc(100dvh - 32px); }
  .dsh-codex-handoff-dialog[data-view="browse"] { height: min(590px, calc(100dvh - 32px)); }
}
@media (max-width: 480px) {
  .dsh-codex-handoff-header { padding: 14px 16px 8px; }
  .dsh-codex-handoff-toolbar { padding: 4px 16px 10px; }
  .dsh-codex-handoff-preview { padding: 8px 16px 16px; }
  .dsh-codex-handoff-results { padding: 0 6px 12px; }
  .dsh-codex-handoff-search select { width: 90px; padding: 7px; font-size: 11px; }
  .dsh-codex-handoff-budget { grid-template-columns: 1fr; }
}
@media (forced-colors: active) {
  .dsh-codex-handoff-dialog { border: 1px solid CanvasText; }
  .dsh-codex-handoff-dialog .dsh-codex-handoff-primary { background: Highlight; color: HighlightText; }
}
`

/** Frame-wide shell overlay containing the complete browse/preview/create flow. */
export function HandoffOverlay({ model, titleKey, onKey, locale, language = 'en' }: HandoffOverlayProps): ReactElement | null {
  const dictionary = useDictionary(locale, language)
  const [state, setState] = useState<HandoffClientState>(() => model.getState())
  const [choosing, setChoosing] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => model.subscribe(setState), [model])

  useEffect(() => {
    if (state.phase === 'closed') return undefined
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const timer = window.setTimeout(() => searchRef.current?.focus(), 0)
    return () => {
      window.clearTimeout(timer)
      if (previous !== undefined && document.contains(previous)) previous.focus()
    }
  }, [model, state.phase === 'closed'])

  const browsing = state.selected === undefined || choosing
  useEffect(() => {
    if (state.phase === 'closed') { setChoosing(false); return }
    const timer = window.setTimeout(() => {
      if (browsing) searchRef.current?.focus()
      else dialogRef.current?.querySelector<HTMLElement>('.dsh-codex-handoff-selection-header h3')?.focus()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [browsing, state.phase === 'closed'])

  if (state.phase === 'closed') return null

  const page = state.page
  const estimate = model.getBudgetEstimate()
  const selected = state.selected
  const error = state.error
  const compatibilityPending = state.phase === 'browsing' && state.compatibility === undefined
  const busy = compatibilityPending || state.phase === 'previewing' || state.phase === 'analyzing' || state.phase === 'creating' || state.searchPending
  const creating = state.phase === 'creating'
  const archiveLabel = state.query.archived === 'active'
    ? dictionary.archivedActive
    : state.query.archived === 'archived' ? dictionary.archivedArchived : dictionary.archivedAll
  const requiredCapabilityMissing = state.compatibility !== undefined && Object.values(state.compatibility.required).some(value => !value)
  const partialIndex = state.page?.items.some(item => item.parseHealth === 'partial') === true
    || state.compatibility?.diagnostics.some(item => item.code === 'CODEX_PARTIAL_PARSE' || item.code === 'CODEX_HISTORY_PARTIAL') === true
  const permissionDenied = state.error?.code === 'CODEX_ACCESS_DENIED'
    || state.compatibility?.diagnostics.some(item => item.code === 'CODEX_ACCESS_DENIED') === true
  const noInstallation = state.error?.code === 'CODEX_HOME_NOT_FOUND'
    || state.compatibility?.diagnostics.some(item => item.code === 'CODEX_HOME_NOT_FOUND') === true
  const onDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onKey('Escape')
      return
    }
    const target = event.target instanceof HTMLElement ? event.target : undefined
    const resultControl = target !== undefined && target.closest('[data-result-list]') !== null
    if (resultControl && (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'Enter')) {
      event.preventDefault()
      onKey(event.key)
      if (event.key === 'Enter') setChoosing(false)
      if (event.key !== 'Enter') {
        window.setTimeout(() => {
          dialogRef.current?.querySelector<HTMLElement>(`[data-result-index="${model.getState().resultIndex}"]`)?.focus()
        }, 0)
      }
      return
    }
    if (event.key !== 'Tab' || dialogRef.current === null) return
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button,input,select,summary,[tabindex="0"]')).filter(item => !item.hasAttribute('disabled') && !item.closest('details:not([open]) > :not(summary)'))
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (first !== undefined && last !== undefined && event.shiftKey && document.activeElement === first) {
      event.preventDefault(); last.focus()
    } else if (first !== undefined && last !== undefined && !event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus()
    }
  }
  const select = (summary: ExternalSessionSummary) => {
    setChoosing(false)
    model.select(summary)
    void model.previewSelected()
  }
  const consent = () => {
    if (model.acceptConsent() === undefined) return
    if (state.mode === 'smart') void model.analyzeSmart()
  }

  return (
    <div className="dsh-codex-handoff-backdrop" data-phase={state.phase}>
      <style>{HANDOFF_CSS}</style>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dsh-codex-handoff-title"
        tabIndex={-1}
        className="dsh-codex-handoff-dialog"
        aria-busy={busy}
        data-busy={busy ? 'true' : 'false'}
        data-view={browsing ? 'browse' : 'preview'}
        onKeyDown={onDialogKeyDown}
      >
        <header className="dsh-codex-handoff-header">
          <div className="dsh-codex-handoff-title-lockup">
            {!browsing ? <button className="dsh-codex-handoff-back" type="button" aria-label={dictionary.changeSession} disabled={busy} onClick={() => setChoosing(true)}>←</button> : null}
            <h2 id="dsh-codex-handoff-title">{text(dictionary, titleKey)}</h2>
          </div>
          <button className="dsh-codex-handoff-close" type="button" aria-label={creating ? dictionary.cancel : dictionary.close} onClick={() => creating ? model.cancel() : onKey('Escape')}>
            {creating ? dictionary.cancel : <><span aria-hidden="true">×</span><span className="dsh-codex-handoff-visually-hidden">{dictionary.close}</span></>}
          </button>
        </header>

        {browsing ? <div className="dsh-codex-handoff-toolbar">
          <section className="dsh-codex-handoff-search" aria-label={dictionary.focusSearch}>
            <label className="dsh-codex-handoff-visually-hidden" htmlFor="dsh-codex-handoff-search">{dictionary.search}</label>
            <input
              ref={searchRef}
              id="dsh-codex-handoff-search"
              value={state.query.search ?? ''}
              placeholder={dictionary.searchPlaceholder}
              onChange={event => { void model.search(event.target.value) }}
            />
            <select
              // The active locale seat is reactive; unlike a static option
              // string this accessible name updates when the shell language
              // changes while the overlay remains open.
              aria-label={archiveLabel}
              value={state.query.archived}
              onChange={event => { void model.setArchived(event.target.value as 'all' | 'active' | 'archived') }}
            >
              <option value="all">{dictionary.archivedAll}</option>
              <option value="active">{dictionary.archivedActive}</option>
              <option value="archived">{dictionary.archivedArchived}</option>
            </select>
          </section>
        </div> : null}

        <div className="dsh-codex-handoff-notices">
          {busy ? <p role="status" aria-live="polite">{creating ? dictionary.creating : compatibilityPending ? dictionary.compatibility : dictionary.loading}</p> : null}
          {busy ? <button type="button" onClick={() => model.cancel()}>{dictionary.cancel}</button> : null}
          {error ? <p role="alert">{errorText(dictionary, error.code, state.unlimitedTokens)}{errorDetail(error.code, error.message)}</p> : null}
          {state.phase === 'cancelled' ? <p role="status">{dictionary.cancelled}</p> : null}
          {requiredCapabilityMissing ? <p role="alert" data-state="capability">{dictionary.capability}</p> : null}
          {partialIndex ? <p role="status" data-state="partialIndex">{dictionary.partialIndex}</p> : null}
          {noInstallation ? <p role="status" data-state="noInstallation">{dictionary.noInstallation}</p> : null}
          {permissionDenied ? <p role="alert" data-state="permission">{dictionary.permission}</p> : null}
        </div>
        <div className="dsh-codex-handoff-workspace" data-has-preview={selected === undefined ? 'false' : 'true'}>
          {browsing && page !== undefined ? (
            <section className="dsh-codex-handoff-results" aria-label={dictionary.focusResults}>
              {page.items.length === 0 ? <p>{dictionary.noSessions}</p> : (
                <ul data-result-list>
                  {page.items.map((item, index) => <SessionRow key={item.sessionId} summary={item} dictionary={dictionary} selected={selected?.sessionId === item.sessionId} tabIndex={index === state.resultIndex ? 0 : -1} resultIndex={index} onFocus={() => model.setFocus('results')} onSelect={() => select(item)} />)}
                </ul>
              )}
              {page.nextCursor !== undefined ? <button type="button" onClick={() => { void model.loadMore() }} disabled={busy}>{dictionary.loadMore}</button> : null}
            </section>
          ) : null}

          {!browsing && selected !== undefined ? (
          <section className="dsh-codex-handoff-preview" aria-label={dictionary.focusPreview}>
            <header className="dsh-codex-handoff-selection-header">
              <div>
                <h3 tabIndex={-1} title={sessionLabel(selected)}>{compactSessionLabel(selected)}</h3>
                <p>{repoBasename(selected.cwd, dictionary.unknown)} · {compactUpdated(selected.updatedAt)}</p>
              </div>
            </header>
            {state.preview !== undefined ? (
              <div className="dsh-codex-handoff-preview-content">

                <p className="dsh-codex-handoff-simple-note">{state.mode === 'smart' && state.useModel ? dictionary.simpleModelNotice : dictionary.simpleLocalNotice}</p>
                <PrivacyNotice dictionary={dictionary} mode={state.mode} useModel={state.useModel} />
                {estimate.warning ? <p role="status" data-state="large">{dictionary.largeFullWarning}</p> : null}
                {estimate.requiresConfirmation ? <label><input type="checkbox" checked={state.fullConfirmed} onChange={event => model.setFullConfirmed(event.target.checked)} />{dictionary.confirmLarge}</label> : null}
                {state.smartPreview !== undefined ? <SmartPreviewView preview={state.smartPreview} dictionary={dictionary} /> : null}
                <div className="dsh-codex-handoff-actions">
                  {state.consent === undefined ? <button className="dsh-codex-handoff-primary dsh-codex-handoff-consent" type="button" onClick={consent} disabled={busy}>{state.mode === 'smart' && state.useModel ? dictionary.analyze : dictionary.confirm}</button> : null}
                  {state.consent !== undefined ? <button className="dsh-codex-handoff-primary dsh-codex-handoff-create" type="button" onClick={() => { void model.create() }} disabled={busy || requiredCapabilityMissing || state.consent === undefined}>{dictionary.create}</button> : null}
                </div>
                <details className="dsh-codex-handoff-options">
                  <summary>{dictionary.moreOptions}</summary>
                <fieldset className="dsh-codex-handoff-mode">
                  <legend>{dictionary.focusMode}</legend>
                  <label><input type="radio" name="dsh-codex-handoff-mode" checked={state.mode === 'smart'} onChange={() => model.setMode('smart')} />{dictionary.modeSmart}</label>
                  <label><input type="radio" name="dsh-codex-handoff-mode" checked={state.mode === 'full'} onChange={() => model.setMode('full')} />{dictionary.modeFull}</label>
                </fieldset>
                {state.mode === 'smart' ? (
                  <div className="dsh-codex-handoff-setting">
                    <label className="dsh-codex-handoff-model-toggle"><input type="checkbox" checked={state.useModel} onChange={event => model.setUseModel(event.target.checked)} /><span>{state.useModel ? dictionary.modelAnalysis : dictionary.deterministic}</span></label>
                    <fieldset className="dsh-codex-handoff-budget">
                      <legend>{dictionary.contextBudget}</legend>
                      <label className="dsh-codex-handoff-budget-auto">
                        <input type="checkbox" checked={state.unlimitedTokens} onChange={event => model.setUnlimitedTokens(event.target.checked)} />
                        <span><strong>{dictionary.unlimitedTokens}</strong><small>{dictionary.unlimitedTokensHint}</small></span>
                      </label>
                      <div data-disabled={state.unlimitedTokens ? 'true' : 'false'}>
                        <label htmlFor="dsh-codex-handoff-target">{dictionary.customTarget}</label>
                        <input id="dsh-codex-handoff-target" type="number" min={BUDGET_LIMITS.minimumTargetTokens} step="1000" value={state.targetTokens} disabled={state.unlimitedTokens} onChange={event => model.setTargetTokens(Number(event.target.value))} aria-describedby="dsh-codex-handoff-target-hint" />
                        <small id="dsh-codex-handoff-target-hint">{dictionary.customTargetHint}</small>
                      </div>
                    </fieldset>
                    <div className="dsh-codex-handoff-setting-footer">
                      <span>{state.unlimitedTokens ? dictionary.unlimitedTokens : `${dictionary.targetTokens}: ${state.targetTokens}`}</span>
                      {state.useModel && (state.consent === undefined || state.phase === 'analyzing' || state.degraded) ? <button type="button" onClick={() => model.continueDeterministic()} disabled={state.phase === 'creating'}>{dictionary.skipAnalysis}</button> : null}
                    </div>
                  </div>
                ) : null}
                </details>
              </div>
            ) : null}
          </section>
          ) : null}
        </div>

        <footer className="dsh-codex-handoff-footer">
          {state.outcome?.state === 'created_unattached' ? (
            <div role="alert" data-state="created_unattached">
              <p>{dictionary.createdUnattached}</p>
              <button type="button" onClick={() => model.close()}>{dictionary.close}</button>
            </div>
          ) : null}
          {state.phase === 'created' && state.outcome?.state === 'created' ? <p role="status">{dictionary.created}</p> : null}
          {error?.recoverable ? <button type="button" onClick={() => { void model.retry() }}>{dictionary.retry}</button> : null}
          {creating ? <p>{dictionary.cancelHint}</p> : null}
        </footer>
      </div>
    </div>
  )
}
