import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { CodexSessionSource } from '../../src/codex/resolver.js'
import { apply, HOST_INJECT, runtimeFromContext } from '../../src/host/index.js'

function source(): CodexSessionSource {
  const root = resolve(process.cwd(), 'tests/fixtures/codex/normal')
  return new CodexSessionSource({
    home: root,
    sessions: resolve(root, 'sessions'),
    archivedSessions: resolve(root, 'archived_sessions'),
    sessionIndex: resolve(root, 'session_index.jsonl'),
  })
}

describe('Host composition root', () => {
  it('publishes the active codexHandoff binding and unwinds it', async () => {
    const provide = vi.fn()
    const effect = vi.fn()
    const ctx = {
      agents: { create: vi.fn() },
      agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
      sessionQuery: { inspect: vi.fn() },
      sessionPersistence: {},
      workspaceRegistry: { create: vi.fn() },
      storageDomain: {},
      typert: {},
      provide, effect,
    }
    const dispose = await apply(ctx, { source: source() })
    expect(HOST_INJECT).toContain('storageDomain')
    expect(HOST_INJECT).not.toContain('agentFactory')
    expect(HOST_INJECT).not.toContain('remote')
    const runtime = runtimeFromContext(ctx)
    expect(runtime).not.toHaveProperty('storageDomainScope')
    expect(runtime).not.toHaveProperty('slots')
    expect(runtime).not.toHaveProperty('remote')
    expect(provide).toHaveBeenCalledWith('codexHandoff', expect.objectContaining({ namespace: 'codexHandoff' }))
    expect(effect).toHaveBeenCalledOnce()
    await dispose()
  })
})
