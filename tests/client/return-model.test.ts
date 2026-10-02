import { describe, expect, it } from 'vitest'
import { ReturnClientModel } from '../../src/client/return-model.js'
import { FakeRemote } from '../fixtures/client/remote.js'

describe('ReturnClientModel', () => {
  it('previews only the DSH session injected by the current header', async () => {
    const remote = new FakeRemote()
    remote.returnPreviewValue = {
      ...remote.returnPreviewValue,
      source: { ...remote.returnPreviewValue.source, dshSessionId: 'dsh-current-session' },
    }
    const model = new ReturnClientModel(remote)

    await model.open('dsh-current-session')

    expect(remote.returnPreviewRequests).toEqual([{ dshSessionId: 'dsh-current-session' }])
    expect(model.getState()).toMatchObject({
      phase: 'ready',
      dshSessionId: 'dsh-current-session',
      preview: { source: { dshSessionId: 'dsh-current-session' } },
    })
    expect(remote.returnSyncRequests).toEqual([])
  })

  it('surfaces an invalid source as an actionable localized error state', async () => {
    const remote = new FakeRemote()
    remote.returnPreview = async request => {
      remote.returnPreviewRequests.push(request)
      throw { code: 'RETURN_SOURCE_METADATA_MISSING', message: 'source lookup failed' }
    }
    const model = new ReturnClientModel(remote)

    await model.open('dsh-unlinked-session')

    expect(model.getState()).toMatchObject({
      phase: 'error',
      error: { code: 'RETURN_SOURCE_METADATA_MISSING', canRefresh: true },
    })
    expect(remote.returnSyncRequests).toHaveLength(0)
  })

  it('refreshes stale receipts and dispatches only the new receipt', async () => {
    const remote = new FakeRemote()
    remote.returnSync = async request => {
      remote.returnSyncRequests.push(request)
      if (remote.returnSyncRequests.length === 1) throw { code: 'RETURN_STALE', message: 'stale' }
      return remote.returnSyncValue
    }
    const model = new ReturnClientModel(remote)
    await model.open('dsh-session-1')
    await model.sync()
    expect(model.getState()).toMatchObject({ phase: 'error', error: { code: 'RETURN_STALE', canRefresh: true } })

    remote.returnPreviewValue = { ...remote.returnPreviewValue, receiptId: 'receipt-refreshed' }
    await model.refreshPreview()
    await model.sync()

    expect(remote.returnPreviewRequests).toEqual([{ dshSessionId: 'dsh-session-1' }, { dshSessionId: 'dsh-session-1' }])
    expect(remote.returnSyncRequests).toEqual([{ receiptId: 'receipt-test-1' }, { receiptId: 'receipt-refreshed' }])
    expect(model.getState().phase).toBe('success')
  })

  it('shares one in-flight sync and sends only the opaque receipt ID', async () => {
    const remote = new FakeRemote()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    remote.returnSync = async request => {
      remote.returnSyncRequests.push(request)
      await gate
      return remote.returnSyncValue
    }
    const model = new ReturnClientModel(remote)
    await model.open('dsh-session-1')

    const first = model.sync()
    const second = model.sync()
    expect(first).toBe(second)
    expect(model.getState().phase).toBe('syncing')
    await Promise.resolve()
    expect(remote.returnSyncRequests).toEqual([{ receiptId: 'receipt-test-1' }])
    release()
    await first
    expect(model.getState().phase).toBe('success')
    expect(remote.returnSyncRequests).toHaveLength(1)
  })

  it('preserves unknown as a terminal state with no blind resend', async () => {
    const remote = new FakeRemote()
    remote.returnSyncValue = {
      status: 'unknown',
      receiptId: 'receipt-test-1',
      sourceThreadId: 'source-thread-1',
      codexForkId: 'fork-uncertain-1',
      retry: 'reconcile-only',
    }
    const model = new ReturnClientModel(remote)
    await model.open('dsh-session-1')
    await model.sync()
    await model.sync()

    expect(model.getState().phase).toBe('unknown')
    expect(remote.returnSyncRequests).toEqual([{ receiptId: 'receipt-test-1' }])
  })

  it('handles remotes that throw before returning a promise', async () => {
    const remote = new FakeRemote()
    remote.returnPreview = (() => { throw { code: 'RETURN_SOURCE_METADATA_MISSING' } }) as typeof remote.returnPreview
    const model = new ReturnClientModel(remote)
    await expect(model.open('dsh-unlinked-session')).resolves.toBeUndefined()
    expect(model.getState()).toMatchObject({ phase: 'error', error: { code: 'RETURN_SOURCE_METADATA_MISSING' } })

    remote.returnPreview = FakeRemote.prototype.returnPreview.bind(remote)
    await model.refreshPreview()
    remote.returnSync = (() => { throw { code: 'RETURN_STALE' } }) as typeof remote.returnSync
    await expect(model.sync()).resolves.toBeUndefined()
    expect(model.getState()).toMatchObject({ phase: 'error', error: { code: 'RETURN_STALE', canRefresh: true } })
  })

  it('ignores late clipboard completion after the preview has been replaced', async () => {
    const remote = new FakeRemote()
    const model = new ReturnClientModel(remote)
    await model.open('dsh-session-1')
    await model.sync()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const copying = model.copyResumeCommand(async () => { await gate })

    model.close()
    await model.open('dsh-session-2')
    release()
    await copying

    expect(model.getState()).toMatchObject({ phase: 'ready', dshSessionId: 'dsh-session-2', copied: false, copyFailed: false })
  })

  it('ignores a preview that resolves after cancel', async () => {
    const remote = new FakeRemote()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    remote.returnPreview = async request => {
      remote.returnPreviewRequests.push(request)
      await gate
      return remote.returnPreviewValue
    }
    const model = new ReturnClientModel(remote)
    const pending = model.open('dsh-session-1')
    await Promise.resolve()
    model.close()
    release()
    await pending

    expect(remote.returnPreviewRequests).toEqual([{ dshSessionId: 'dsh-session-1' }])
    expect(model.getState()).toMatchObject({ phase: 'closed' })
  })

  it('disposes without applying a late sync result', async () => {
    const remote = new FakeRemote()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    remote.returnSync = async request => {
      remote.returnSyncRequests.push(request)
      await gate
      return remote.returnSyncValue
    }
    const model = new ReturnClientModel(remote)
    await model.open('dsh-session-1')
    const pending = model.sync()
    await Promise.resolve()
    expect(remote.returnSyncRequests).toEqual([{ receiptId: 'receipt-test-1' }])
    model.dispose()
    release()
    await pending

    expect(model.getState()).toMatchObject({ phase: 'closed' })
  })
})
