// @vitest-environment jsdom

import React from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { HandoffAction, HandoffOverlay } from '../../src/client/components.js'
import { HandoffClientModel } from '../../src/client/model.js'
import { en, zh } from '../../src/client/locales.js'
import { FakeRemote, FakeSessions, FakeUiWorkspace, session } from '../fixtures/client/remote.js'
import type { SmartPreview } from '../../src/shared/types.js'

// F0 supplies jsdom as the root test dependency; this is a real document,
// event, and focus model rather than a hand-written DOM seam.
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const domGlobal = globalThis as typeof globalThis & Record<string, unknown>
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'MutationObserver', 'getComputedStyle']) {
  domGlobal[name] = (dom.window as unknown as Record<string, unknown>)[name]
}
domGlobal.IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  void rtl?.cleanup()
  dom.window.document.body.replaceChildren()
})

let rtl: typeof import('@testing-library/react') | undefined
beforeAll(async () => {
  // Import after installing the document: RTL captures document.body at module
  // initialization in a few versions.
  rtl = await import('@testing-library/react')
})

describe('Codex handoff React slot components', () => {
  it('shows a localized compatibility busy state before the remote responds', async () => {
    const remote = new FakeRemote()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    remote.compatibility = () => gate.then(() => remote.compatibilityView)
    const sessions = new FakeSessions()
    const model = new HandoffClientModel(remote, sessions, sessions.navigation)
    const { act, render, screen, waitFor } = rtl!
    render(React.createElement(HandoffOverlay, { model, titleKey: 'title', onKey: key => model.keyboard(key) }))
    let opening!: Promise<void>
    await act(async () => { opening = model.open() })
    await waitFor(() => expect(screen.getByText(en.compatibility)).toBeTruthy())
    expect(screen.getByRole('dialog').getAttribute('aria-busy')).toBe('true')
    await act(async () => { release(); await opening })
    expect(screen.queryByText(en.compatibility)).toBeNull()
  })

  it('opens from the sidebar action, traps Escape, and restores focus', async () => {
    const sessions = new FakeSessions()
    const model = new HandoffClientModel(new FakeRemote(), sessions, sessions.navigation)
    const anchor = document.createElement('button')
    anchor.textContent = 'anchor'
    document.body.append(anchor)
    anchor.focus()
    const { fireEvent, render, screen, waitFor } = rtl!
    render(React.createElement(React.Fragment, null,
      React.createElement(HandoffAction, { model, labelKey: 'action', wide: true, onActivate: () => model.open() }),
      React.createElement(HandoffOverlay, { model, titleKey: 'title', onKey: key => model.keyboard(key) }),
    ))
    const actionStyle = document.querySelector('style[data-dsh-codex-handoff-action-style="true"]')
    expect(actionStyle?.textContent).toContain('.dsh-codex-handoff-action[data-wide="false"]')
    expect(actionStyle?.textContent).toContain('border-radius: 12px')
    fireEvent.click(screen.getByRole('button', { name: en.action }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: en.search }))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(anchor)
  })

  it('renders mode privacy copy and ignores a duplicate create click', async () => {
    const remote = new FakeRemote()
    const sessions = new FakeSessions()
    const model = new HandoffClientModel(remote, sessions, sessions.navigation)
    const { act, fireEvent, render, screen, waitFor } = rtl!
    let releaseCreate = (): void => undefined
    const createGate = new Promise<void>(resolve => { releaseCreate = resolve })
    const originalCreate = remote.create.bind(remote)
    remote.create = async (request, signal) => {
      await createGate
      return originalCreate(request, signal)
    }
    render(React.createElement(HandoffOverlay, { model, titleKey: 'title', onKey: key => model.keyboard(key) }))
    await act(async () => {
      await model.open()
      model.select(session)
      await model.previewSelected()
    })
    await waitFor(() => expect(screen.getByRole('note').textContent).toContain(en.smartDisclosure))
    expect(screen.getByRole('note').textContent).toContain(en.privacyModel)
    expect((screen.getByRole('note') as HTMLDetailsElement).open).toBe(false)
    await act(async () => { model.setUseModel(false) })
    await waitFor(() => expect(screen.getByRole('note').textContent).toContain(en.privacyNoModel))
    await act(async () => { model.setMode('full') })
    await waitFor(() => expect(screen.getByRole('note').textContent).toContain(en.privacyPersistence))
    await act(async () => { model.acceptConsent() })
    await waitFor(() => expect(model.getState().consent).toBeDefined())
    const create = screen.getByRole('button', { name: en.create })
    fireEvent.click(create)
    await waitFor(() => expect(model.getState().phase).toBe('creating'))
    expect(screen.getByRole('dialog').getAttribute('aria-busy')).toBe('true')
    expect(screen.getByText(en.cancelHint)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: en.cancel }).length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByRole('button', { name: en.close })).toBeNull()
    // A second click on the live button is ignored by the model's single-flight
    // guard while the first request is still in flight.
    fireEvent.click(screen.getByRole('button', { name: en.create }))
    releaseCreate()
    await waitFor(() => expect(remote.createCalls).toBe(1))
    expect(vi.isMockFunction(model.create)).toBe(false)
  })

  it('shows a generic internal error for a failed Full create', async () => {
    const remote = new FakeRemote()
    remote.createShouldFail = true
    const sessions = new FakeSessions()
    const model = new HandoffClientModel(remote, sessions, sessions.navigation)
    const { act, render, screen, waitFor } = rtl!
    render(React.createElement(HandoffOverlay, { model, titleKey: 'title', onKey: key => model.keyboard(key) }))
    await act(async () => {
      await model.open()
      model.select(session)
      await model.previewSelected()
      model.setMode('full')
      model.acceptConsent()
      await model.create()
    })
    await waitFor(() => expect(screen.getByText(en.internalError)).toBeTruthy())
    expect(screen.getByText(en.internalError).textContent).not.toMatch(/Smart/i)
    expect(remote.createCalls).toBe(1)
  })

  it('renders SPEC13 row/preview fields and reacts to the official locale seat', async () => {
    const remote = new FakeRemote()
    const model = new HandoffClientModel(remote, new FakeSessions(), new FakeUiWorkspace())
    let language: 'en' | 'zh' = 'en'
    const listeners = new Set<() => void>()
    const locale = {
      bind: () => (key: string) => (language === 'zh' ? zh[key as keyof typeof zh] : en[key as keyof typeof en]),
      getSnapshot: () => ({ active: language, revision: language === 'zh' ? 1 : 0 }),
      subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    }
    const { act, render, screen, waitFor } = rtl!
    render(React.createElement(HandoffOverlay, { model, titleKey: 'title', locale, onKey: key => model.keyboard(key) }))
    await act(async () => { await model.open() })
    await waitFor(() => expect(screen.getByRole('button', { name: /Updated:/ })).toBeTruthy())
    expect(screen.getByRole('button', { name: /Messages:/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Health:/ })).toBeTruthy()
    expect(document.querySelector('.dsh-codex-handoff-session-meta')?.textContent).not.toContain(en.tools)
    await act(async () => {
      language = 'zh'
      for (const listener of listeners) listener()
    })
    expect(screen.getByRole('heading', { name: zh.title })).toBeTruthy()
    expect(screen.getByRole('button', { name: /更新时间:/ })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: zh.archivedAll })).toBeTruthy()
  })

  it('supports ArrowUp/ArrowDown and Enter result selection', async () => {
    const remote = new FakeRemote()
    remote.page = { ...remote.page, items: [session, { ...session, sessionId: 'session-2', discoveryId: 'discovery-2', title: 'Second source' }] }
    const model = new HandoffClientModel(remote, new FakeSessions(), new FakeUiWorkspace())
    const { act, fireEvent, render, screen, waitFor } = rtl!
    render(React.createElement(HandoffOverlay, { model, titleKey: 'title', onKey: key => model.keyboard(key) }))
    await act(async () => { await model.open() })
    await waitFor(() => expect(screen.getByText('Second source')).toBeTruthy())
    const first = screen.getByRole('button', { name: /A source session/ })
    const second = screen.getByRole('button', { name: /Second source/ })
    await act(async () => {
      first.focus()
      fireEvent.keyDown(first, { key: 'ArrowDown' })
      second.focus()
      fireEvent.keyDown(second, { key: 'Enter' })
    })
    await waitFor(() => expect(model.getState().selected?.sessionId).toBe('session-2'))
    expect(screen.getByLabelText(en.focusPreview)).toBeTruthy()
  })

  it('previews on selection and exposes an uncapped default with an optional custom budget', async () => {
    const remote = new FakeRemote()
    const model = new HandoffClientModel(remote, new FakeSessions(), new FakeUiWorkspace())
    const { act, fireEvent, render, screen, waitFor } = rtl!
    render(React.createElement(HandoffOverlay, { model, titleKey: 'title', onKey: key => model.keyboard(key) }))
    await act(async () => { await model.open() })
    fireEvent.click(screen.getByRole('button', { name: /A source session/ }))
    await waitFor(() => expect(remote.previewRequests).toHaveLength(1))
    expect(screen.queryByRole('region', { name: en.focusResults })).toBeNull()
    expect(screen.queryByRole('textbox', { name: en.search })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.changeSession }))
    expect(screen.queryByRole('region', { name: en.focusPreview })).toBeNull()
    expect(screen.getByRole('textbox', { name: en.search })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /A source session/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: en.analyze })).toBeTruthy())
    const unlimited = screen.getByRole('checkbox', { name: new RegExp(en.unlimitedTokens) })
    const target = screen.getByRole('spinbutton', { name: en.customTarget }) as HTMLInputElement
    expect((unlimited as HTMLInputElement).checked).toBe(true)
    expect(target.disabled).toBe(true)
    fireEvent.click(unlimited)
    fireEvent.change(target, { target: { value: '64000' } })
    expect(model.getState()).toMatchObject({ unlimitedTokens: false, targetTokens: 64_000 })
    expect(target.disabled).toBe(false)
  })

  it('renders capability, partial-index, and repository facts from their official sources', async () => {
    const remote = new FakeRemote()
    remote.page = { ...remote.page, items: [{ ...session, parseHealth: 'partial' }] }
    const model = new HandoffClientModel(remote, new FakeSessions(), new FakeUiWorkspace())
    const { act, render, screen, waitFor } = rtl!
    render(React.createElement(HandoffOverlay, { model, titleKey: 'title', onKey: key => model.keyboard(key) }))
    await act(async () => { await model.open() })
    await waitFor(() => expect(screen.getByText(en.partialIndex)).toBeTruthy())
    expect(screen.queryByRole('region', { name: en.capabilities })).toBeNull()
    const style = document.querySelector('style')
    expect(style?.textContent).toContain('position: fixed')
    expect(style?.textContent).toContain('inset: 0')
    expect(style?.textContent).toContain('position: sticky')
    expect(style?.textContent).toContain('.dsh-codex-handoff-toolbar')
    expect(style?.textContent).toContain('@media (max-width: 760px)')
    expect(style?.textContent).toContain('@media (forced-colors: active)')
    expect(screen.getByRole('dialog').querySelector('.dsh-codex-handoff-workspace')).toBeTruthy()
    expect(screen.getByRole('region', { name: en.focusResults }).classList.contains('dsh-codex-handoff-results')).toBe(true)
  })

  it('keeps deterministic continuation reachable and renders Smart current repository facts', async () => {
    const remote = new FakeRemote()
    remote.analyzeValue = {
      source: { discoveryId: session.discoveryId, source: session.source, sessionId: session.sessionId, rolloutRevisionId: session.rolloutRevisionId, expectedFingerprint: session.fingerprint },
      manifest: {
        schemaVersion: '1.0.0', generatedAt: session.updatedAt, mode: 'smart',
        source: { agent: 'codex', sessionId: session.sessionId, rolloutRevisionId: session.rolloutRevisionId, fingerprint: session.fingerprint },
        objective: { text: 'keep the handoff', sourceIds: ['e1'], confidence: 'high' },
        workspace: { cwd: session.cwd!, repoRoot: 'C:\\work\\dshp', branch: 'main', head: 'abc123', dirty: true },
        progress: { completed: [], inProgress: [], blocked: [] }, decisions: [], failedAttempts: [], currentProblems: [], relevantFiles: [],
        repositoryChanges: { modified: [], added: [], deleted: [], renamed: [] },
        verification: { commandsRun: [], testsPassed: [], testsFailed: [], latestStatus: 'unknown' }, constraints: [], openQuestions: [], nextActions: [],
        provenance: [{ id: 'e1', kind: 'observed', source: 'session-1', locator: 'message-1', confidence: 'high' }],
        completeness: { malformedLines: 0, unknownRecords: 0, droppedEncryptedBlocks: 0, danglingToolCalls: 0, orphanToolResults: 0, truncatedRecords: 0, analyzer: 'dsh-model', omittedByBudget: {} },
        diagnostics: [],
      },
      context: { text: 'context', source: { plugin: 'codex', sourceSessionId: session.sessionId, sourceRolloutRevisionId: session.rolloutRevisionId, fingerprint: session.fingerprint, mode: 'smart', compilerSchema: 'v2', summary: 'context' }, estimatedTokens: 12, estimator: 'fallback', omittedByBudget: {}, diagnostics: [] },
      degraded: false, diagnostics: [],
    } as unknown as SmartPreview
    const model = new HandoffClientModel(remote, new FakeSessions(), new FakeUiWorkspace())
    const { act, fireEvent, render, screen, waitFor } = rtl!
    render(React.createElement(HandoffOverlay, { model, titleKey: 'title', onKey: key => model.keyboard(key) }))
    await act(async () => { await model.open(); model.select(session); await model.previewSelected() })
    fireEvent.click(screen.getByRole('button', { name: en.skipAnalysis }))
    expect(model.getState().useModel).toBe(false)
    expect(screen.getByRole('note').textContent).toContain(en.privacyNoModel)
    expect(screen.queryByText(en.sessionDetails)).toBeNull()
    expect(screen.queryByText(en.technicalDetails)).toBeNull()
    expect(screen.queryByRole('button', { name: en.create })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.confirm }))
    await waitFor(() => expect(remote.analyzeRequests[0]).toMatchObject({ useModel: false }))
    expect(screen.getByText(en.currentRepository)).toBeTruthy()
    expect(screen.getByText('main')).toBeTruthy()
  })

  it('shows localized Smart budget guidance without a misleading degraded or generic error', async () => {
    const remote = new FakeRemote()
    remote.analyze = async request => {
      remote.analyzeRequests.push(request)
      throw { code: 'SMART_CONTEXT_CANNOT_FIT', message: 'The handoff operation failed unexpectedly.', recoverable: true }
    }
    const model = new HandoffClientModel(remote, new FakeSessions(), new FakeUiWorkspace())
    const { act, render, screen, waitFor } = rtl!
    render(React.createElement(HandoffOverlay, { model, titleKey: 'title', language: 'zh', onKey: key => model.keyboard(key) }))
    await act(async () => {
      await model.open()
      model.select(session)
      await model.previewSelected()
      model.acceptConsent()
      await model.analyzeSmart()
    })
    const alert = await waitFor(() => screen.getByRole('alert'))
    expect(alert.textContent).toBe(zh.smartUnlimitedCannotFit)
    expect(screen.queryByText(zh.degraded)).toBeNull()
    expect(alert.textContent).not.toContain('failed unexpectedly')
  })

  it('does not capture list navigation from search or archive controls', async () => {
    const model = new HandoffClientModel(new FakeRemote(), new FakeSessions(), new FakeUiWorkspace())
    const { act, fireEvent, render, screen, waitFor } = rtl!
    render(React.createElement(HandoffOverlay, { model, titleKey: 'title', onKey: key => model.keyboard(key) }))
    await act(async () => { await model.open() })
    const search = screen.getByRole('textbox', { name: en.search })
    const archive = screen.getByRole('combobox', { name: en.archivedAll })
    search.focus(); fireEvent.keyDown(search, { key: 'ArrowDown' })
    archive.focus(); fireEvent.keyDown(archive, { key: 'ArrowDown' })
    expect(model.getState().resultIndex).toBe(0)
    expect(document.activeElement).toBe(archive)
    fireEvent.change(archive, { target: { value: 'active' } })
    await waitFor(() => expect(screen.getByRole('combobox', { name: en.archivedActive })).toBeTruthy())
  })

  it('shows an actionable unattached warning before allowing close', async () => {
    const remote = new FakeRemote()
    remote.createOutcome = { state: 'created_unattached', sessionId: 'dsh-session-1', workspaceAttached: false, warnings: [] }
    const sessions = new FakeSessions()
    const model = new HandoffClientModel(remote, sessions, sessions.navigation)
    const { act, fireEvent, render, screen, waitFor, within } = rtl!
    render(React.createElement(HandoffOverlay, { model, titleKey: 'title', onKey: key => model.keyboard(key) }))
    await act(async () => { await model.open(); model.select(session); await model.previewSelected(); model.setMode('full') })
    fireEvent.click(screen.getByRole('button', { name: en.confirm }))
    fireEvent.click(screen.getByRole('button', { name: en.create }))
    const warning = await waitFor(() => screen.getByRole('alert'))
    expect(warning.textContent).toContain(en.createdUnattached)
    expect(sessions.opened).toEqual(['dsh-session-1'])
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.click(within(warning).getByRole('button', { name: en.close }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})
