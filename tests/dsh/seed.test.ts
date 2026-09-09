import { describe, expect, it } from 'vitest'

import type { CompiledContext, NormalizedSession } from '../../src/shared/index.js'
import { FullTrajectorySeedCompiler, SmartSeedCompiler } from '../../src/dsh/seed.js'

const source = {
  agent: 'codex' as const,
  sessionId: 'seed-source',
  rolloutRevisionId: 'seed-rollout',
  fingerprint: 'seed-fingerprint-123',
  updatedAt: '2026-01-01T00:00:00.000Z',
  archived: false,
}

function session(
  timeline: NormalizedSession['timeline'],
  diagnostics: NormalizedSession['diagnostics'] = [],
  sourceOverride: NormalizedSession['source'] = source,
): NormalizedSession {
  return {
    schemaVersion: 2,
    source: sourceOverride,
    lineage: [{ rolloutRevisionId: sourceOverride.rolloutRevisionId, relation: 'head', representation: 'jsonl' }],
    timeline: [
      { kind: 'lifecycle', id: 'turn-start-1', order: 0, lifecycle: { type: 'turn-start', turnId: 'turn-1', evidence: 'codex-turn-started' }, source: { locator: 'turn-start' } },
      { kind: 'lifecycle', id: 'step-start-1', order: 1, lifecycle: { type: 'step-start', turnId: 'turn-1', step: 1, evidence: 'derived-response-cycle' }, source: { locator: 'step-start' } },
      ...timeline.map((event, index) => ({ ...event, order: index + 2 })),
      { kind: 'lifecycle', id: 'step-end-1', order: timeline.length + 2, lifecycle: { type: 'step-end', turnId: 'turn-1', step: 1, evidence: 'derived-response-cycle' }, source: { locator: 'step-end' } },
      { kind: 'lifecycle', id: 'turn-end-1', order: timeline.length + 3, lifecycle: { type: 'turn-end', turnId: 'turn-1', outcome: { kind: 'completed', evidence: 'codex-turn-complete' } }, source: { locator: 'turn-end' } },
    ] as NormalizedSession['timeline'],
    diagnostics,
    completeness: {
      malformedLines: 0,
      unknownRecords: 0,
      droppedEncryptedBlocks: 0,
      danglingToolCalls: 0,
      orphanToolResults: 0,
      truncatedRecords: 0,
    },
  }
}

