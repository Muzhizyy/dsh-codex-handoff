// @vitest-environment jsdom

import React from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ReturnHeaderAction } from '../../src/client/return-components.js'
import { ReturnClientModel } from '../../src/client/return-model.js'
import { en, zh } from '../../src/client/locales.js'
import { FakeRemote } from '../fixtures/client/remote.js'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
const domGlobal = globalThis as typeof globalThis & Record<string, unknown>
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'MutationObserver', 'getComputedStyle']) {
  domGlobal[name] = (dom.window as unknown as Record<string, unknown>)[name]
}
domGlobal.IS_REACT_ACT_ENVIRONMENT = true

let rtl: typeof import('@testing-library/react') | undefined
let clipboardDescriptor: PropertyDescriptor | undefined

afterEach(() => {
  void rtl?.cleanup()
  dom.window.document.body.replaceChildren()
  if (clipboardDescriptor === undefined) Reflect.deleteProperty(navigator, 'clipboard')
  else Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
  clipboardDescriptor = undefined
})

beforeAll(async () => { rtl = await import('@testing-library/react') })

function stubClipboard(writeText: (value: string) => Promise<void>): void {
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
}

describe('Codex return header action', () => {
  it('uses the current header session, keeps details collapsed, and shows warnings', async () => {
    const remote = new FakeRemote()
    const workspaceSummary = 'Branch: main\nHEAD: 123456789012\nChanged paths (8): src/one.ts, src/two.ts'
    remote.returnPreviewValue = {
      ...remote.returnPreviewValue,
      workspace: { ...remote.returnPreviewValue.workspace, canonicalCwd: 'C:\\work\\DSHP', summary: workspaceSummary },
      warnings: ['Check the latest repository state.'],
    }
    const model = new ReturnClientModel(remote)
    const { fireEvent, render, screen, waitFor } = rtl!
    render(React.createElement(React.Fragment, null,
      React.createElement(ReturnHeaderAction, { model, sessionId: 'dsh-current-session' }),
      React.createElement(ReturnHeaderAction, { model, sessionId: 'dsh-another-session' }),
    ))
    const headerActions = screen.getAllByRole('button', { name: en.returnAction })
    fireEvent.click(headerActions[0]!)

    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(remote.returnPreviewRequests).toEqual([{ dshSessionId: 'dsh-current-session' }])
    expect(screen.getByText('DSHP')).toBeTruthy()
    expect(screen.getByText(en.returnExplanation)).toBeTruthy()
    expect(screen.getByText('Check the latest repository state.')).toBeTruthy()
    expect(Array.from(document.querySelectorAll('.dsh-codex-return-summary')).some(node => node.textContent === workspaceSummary)).toBe(false)
    expect(screen.getByRole('button', { name: en.returnSync })).toBeTruthy()
    const contextDetails = screen.getByText(en.returnContextDetails).closest('details')!
    expect(contextDetails.open).toBe(false)
    fireEvent.click(screen.getByText(en.returnContextDetails))
    expect(contextDetails.open).toBe(true)
    expect(contextDetails.querySelector('pre')?.textContent).toBe(remote.returnPreviewValue.context)
    expect(Array.from(contextDetails.querySelectorAll('pre')).some(node => node.textContent === workspaceSummary)).toBe(true)
    expect(remote.returnSyncRequests).toEqual([])
  })

  it('copies exactly the server-provided resume command after confirmed success', async () => {
    const remote = new FakeRemote()
    const displayCommand = '"C:\\Codex\\codex.exe" resume fork-created-1'
    remote.returnSyncValue = {
      status: 'created', receiptId: remote.returnPreviewValue.receiptId, sourceThreadId: 'source-thread-1',
      codexForkId: 'fork-created-1',
      resume: { argv: ['codex.exe', 'resume', 'fork-created-1'], displayCommand },
    }
    const writeText = vi.fn(async (_value: string) => undefined)
    stubClipboard(writeText)
    const model = new ReturnClientModel(remote)
    const { fireEvent, render, screen, waitFor } = rtl!
    render(React.createElement(ReturnHeaderAction, { model, sessionId: 'dsh-current-session' }))
    fireEvent.click(screen.getByRole('button', { name: en.returnAction }))
    await waitFor(() => expect(screen.getByRole('button', { name: en.returnSync })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: en.returnSync }))

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(en.returnCreated))
    expect(remote.returnSyncRequests).toEqual([{ receiptId: remote.returnPreviewValue.receiptId }])
    fireEvent.click(screen.getByRole('button', { name: en.returnCopyCommand }))
    await waitFor(() => expect(screen.getByText(en.returnCopied)).toBeTruthy())
    expect(writeText).toHaveBeenCalledOnce()
    expect(writeText).toHaveBeenCalledWith(displayCommand)
    const collapsed = Array.from(document.querySelectorAll<HTMLDetailsElement>('.dsh-codex-return-details'))
    expect(collapsed.every(details => !details.open)).toBe(true)
  })

  it('shows a localized message when the current DSH session has no Codex source', async () => {
    const remote = new FakeRemote()
    remote.returnPreview = async request => {
      remote.returnPreviewRequests.push(request)
      throw { code: 'RETURN_SOURCE_METADATA_MISSING', message: 'source not found' }
    }
    const model = new ReturnClientModel(remote)
    const { fireEvent, render, screen } = rtl!
    render(React.createElement(ReturnHeaderAction, { model, sessionId: 'dsh-unlinked-session' }))
    fireEvent.click(screen.getByRole('button', { name: en.returnAction }))

    expect((await screen.findByRole('alert')).textContent).toBe(en.returnSourceMissing)
    expect(remote.returnPreviewRequests).toEqual([{ dshSessionId: 'dsh-unlinked-session' }])
    expect(screen.queryByRole('button', { name: en.returnSync })).toBeNull()
  })

  it.each([
    ['English', undefined, en.returnAction, en.returnNotSupported],
    ['Chinese', (key: string) => (zh as Readonly<Record<string, string>>)[key], zh.returnAction, zh.returnNotSupported],
  ] as const)('explains an unsupported workspace in %s', async (_name, locale, actionName, message) => {
    const remote = new FakeRemote()
    remote.returnPreview = async request => {
      remote.returnPreviewRequests.push(request)
      throw { code: 'RETURN_NOT_SUPPORTED', message: 'unsupported workspace' }
    }
    const model = new ReturnClientModel(remote)
    const { fireEvent, render, screen } = rtl!
    render(React.createElement(ReturnHeaderAction, { model, sessionId: 'dsh-current-session', ...(locale === undefined ? {} : { locale }) }))
    fireEvent.click(screen.getByRole('button', { name: actionName }))
    expect((await screen.findByRole('alert')).textContent).toBe(message)
  })

  it('locks the dialog while one return request is in flight', async () => {
    const remote = new FakeRemote()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const outcome = remote.returnSyncValue
    remote.returnSync = async request => {
      remote.returnSyncRequests.push(request)
      await gate
      return outcome
    }
    const model = new ReturnClientModel(remote)
    const { fireEvent, render, screen, waitFor } = rtl!
    render(React.createElement(ReturnHeaderAction, { model, sessionId: 'dsh-current-session' }))
    const headerAction = screen.getByRole('button', { name: en.returnAction })
    fireEvent.click(headerAction)
    await waitFor(() => expect(screen.getByRole('button', { name: en.returnSync })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: en.returnSync }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(en.returnSyncing))

    expect(screen.getByRole('dialog').getAttribute('aria-busy')).toBe('true')
    expect(headerAction.hasAttribute('disabled')).toBe(true)
    expect(screen.queryByRole('button', { name: en.returnSync })).toBeNull()
    expect(remote.returnSyncRequests).toEqual([{ receiptId: remote.returnPreviewValue.receiptId }])
    release()
    await waitFor(() => expect(screen.getByRole('button', { name: en.returnCopyCommand })).toBeTruthy())
    expect(remote.returnSyncRequests).toHaveLength(1)
  })

  it('offers a fresh preview when the prepared receipt is stale', async () => {
    const remote = new FakeRemote()
    remote.returnSync = async request => {
      remote.returnSyncRequests.push(request)
      throw { code: 'RETURN_STALE', message: 'stale snapshot' }
    }
    const model = new ReturnClientModel(remote)
    const { fireEvent, render, screen, waitFor } = rtl!
    render(React.createElement(ReturnHeaderAction, { model, sessionId: 'dsh-current-session' }))
    fireEvent.click(screen.getByRole('button', { name: en.returnAction }))
    await waitFor(() => expect(screen.getByRole('button', { name: en.returnSync })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: en.returnSync }))
    expect(await screen.findByText(en.returnStale)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en.returnRefresh }))
    await waitFor(() => expect(screen.getByRole('button', { name: en.returnSync })).toBeTruthy())
    expect(remote.returnPreviewRequests).toHaveLength(2)
    expect(remote.returnSyncRequests).toEqual([{ receiptId: remote.returnPreviewValue.receiptId }])
  })

  it('offers a fresh preview when the receipt expires before sync', async () => {
    const remote = new FakeRemote()
    remote.returnSync = async request => {
      remote.returnSyncRequests.push(request)
      throw { code: 'RETURN_PREVIEW_EXPIRED', message: 'expired receipt' }
    }
    const model = new ReturnClientModel(remote)
    const { fireEvent, render, screen, waitFor } = rtl!
    render(React.createElement(ReturnHeaderAction, { model, sessionId: 'dsh-current-session' }))
    fireEvent.click(screen.getByRole('button', { name: en.returnAction }))
    await waitFor(() => expect(screen.getByRole('button', { name: en.returnSync })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: en.returnSync }))
    expect(await screen.findByText(en.returnPreviewExpired)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en.returnRefresh }))
    await waitFor(() => expect(screen.getByRole('button', { name: en.returnSync })).toBeTruthy())
    expect(remote.returnPreviewRequests).toHaveLength(2)
    expect(remote.returnSyncRequests).toEqual([{ receiptId: remote.returnPreviewValue.receiptId }])
  })

  it('shows a selectable command and branch ID when clipboard access fails', async () => {
    const remote = new FakeRemote()
    stubClipboard(vi.fn(async () => { throw new Error('clipboard denied') }))
    const model = new ReturnClientModel(remote)
    const { fireEvent, render, screen, waitFor } = rtl!
    render(React.createElement(ReturnHeaderAction, { model, sessionId: 'dsh-current-session' }))
    fireEvent.click(screen.getByRole('button', { name: en.returnAction }))
    await waitFor(() => expect(screen.getByRole('button', { name: en.returnSync })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: en.returnSync }))
    await waitFor(() => expect(screen.getByRole('button', { name: en.returnCopyCommand })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: en.returnCopyCommand }))

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', en.returnCopyFailed)
    const command = screen.getByLabelText(en.returnSelectCommand) as HTMLInputElement
    expect(command.value).toBe('codex.exe resume fork-created-1')
    expect(command.closest('details')?.open).toBe(true)
    expect(screen.getByText('fork-created-1')).toBeTruthy()
  })

  it('keeps an unknown outcome visibly uncertain and offers no resend or success command', async () => {
    const remote = new FakeRemote()
    remote.returnSyncValue = {
      status: 'unknown', receiptId: 'receipt-uncertain', sourceThreadId: 'source-thread-1',
      codexForkId: 'fork-maybe-created', retry: 'reconcile-only',
    }
    const model = new ReturnClientModel(remote)
    const { fireEvent, render, screen, waitFor } = rtl!
    render(React.createElement(ReturnHeaderAction, { model, sessionId: 'dsh-current-session' }))
    fireEvent.click(screen.getByRole('button', { name: en.returnAction }))
    await waitFor(() => expect(screen.getByRole('button', { name: en.returnSync })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: en.returnSync }))

    const alert = await waitFor(() => screen.getByRole('alert'))
    expect(alert.textContent).toContain(en.returnUnknown)
    expect(alert.textContent).toContain(en.returnUnknownGuidance)
    expect(screen.queryByRole('button', { name: en.returnCopyCommand })).toBeNull()
    expect(screen.queryByText(en.returnCreated)).toBeNull()
    expect(screen.queryByRole('button', { name: en.returnSync })).toBeNull()
    expect(remote.returnSyncRequests).toHaveLength(1)
  })

  it('renders Chinese copy and mobile reduced-motion styles', async () => {
    const model = new ReturnClientModel(new FakeRemote())
    const chinese = (key: string): string | undefined => (zh as Readonly<Record<string, string>>)[key]
    const { render, screen } = rtl!
    render(React.createElement(ReturnHeaderAction, { model, sessionId: 'dsh-current-session', locale: chinese }))

    expect(screen.getByRole('button', { name: zh.returnAction })).toBeTruthy()
    const css = document.querySelector('style[data-dsh-codex-return-style="true"]')?.textContent ?? ''
    expect(css).toContain('@media(max-width:560px)')
    expect(css).toContain('@media(prefers-reduced-motion:reduce)')
    expect(css).toContain('safe-area-inset-bottom')
  })
})
