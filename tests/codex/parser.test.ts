import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parseRollout, parseRolloutFile } from '../../src/codex/parser.js'

async function stream(text: string): Promise<AsyncIterable<string>> {
  return (async function* (): AsyncGenerator<string> {
    for (const part of [text.slice(0, 17), text.slice(17)]) yield part
  })()
}

describe('Codex tolerant parser', () => {
  it('uses the first metadata and pairs function calls without parsing arguments', async () => {
    const source = [
      '{"type":"session_meta","ordinal":0,"payload":{"id":"thread-1","cwd":"C:/project","timestamp":"2026-09-05T00:00:00.000Z"}}',
      '{"type":"session_meta","ordinal":1,"payload":{"id":"wrong"}}',
      '{"type":"response_item","ordinal":2,"payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}}',
      '{"type":"response_item","ordinal":3,"payload":{"type":"function_call","name":"run","arguments":"{\\"x\\":1}","call_id":"c1"}}',
      '{"type":"response_item","ordinal":4,"payload":{"type":"function_call_output","call_id":"c1","output":"ok"}}',
      '{"type":"unknown","ordinal":5,"payload":{}}',
      'not-json',
    ].join('\n')
    const result = await parseRollout(await stream(source), { revisionId: 'rev-1' })
    expect(result.metadata?.id).toBe('thread-1')
    expect(result.timeline.map(item => item.kind)).toEqual(['message', 'tool-call', 'tool-result'])
    expect(result.completeness.malformedLines).toBe(1)
    expect(result.completeness.unknownRecords).toBe(1)
    expect(result.health).toBe('partial')
    expect(result.diagnostics.some(item => item.message.includes('first metadata'))).toBe(true)
  })

  it('downgrades dangling calls and drops encrypted reasoning', async () => {
    const source = [
      '{"type":"session_meta","payload":{"id":"thread-2"}}',
      '{"type":"response_item","payload":{"type":"reasoning","summary":[{"type":"encrypted_content","data":"secret"}]}}',
      '{"type":"response_item","payload":{"type":"custom_tool_call","name":"danger","arguments":"{}","call_id":"dangling"}}',
    ].join('\n')
    const result = await parseRollout(await stream(source), { revisionId: 'rev-2' })
    expect(result.completeness.droppedEncryptedBlocks).toBe(1)
    expect(result.completeness.danglingToolCalls).toBe(1)
    const last = result.timeline.at(-1)
    expect(last?.kind).toBe('annotation')
    expect(last?.kind === 'annotation' ? last.text : '').toContain('not executed')
  })

  it('stops at configured line and record bounds while retaining diagnostics', async () => {
    const source = '{"type":"session_meta","payload":{"id":"bounded"}}\n' + `${'x'.repeat(256)}\n` + '{"type":"response_item","payload":{"type":"message","role":"user","content":"after"}}\n'
    const result = await parseRollout(await stream(source), { revisionId: 'bounded', limits: { lineBytes: 128, records: 2 } })
    expect(result.completeness.truncatedRecords).toBeGreaterThan(0)
    expect(result.diagnostics.some(item => item.code === 'CODEX_LIMIT_EXCEEDED')).toBe(true)
    expect(result.timeline.some(item => item.kind === 'message' && item.text === 'after')).toBe(true)
  })

  it('rejects a source snapshot that changes between parse and fingerprint checks', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-toctou-'))
    const file = path.join(root, 'rollout-change.jsonl')
    await fs.writeFile(file, '{"type":"session_meta","payload":{"id":"toctou"}}\n', 'utf8')
    const originalStat = fs.stat.bind(fs)
    const originalAppend = fs.appendFile.bind(fs)
    let statCalls = 0
    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (filePath: any) => {
      const result = await originalStat(filePath)
      statCalls += 1
      // Change the path after parseRolloutFile has taken its post-read stat;
      // the open descriptor's final stat must still detect the handoff.
      if (statCalls === 2) await originalAppend(filePath, '\n')
      return result
    })
    try {
      await expect(parseRolloutFile(file, { revisionId: 'toctou' })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' })
    } finally {
      statSpy.mockRestore()
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