describe('DSH v2 seed compiler', () => {
  it('emits a balanced inert full trajectory with paired tool provenance', () => {
    const result = new FullTrajectorySeedCompiler({ includeNotice: false }).compileDetailed(session([
      { kind: 'message', id: 'u', order: 0, role: 'user', text: 'Continue', source: { locator: 'u' } },
      { kind: 'message', id: 'a', order: 1, role: 'assistant', text: 'Inspecting', source: { locator: 'a' } },
      { kind: 'tool-call', id: 'tc', order: 2, callId: 'call', name: 'read', argumentsText: '{}', source: { locator: 'tc' } },
      { kind: 'tool-result', id: 'tr', order: 3, callId: 'call', name: 'read', content: 'done', source: { locator: 'tr' } },
    ]))
    const seed = result.seed as Array<Record<string, unknown>>
    expect(seed.map(event => event.type)).toEqual([
      'turn/start', 'step/start', 'user/message', 'assistant/message', 'assistant/message', 'tool/call', 'tool/result', 'step/end', 'turn/end',
    ])
    expect(seed.map(event => event.seq)).toEqual(seed.map((_, index) => index))
    expect(seed.filter(event => event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result')
      .every(event => event.surfaceOp === 'append')).toBe(true)
    expect(seed.some(event => event.type === 'session/end-seed' || event.type === 'request/header')).toBe(false)
    const toolResult = seed.find(event => event.type === 'tool/result')
    expect(toolResult?.sourceEventSeqs).toEqual([5])

    const messageIds = seed.flatMap(event => {
      if (event.type === 'user/message') return [(event.data as { id: string }).id]
      if (event.type === 'assistant/message' || event.type === 'tool/result') {
        return [((event.data as { message: { id: string } }).message).id]
      }
      return []
    })
    expect(new Set(messageIds).size).toBe(messageIds.length)
    expect(messageIds.every(id => /^sha256-[a-f0-9]{64}$/.test(id))).toBe(true)
    expect(messageIds).not.toContain('[REDACTED]')

    const assistantToolCall = seed.find(event => event.type === 'assistant/message'
      && (((event.data as { message?: { content?: Array<{ type?: string }> } }).message?.content?.[0]?.type) === 'tool-call'))
    if (assistantToolCall === undefined) throw new Error('tool-call assistant message is missing')
    const assistantToolCallContent = (((assistantToolCall.data as { message: { content: Array<{ id: string }> } }).message).content)[0]
    if (assistantToolCallContent === undefined) throw new Error('tool-call content is missing')
    const emittedToolCall = seed.find(event => event.type === 'tool/call')
    if (emittedToolCall === undefined) throw new Error('tool/call event is missing')
    const emittedToolCallData = emittedToolCall.data as { callId: string }
    const emittedToolResult = seed.find(event => event.type === 'tool/result')?.data as {
      message: { content: Array<{ toolCallId: string }>; source: { callId: string } }
    } | undefined
    if (emittedToolResult === undefined) throw new Error('tool/result event is missing')
    expect(emittedToolCallData.callId).toMatch(/^sha256-[a-f0-9]{64}$/)
    expect(emittedToolCallData.callId).not.toBe('[REDACTED]')
    expect(assistantToolCallContent.id).toBe(emittedToolCallData.callId)
    expect(emittedToolResult.message.content[0]?.toolCallId).toBe(emittedToolCallData.callId)
    expect(emittedToolResult.message.source.callId).toBe(emittedToolCallData.callId)
  })

  it('preserves parser-downgraded incomplete actions as text and keeps a balanced turn', () => {
    const result = new FullTrajectorySeedCompiler({ includeNotice: false }).compileDetailed(session([
      { kind: 'message', id: 'u', order: 0, role: 'user', text: 'Continue', source: { locator: 'u' } },
      { kind: 'annotation', id: 'tc', order: 1, category: 'incomplete-tool', text: 'Historical tool call had no recorded result.', source: { locator: 'tc' } },
    ]))
    const seed = result.seed as Array<Record<string, unknown>>
    expect(seed.some(event => event.type === 'tool/call')).toBe(false)
    expect(seed.some(event => event.type === 'user/message')).toBe(true)
    expect(seed.at(-1)?.type).toBe('turn/end')
  })

  it('compiles Smart context into one inert user turn and honors the hash seam', () => {
    const context: CompiledContext = {
      text: 'objective and current state',
      source: {
        kind: 'plugin',
        plugin: 'dsh-threadbridge',
        sourceAgent: 'codex',
        sourceSessionId: 'seed-source',
        rolloutRevisionId: 'seed-rollout',
        fingerprint: 'seed-fingerprint-123',
        mode: 'smart',
        compilerSchema: '1.0.0',
        form: 'snapshot',
        sections: [{ name: 'Objective', text: 'objective and current state' }],
      },
      estimatedTokens: 5,
      estimator: 'fallback',
      omittedByBudget: {},
      diagnostics: [],
    }
    const seen: string[][] = []
    const seed = new SmartSeedCompiler({ hash: parts => { seen.push([...parts]); return 'hash' } }).compile(context)
    expect(seed.map(event => (event as { type: string }).type)).toEqual([
      'turn/start', 'step/start', 'user/message', 'step/end', 'turn/end',
    ])
    expect(seen).toHaveLength(1)
    expect((seed[2] as { data: { id: string } }).data.id).toBe('sha256-hash')

    const defaultSeed = new SmartSeedCompiler().compile(context)
    const defaultId = (defaultSeed[2] as { data: { id: string } }).data.id
    expect(defaultId).toMatch(/^sha256-[a-f0-9]{64}$/)
    expect(defaultId).not.toBe('[REDACTED]')
  })

  it('preserves trusted Full plugin identity while still redacting untrusted content', () => {
    const sourceWithOpaqueIds = {
      ...source,
      sessionId: '123e4567-e89b-12d3-a456-426614174000',
      rolloutRevisionId: '550e8400-e29b-41d4-a716-446655440000',
    }
    const canary = 'Bearer full-seed-canary-token'
    const result = new FullTrajectorySeedCompiler({ includeNotice: true }).compileDetailed(session([
      { kind: 'message', id: 'full-canary', order: 0, role: 'user', text: canary, source: { locator: canary } },
    ], [], sourceWithOpaqueIds))
    const serialized = JSON.stringify({ seed: result.seed, diagnostics: result.diagnostics })

    expect(serialized).toContain('"sourceSessionId":"123e4567-e89b-12d3-a456-426614174000"')
    expect(serialized).toContain('"rolloutRevisionId":"550e8400-e29b-41d4-a716-446655440000"')
    expect(serialized).not.toContain('full-seed-canary-token')
    expect(serialized).toContain('[REDACTED]')
  })

  it('preserves trusted Smart plugin identity while redacting snapshot content', () => {
    const sourceSessionId = '123e4567-e89b-12d3-a456-426614174000'
    const rolloutRevisionId = '550e8400-e29b-41d4-a716-446655440000'
    const canary = 'https://alice:smart-secret@example.test/path'
    const context: CompiledContext = {
      text: canary,
      source: {
        kind: 'plugin',
        plugin: 'dsh-threadbridge',
        sourceAgent: 'codex',
        sourceSessionId,
        rolloutRevisionId,
        fingerprint: 'seed-fingerprint-123',
        mode: 'smart',
        compilerSchema: '1.0.0',
        form: 'snapshot',
        sections: [{ name: 'Objective', text: canary }],
      },
      estimatedTokens: 5,
      estimator: 'fallback',
      omittedByBudget: {},
      diagnostics: [],
    }
    const result = new SmartSeedCompiler().compileDetailed(context)
    const serialized = JSON.stringify(result.seed)
    const smartSeed = result.seed as Array<Record<string, unknown>>
    const lifecycleData = smartSeed[0]?.data as Record<string, unknown>
    const messageData = smartSeed[2]?.data as Record<string, unknown>

    expect(serialized).toContain('"sourceSessionId":"123e4567-e89b-12d3-a456-426614174000"')
    expect(serialized).toContain('"rolloutRevisionId":"550e8400-e29b-41d4-a716-446655440000"')
    expect(lifecycleData.source).toBeUndefined()
    expect((messageData.source as Record<string, unknown>).sourceSessionId).toBe(sourceSessionId)
    expect(serialized).not.toContain('smart-secret')
    expect(serialized).not.toContain('example.test')
    expect(serialized).toContain('[REDACTED]')
  })

  it('deep-redacts every Full seed surface, metadata, and diagnostic before write', () => {
    const canary = 'https://alice:super-secret@example.test/path Bearer sk-live-secret AKIA1234567890ABCDEF'
    const result = new FullTrajectorySeedCompiler({ includeNotice: true }).compileDetailed(session([
      { kind: 'message', id: 'u-secret', order: 0, role: 'user', text: canary, source: { locator: canary } },
      { kind: 'reasoning-summary', id: 'r-secret', order: 1, text: `reasoning password: "${canary}"`, source: { locator: 'r' } },
      { kind: 'tool-call', id: 'tc-secret', order: 2, callId: 'call-secret', name: 'read', argumentsText: JSON.stringify({ token: canary }), source: { locator: 'tc' } },
      { kind: 'tool-result', id: 'tr-secret', order: 3, callId: 'call-secret', name: 'read', content: `result=${canary}`, source: { locator: 'tr' } },
      { kind: 'annotation', id: 'a-secret', order: 4, category: 'unsupported', text: `annotation: ${canary}`, source: { locator: 'a' } },
    ], [{ code: 'secret-diagnostic', severity: 'warning', message: canary, recoverable: true }]))
    const serialized = JSON.stringify({ seed: result.seed, diagnostics: result.diagnostics })
    expect(serialized).not.toContain('super-secret')
    expect(serialized).not.toContain('sk-live-secret')
    expect(serialized).not.toContain('AKIA1234567890ABCDEF')
    expect(serialized).not.toContain('example.test')
    expect(serialized).toContain('[REDACTED]')
  })
})
