import { resolve } from 'node:path'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'

import { CodexSessionSource } from '../../src/codex/resolver.js'
import { GitRepositoryInspector } from '../../src/repo/inspector.js'
import { SmartHandoffEngine } from '../../src/handoff/engine.js'
import { canonicalWorkspace, CodexHandoffRemoteService, HOST_REMOTE_METHODS } from '../../src/host/remote.js'
import { HandoffClientModel } from '../../src/client/model.js'
import { FakeSessions } from '../fixtures/client/remote.js'
import type { DshSessionGateway } from '../../src/dsh/gateway.js'
import type { SessionSource } from '../../src/shared/ports.js'

function fixtureSource(): SessionSource {
  const root = resolve(process.cwd(), 'tests/fixtures/codex/normal')
  const source = new CodexSessionSource({
    home: root,
    sessions: resolve(root, 'sessions'),
    archivedSessions: resolve(root, 'archived_sessions'),
    sessionIndex: resolve(root, 'session_index.jsonl'),
  })
  // The fixture intentionally contains a synthetic cwd. Bind it to an
  // existing workspace for strict fail-closed realpath/stat tests.
  const cwd = process.cwd()
  return {
    kind: 'codex',
    discover: async (query, signal) => {
      const page = await source.discover(query, signal)
      return { ...page, items: page.items.map(item => ({ ...item, cwd })) }
    },
    preview: async (ref, limits, signal) => {
      const preview = await source.preview(ref, limits, signal)
      return { ...preview, source: { ...preview.source, cwd } }
    },
    load: async (ref, limits, signal) => {
      const loaded = await source.load(ref, limits, signal)
      return { ...loaded, source: { ...loaded.source, cwd } }
    },
  }
}

function gateway(): DshSessionGateway {
  return {
    compatibility: () => ({
      compatible: true,
      required: {
        agents: true, agentDefaultModel: true, sessionQuery: true,
        sessionPersistence: true, workspaceRegistry: true, storageDomain: true, typert: true,
      },
      optional: { llm: false, agentPresets: false, conversationSessionHeaderActions: false, settingsSection: false },
      diagnostics: [],
      checkedAt: new Date().toISOString(),
    }),
    find: vi.fn(async () => undefined),
    create: vi.fn(async () => ({ state: 'created' as const, sessionId: 'destination-1', workspaceAttached: true, warnings: [] })),
  } as unknown as DshSessionGateway
}

