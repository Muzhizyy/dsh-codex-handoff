import path from 'node:path'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { zstdCompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { codexRoots } from '../../src/codex/home.js'
import { CodexLogicalThreadResolver, CodexSessionSource } from '../../src/codex/resolver.js'
import { fingerprintFile } from '../../src/codex/parser.js'
import { DEFAULT_LIMITS } from '../../src/shared/limits.js'
import { NormalizedSessionSchema } from '../../src/shared/schemas.js'

const fixture = (name: string) => path.resolve('tests/fixtures/codex', name)

describe('Codex discovery and logical resolver', () => {
  it('discovers a stable logical thread with index title and opaque handle', async () => {
    const source = new CodexSessionSource(codexRoots(fixture('normal')))
    const rolloutPath = path.join(fixture('normal'), 'sessions', '2026', '09', '05', 'rollout-2026-09-05T10-00-00-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl')
    const before = await fingerprintFile(rolloutPath)
    const page = await source.discover({ archived: 'all', limit: 50, includeMessageIndex: false })
    const after = await fingerprintFile(rolloutPath)
    expect(after).toBe(before)
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.title).toBe('Synthetic inspection')
    expect(page.items[0]?.discoveryId).toMatch(/^cx1\./)
    const loaded = await source.load({ ...page.items[0]!, source: 'codex', expectedFingerprint: page.items[0]!.fingerprint })
    expect(() => NormalizedSessionSchema.parse(loaded)).not.toThrow()
    expect(loaded.schemaVersion).toBe(2)
    expect(loaded.source.sessionId).toBe('thread-normal')
    expect(loaded.timeline.some(item => item.kind === 'tool-result')).toBe(true)
    expect(loaded.timeline.filter(item => item.kind === 'lifecycle' && item.lifecycle.type === 'step-start')).toHaveLength(2)
  })

  it('redacts discovery titles and preview snippets at the source boundary', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-redaction-'))
    try {
      const directory = path.join(root, 'sessions', '2026', '09', '05')
      await fs.mkdir(directory, { recursive: true })
      const rollout = path.join(directory, 'rollout-redaction.jsonl')
      const awsKey = 'AKIAABCDEFGHIJKLMNOP'
      const rawTitle = `Import ${awsKey} Bearer title-secret`
      const rawMessage = `message ${awsKey} Bearer preview-secret`
      const lines = [
        { timestamp: '2026-09-05T10:00:00.000Z', ordinal: 0, type: 'session_meta', payload: { id: 'thread-redaction', cwd: 'C:/safe/project', timestamp: '2026-09-05T10:00:00.000Z' } },
        { timestamp: '2026-09-05T10:00:01.000Z', ordinal: 1, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: rawMessage }] } },
        { timestamp: '2026-09-05T10:00:02.000Z', ordinal: 2, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: rawMessage }] } },
      ]
      await fs.writeFile(rollout, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`, 'utf8')
      await fs.writeFile(path.join(root, 'session_index.jsonl'), `${JSON.stringify({ id: 'thread-redaction', thread_name: rawTitle })}\n`, 'utf8')
      const source = new CodexSessionSource(codexRoots(root))
      const page = await source.discover({ archived: 'all', limit: 50, includeMessageIndex: false })
      const item = page.items[0]!
      expect(item.title).toContain('[REDACTED]')
      expect(item.title).not.toContain(awsKey)
      expect(item.title).not.toContain('title-secret')
      const preview = await source.preview({ ...item, source: 'codex' })
      expect(preview.source.title).not.toContain(awsKey)
      expect(preview.snippets).toHaveLength(2)
      expect(preview.snippets.every(snippet => snippet.redacted)).toBe(true)
      expect(preview.snippets.every(snippet => !snippet.text.includes(awsKey) && !snippet.text.includes('preview-secret'))).toBe(true)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('keeps an opaque cursor valid across pages and rejects forged handles', async () => {
    const source = new CodexSessionSource(codexRoots(fixture('normal')))
    const first = await source.discover({ archived: 'all', limit: 1, includeMessageIndex: false })
    expect(first.nextCursor).toBeUndefined()
    await expect(source.load({ ...first.items[0]!, discoveryId: `${first.items[0]!.discoveryId}x` })).rejects.toMatchObject({ code: 'SOURCE_STALE' })
  })

  it('cuts and recursively resolves history-base prefixes', async () => {
    const resolver = new CodexLogicalThreadResolver(codexRoots(fixture('history')))
    const inventory = await resolver.inventory()
    const head = inventory.find(item => item.revisionId.includes('head'))
    expect(head).toBeDefined()
    const resolved = await resolver.resolveDescriptor(head!)
    expect(resolved.session.source.sessionId).toBe('thread-history')
    expect(resolved.session.timeline.filter(item => item.kind === 'message').map(item => item.text)).toEqual(['Original objective', 'Original response', 'Continue after revert', 'New response'])
    expect(resolved.session.lineage.some(item => item.relation === 'history-base')).toBe(true)
  })

  it('cuts referenced base records before normalization while retaining the head suffix', async () => {
    const resolver = new CodexLogicalThreadResolver(codexRoots(fixture('history-cross')))
    const inventory = await resolver.inventory()
    const head = inventory.find(item => item.revisionId === 'cross-head')
    expect(head).toBeDefined()
    const resolved = await resolver.resolveDescriptor(head!)
    const text = resolved.session.timeline.filter(item => item.kind === 'message').map(item => item.text)
    expect(text).toEqual(['Cross rollout objective', 'Head suffix'])
    expect(resolved.session.timeline.some(item => item.kind === 'tool-call' && item.callId === 'cross-call')).toBe(true)
    expect(resolved.session.timeline.some(item => item.kind === 'tool-result' && item.callId === 'cross-call' && item.content === 'cross result')).toBe(true)
    expect(resolved.session.timeline.some(item => item.kind === 'annotation' && item.category === 'incomplete-tool')).toBe(false)
    expect(resolved.session.completeness.danglingToolCalls).toBe(0)
  })

  it('rolls back multiple turns across a history-base boundary', async () => {
    const resolver = new CodexLogicalThreadResolver(codexRoots(fixture('history-rollback')))
    const inventory = await resolver.inventory()
    const head = inventory.find(item => item.revisionId === 'head')
    const resolved = await resolver.resolveDescriptor(head!)
    expect(resolved.session.timeline.filter(item => item.kind === 'message').map(item => item.text)).toEqual(['Keep this instruction', 'Keep this response'])
    const rollback = resolved.session.timeline.find(item => item.kind === 'lifecycle' && item.lifecycle.type === 'rollback')
    expect(rollback?.kind === 'lifecycle' && rollback.lifecycle.type === 'rollback' ? rollback.lifecycle.removedUserTurns : 0).toBe(2)
    expect(() => NormalizedSessionSchema.parse(resolved.session)).not.toThrow()
  })

  it('reports missing, cyclic, depth, and file-limited history without reading past caps', async () => {
    const resolver = new CodexLogicalThreadResolver(codexRoots(fixture('history-failures')))
    const inventory = await resolver.inventory()
    const missing = await resolver.resolveDescriptor(inventory.find(item => item.revisionId === 'head-missing')!)
    expect(missing.session.diagnostics.some(item => item.code === 'CODEX_HISTORY_PARTIAL')).toBe(true)
    const cycle = await resolver.resolveDescriptor(inventory.find(item => item.revisionId === 'cycle-a')!)
    expect(cycle.session.diagnostics.some(item => item.code === 'CODEX_HISTORY_CORRUPT')).toBe(true)
    const depth = await resolver.resolveDescriptor(inventory.find(item => item.revisionId === 'depth-head')!, undefined, { ...DEFAULT_LIMITS, chainDepth: 2 })
    expect(depth.session.diagnostics.some(item => item.code === 'CODEX_HISTORY_PARTIAL')).toBe(true)
    const files = await resolver.resolveDescriptor(inventory.find(item => item.revisionId === 'depth-head')!, undefined, { ...DEFAULT_LIMITS, chainFiles: 1 })
    expect(files.session.diagnostics.some(item => item.code === 'CODEX_HISTORY_PARTIAL')).toBe(true)
  })

  it('selects valid zstd when a coexisting plain representation is truncated', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-representation-'))
    const directory = path.join(root, 'sessions', '2026', '09', '05')
    await fs.mkdir(directory, { recursive: true })
    const plain = path.join(directory, 'rollout-representation.jsonl')
    const zstd = `${plain}.zst`
    const complete = [
      '{"type":"session_meta","ordinal":0,"payload":{"id":"thread-representation"}}',
      '{"type":"response_item","ordinal":1,"payload":{"type":"message","role":"user","content":"zstd winner"}}',
    ].join('\n') + '\n'
    await fs.writeFile(plain, `${complete}{"type":"response_item"`, 'utf8')
    await fs.writeFile(zstd, zstdCompressSync((globalThis as any).Buffer.from(complete)))
    const resolver = new CodexLogicalThreadResolver(codexRoots(root))
    const inventory = await resolver.inventory()
    expect(inventory).toHaveLength(1)
    expect(inventory[0]?.representation).toBe('jsonl.zst')
    expect(inventory[0]?.parsed?.health).toBe('complete')
    const loaded = await resolver.resolveDescriptor(inventory[0]!)
    expect(loaded.session.timeline.some(item => item.kind === 'message' && item.text === 'zstd winner')).toBe(true)
    await fs.rm(root, { recursive: true, force: true })
  })

  it('stops zstd decompression at the aggregate byte budget', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-zstd-budget-'))
    const directory = path.join(root, 'sessions', '2026', '09', '05')
    await fs.mkdir(directory, { recursive: true })
    const file = path.join(directory, 'rollout-zstd-budget.jsonl.zst')
    const payload = [
      '{"type":"session_meta","ordinal":0,"payload":{"id":"thread-zstd-budget"}}',
      ...Array.from({ length: 100 }, (_, index) => `{"type":"response_item","ordinal":${index + 1},"payload":{"type":"message","role":"assistant","content":"${'x'.repeat(256)}"}}`),
    ].join('\n') + '\n'
    await fs.writeFile(file, zstdCompressSync((globalThis as any).Buffer.from(payload)))
    const limits = { ...DEFAULT_LIMITS, chainDecompressedBytes: 128, sourceFileBytes: 128 }
    const resolver = new CodexLogicalThreadResolver({ roots: codexRoots(root), limits })
    const [descriptor] = await resolver.inventory()
    expect(descriptor?.parsed?.decompressedBytes).toBeLessThanOrEqual(128)
    expect(descriptor?.parsed?.diagnostics.some(item => item.code === 'CODEX_LIMIT_EXCEEDED')).toBe(true)
    await fs.rm(root, { recursive: true, force: true })
  })

  it('uses caller limits for load and UTF-8 byte bounds for preview', async () => {
    const source = new CodexSessionSource(codexRoots(fixture('normal')))
    const page = await source.discover({ archived: 'all', limit: 50, includeMessageIndex: false })
    const item = page.items[0]!
    const limits = { ...DEFAULT_LIMITS, normalizedTextBytes: 64, previewSnippetBytes: 5 }
    const preview = await source.preview({ ...item, source: 'codex' }, limits)
    expect(preview.snippets.every(snippet => new TextEncoder().encode(snippet.text).byteLength <= 5)).toBe(true)
  })

  it('emits schema-valid v2 lifecycle and rollback boundaries from raw history', async () => {
    const resolver = new CodexLogicalThreadResolver(codexRoots(fixture('rollback')))
    const [descriptor] = await resolver.inventory()
    const resolved = await resolver.resolveDescriptor(descriptor!)
    expect(resolved.session.schemaVersion).toBe(2)
    expect(() => NormalizedSessionSchema.parse(resolved.session)).not.toThrow()
    const rollback = resolved.session.timeline.find(item => item.kind === 'lifecycle' && item.lifecycle.type === 'rollback')
    expect(rollback?.kind).toBe('lifecycle')
    expect(rollback?.kind === 'lifecycle' && rollback.lifecycle.type === 'rollback' ? rollback.lifecycle.removedBoundaryIds : []).toHaveLength(1)
    const rollbackOrder = rollback?.order ?? Number.MAX_SAFE_INTEGER
    expect(resolved.session.timeline.slice(0, rollbackOrder).some(item => item.kind === 'lifecycle' && item.lifecycle.type === 'turn-end' && item.lifecycle.outcome.kind === 'unknown')).toBe(false)
    const texts = resolved.session.timeline.filter(item => item.kind === 'message').map(item => item.text)
    expect(texts).toEqual(['Surviving instruction', 'Surviving response'])
    expect(resolved.session.timeline.some(item => item.kind === 'lifecycle' && item.lifecycle.type === 'turn-end' && item.lifecycle.outcome.kind === 'completed')).toBe(true)
  })

  it('fails closed when rollback history contains compaction replacement data', async () => {
    const resolver = new CodexLogicalThreadResolver(codexRoots(fixture('rollback-compaction')))
    const [descriptor] = await resolver.inventory()
    const resolved = await resolver.resolveDescriptor(descriptor!)
    expect(resolved.session.diagnostics.some(item => item.code === 'CODEX_FORMAT_UNSUPPORTED')).toBe(true)
    expect(() => NormalizedSessionSchema.parse(resolved.session)).not.toThrow()
  })

  it('derives strict lifecycle outcomes for complete, aborted, and end-of-log turns', async () => {
    const resolver = new CodexLogicalThreadResolver(codexRoots(fixture('lifecycle')))
    const [descriptor] = await resolver.inventory()
    const resolved = await resolver.resolveDescriptor(descriptor!)
    expect(() => NormalizedSessionSchema.parse(resolved.session)).not.toThrow()
    const outcomes = resolved.session.timeline
      .map(item => item.kind === 'lifecycle' && item.lifecycle.type === 'turn-end' ? item.lifecycle.outcome.kind : undefined)
      .filter((item): item is 'completed' | 'failed' | 'aborted' | 'interrupted' | 'unknown' => item !== undefined)
    expect(outcomes).toEqual(['completed', 'aborted', 'failed', 'interrupted'])
  })

  it('keeps ambient recommended-plugin context inside the explicit Codex turn', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-context-turn-'))
    try {
      const directory = path.join(root, 'sessions', '2026', '09', '05')
      await fs.mkdir(directory, { recursive: true })
      const file = path.join(directory, 'rollout-context-turn.jsonl')
      const records = [
        { timestamp: '2026-09-05T05:00:00.000Z', ordinal: 0, type: 'session_meta', payload: { id: 'thread-context-turn', timestamp: '2026-09-05T05:00:00.000Z' } },
        { timestamp: '2026-09-05T05:00:01.000Z', ordinal: 1, type: 'event_msg', payload: { type: 'turn_started', turn_id: 'turn-context' } },
        { timestamp: '2026-09-05T05:00:02.000Z', ordinal: 2, type: 'response_item', payload: { type: 'message', role: 'user', content: '<recommended_plugins>\n- Example\n</recommended_plugins>' } },
        { timestamp: '2026-09-05T05:00:03.000Z', ordinal: 3, type: 'response_item', payload: { type: 'message', role: 'user', content: 'Install the harness' } },
        { timestamp: '2026-09-05T05:00:04.000Z', ordinal: 4, type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'Installed' } },
        { timestamp: '2026-09-05T05:00:05.000Z', ordinal: 5, type: 'event_msg', payload: { type: 'turn_complete', turn_id: 'turn-context' } },
      ]
      await fs.writeFile(file, records.map(record => JSON.stringify(record)).join('\n') + '\n')
      const resolver = new CodexLogicalThreadResolver(codexRoots(root))
      const [descriptor] = await resolver.inventory()
      const resolved = await resolver.resolveDescriptor(descriptor!)
      expect(() => NormalizedSessionSchema.parse(resolved.session)).not.toThrow()
      const starts = resolved.session.timeline.filter(item => item.kind === 'lifecycle' && item.lifecycle.type === 'turn-start')
      const ends = resolved.session.timeline.filter(item => item.kind === 'lifecycle' && item.lifecycle.type === 'turn-end')
      expect(starts).toHaveLength(1)
      expect(ends).toHaveLength(1)
      expect(starts[0]?.kind === 'lifecycle' && starts[0].lifecycle.type === 'turn-start' ? starts[0].lifecycle.turnId : undefined).toBe('turn-context')
      expect(ends[0]?.kind === 'lifecycle' && ends[0].lifecycle.type === 'turn-end' ? ends[0].lifecycle.outcome.kind : undefined).toBe('completed')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('prefers active storage for the same rollout revision and marks the duplicate ambiguous', async () => {
    const resolver = new CodexLogicalThreadResolver(codexRoots(fixture('active-archive-duplicate')))
    const inventory = await resolver.inventory()
    expect(inventory).toHaveLength(2)
    const resolved = await resolver.resolveLogicalThread('thread-duplicate')
    expect(resolved.session.timeline.some(item => item.kind === 'message' && item.text === 'Active copy')).toBe(true)
    expect(resolved.session.timeline.some(item => item.kind === 'message' && item.text === 'Archived copy')).toBe(false)
    const source = new CodexSessionSource(codexRoots(fixture('active-archive-duplicate')))
    const page = await source.discover({ archived: 'all', limit: 50, includeMessageIndex: false })
    expect(page.items[0]?.parseHealth).toBe('partial')
  })
})