describe('CodexHandoffRemoteService', () => {
  it('fails closed when the canonical cwd disappears or is replaced', async () => {
    const parent = await mkdtemp(resolve(tmpdir(), 'dsh-cwd-check-'))
    const original = resolve(parent, 'original')
    const replacement = resolve(parent, 'replacement')
    await mkdir(original)
    await mkdir(replacement)
    await expect(canonicalWorkspace(original, original)).resolves.toBeTruthy()
    await rm(original, { recursive: true, force: true })
    await expect(canonicalWorkspace(original, original)).rejects.toMatchObject({ code: 'CWD_NOT_FOUND' })
    await rm(parent, { recursive: true, force: true })
  })

  it('exposes exactly the seven runtime-validated endpoints and rejects forged handles', async () => {
    expect(HOST_REMOTE_METHODS).toEqual(['compatibility', 'discover', 'preview', 'analyze', 'create', 'returnPreview', 'returnSync'])
    const remote = new CodexHandoffRemoteService({
      source: fixtureSource(),
      repository: new GitRepositoryInspector(),
      engine: new SmartHandoffEngine(),
      gateway: gateway(),
    })
    await expect(remote.compatibility()).resolves.toMatchObject({ compatible: true })
    const page = await remote.discover({ archived: 'all', limit: 10, includeMessageIndex: false })
    expect(page.items).toHaveLength(1)
    const item = page.items[0]
    if (item === undefined || item.cwd === undefined) throw new Error('fixture did not produce a trusted cwd')
    const ref = {
      discoveryId: item.discoveryId,
      source: item.source,
      sessionId: item.sessionId,
      rolloutRevisionId: item.rolloutRevisionId,
      expectedFingerprint: item.fingerprint,
      archived: item.archived,
    }
    await expect(remote.preview({ source: ref })).resolves.toMatchObject({ source: { sessionId: item.sessionId } })
    await expect(remote.discover({ archived: 'all', limit: 10, includeMessageIndex: false })).resolves.toHaveProperty('items.0.discoveryId', item.discoveryId)
    await expect(remote.preview({ source: { ...ref, discoveryId: `${item.discoveryId}-forged` } })).rejects.toMatchObject({ code: 'SOURCE_STALE' })
    await expect(remote.discover({ archived: 'all', limit: 10, includeMessageIndex: false, unknown: true } as never)).rejects.toMatchObject({ code: 'DSH_SEED_INVALID' })
  })

  it('re-redacts contaminated preview diagnostics and source types at the Remote boundary', async () => {
    const base = fixtureSource()
    const canary = 'Bearer remote-preview-canary'
    const source: SessionSource = {
      ...base,
      preview: async (ref, limits, signal) => {
        const preview = await base.preview(ref, limits, signal)
        return {
          ...preview,
          largestRecords: preview.largestRecords.map(item => ({ ...item, source: { ...item.source, type: canary } })),
          diagnostics: [{ code: canary, severity: 'warning', message: canary, record: { type: canary }, recoverable: true }],
        }
      },
    }
    const remote = new CodexHandoffRemoteService({ source, repository: new GitRepositoryInspector(), engine: new SmartHandoffEngine(), gateway: gateway() })
    const item = (await remote.discover({ archived: 'all', limit: 1, includeMessageIndex: false })).items[0]
    if (item === undefined) throw new Error('fixture did not produce a session')
    const preview = await remote.preview({ source: {
      discoveryId: item.discoveryId,
      source: item.source,
      sessionId: item.sessionId,
      rolloutRevisionId: item.rolloutRevisionId,
      expectedFingerprint: item.fingerprint,
      archived: item.archived,
    } })
    expect(JSON.stringify(preview)).not.toContain(canary)
    expect(preview.diagnostics[0]?.record?.type).toContain('[REDACTED]')
    expect(preview.largestRecords[0]?.source.type).toContain('[REDACTED]')
  })

  it('defensively redacts malicious alternate-source discovery pages', async () => {
    const base = fixtureSource()
    const canary = 'Bearer discover-page-canary'
    const source: SessionSource = {
      ...base,
      discover: async (query, signal) => {
        const page = await base.discover(query, signal)
        return { ...page, items: page.items.map(item => ({ ...item, title: canary, cwd: canary, cliVersion: canary })) }
      },
    }
    const remote = new CodexHandoffRemoteService({ source, repository: new GitRepositoryInspector(), engine: new SmartHandoffEngine(), gateway: gateway() })
    const page = await remote.discover({ archived: 'all', limit: 1, includeMessageIndex: false })
    expect(JSON.stringify(page)).not.toContain(canary)
    expect(page.items[0]?.title).toContain('[REDACTED]')
    expect(page.items[0]?.cwd).toContain('[REDACTED]')
  })

  it('canonicalizes the raw source cwd before redaction', async () => {
    const cwd = await mkdtemp(resolve(tmpdir(), 'Bearer remote-cwd-canary-'))
    try {
      const base = fixtureSource()
      const source: SessionSource = {
        ...base,
        preview: async (ref, limits, signal) => {
          const preview = await base.preview(ref, limits, signal)
          // Simulate a source adapter that has already redacted its preview
          // DTO. This path is deliberately not filesystem-resolvable.
          return { ...preview, source: { ...preview.source, cwd: 'C:/[REDACTED]' } }
        },
        load: async (ref, limits, signal) => {
          const loaded = await base.load(ref, limits, signal)
          return { ...loaded, source: { ...loaded.source, cwd } }
        },
      }
      const remote = new CodexHandoffRemoteService({ source, repository: new GitRepositoryInspector(), engine: new SmartHandoffEngine(), gateway: gateway() })
      const item = (await remote.discover({ archived: 'all', limit: 1, includeMessageIndex: false })).items[0]
      if (item === undefined) throw new Error('fixture did not produce a session')
      const preview = await remote.preview({ source: {
        discoveryId: item.discoveryId,
        source: item.source,
        sessionId: item.sessionId,
        rolloutRevisionId: item.rolloutRevisionId,
        expectedFingerprint: item.fingerprint,
        archived: item.archived,
      } })
      expect(preview.repository?.cwd.exists).toBe(true)
      expect(JSON.stringify(preview)).not.toContain('remote-cwd-canary')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('runs deterministic Smart analysis with bounded diagnostics and keeps request cwd tied to discovery', async () => {
    const remote = new CodexHandoffRemoteService({
      source: fixtureSource(),
      repository: new GitRepositoryInspector(),
      engine: new SmartHandoffEngine(),
      gateway: gateway(),
    })
    const page = await remote.discover({ archived: 'all', limit: 1, includeMessageIndex: false })
    const item = page.items[0]
    if (item === undefined || item.cwd === undefined) throw new Error('fixture did not produce a trusted cwd')
    const source = {
      discoveryId: item.discoveryId,
      source: item.source,
      sessionId: item.sessionId,
      rolloutRevisionId: item.rolloutRevisionId,
      expectedFingerprint: item.fingerprint,
      archived: item.archived,
    } as const
    const result = await remote.analyze({
      source,
      cwd: item.cwd,
      expectedFingerprint: item.fingerprint,
      useModel: false,
      consent: { disclosureVersion: 'smart-v1', accepted: true, acceptedMode: 'smart', modelAnalysis: false, fullPersistence: false },
    })
    expect(result.degraded).toBe(false)
    expect(result.source.discoveryId).toBe(item.discoveryId)
    await expect(remote.analyze({
      source,
      cwd: 'C:/forged/workspace',
      expectedFingerprint: item.fingerprint,
      useModel: false,
      consent: { disclosureVersion: 'smart-v1', accepted: true, acceptedMode: 'smart', modelAnalysis: false, fullPersistence: false },
    })).rejects.toMatchObject({ code: 'CWD_NOT_FOUND' })
  })

  it('round-trips a redacted Bearer cwd from Client model through Host analyze/create', async () => {
    const cwd = await mkdtemp(resolve(tmpdir(), 'Bearer client-token-canary-'))
    try {
      const base = fixtureSource()
      const source: SessionSource = {
        ...base,
        discover: async (query, signal) => {
          const page = await base.discover(query, signal)
          return { ...page, items: page.items.map(item => ({ ...item, cwd })) }
        },
        preview: async (ref, limits, signal) => {
          const preview = await base.preview(ref, limits, signal)
          return { ...preview, source: { ...preview.source, cwd } }
        },
        load: async (ref, limits, signal) => {
          const loaded = await base.load(ref, limits, signal)
          return { ...loaded, source: { ...loaded.source, cwd } }
        },
      }
      const inspected: string[] = []
      const captured: { cwd?: string } = {}
      const hostGateway = gateway()
      hostGateway.create = vi.fn(async request => {
        captured.cwd = request.cwd
        return { state: 'created' as const, sessionId: 'dsh-session-1', workspaceAttached: true, warnings: [] }
      })
      const remote = new CodexHandoffRemoteService({
        source,
        repository: { inspect: vi.fn(async inspectedCwd => {
          inspected.push(inspectedCwd)
          return { observedAt: new Date().toISOString(), cwd: { requested: inspectedCwd, canonical: inspectedCwd, exists: true }, relevantPaths: [], diagnostics: [] }
        }) } as never,
        engine: new SmartHandoffEngine(),
        gateway: hostGateway,
      })
      const model = new HandoffClientModel(remote, new FakeSessions())
      await model.open()
      const selected = model.getState().page?.items[0]
      if (selected === undefined || selected.cwd === undefined) throw new Error('redacted source cwd was not discovered')
      expect(selected.cwd).not.toContain('client-token-canary')
      model.select(selected)
      await model.previewSelected()
      model.acceptConsent()
      await model.analyzeSmart()
      expect(model.getState().degraded).toBe(true)
      await model.create()
      expect(captured.cwd).toBe(cwd)
      expect(inspected.length).toBeGreaterThanOrEqual(3)
      expect(inspected.every(item => item === cwd)).toBe(true)
      expect(JSON.stringify(model.getState())).not.toContain('client-token-canary')
      expect(JSON.stringify(model.getState())).not.toContain('Bearer client-token-canary')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
