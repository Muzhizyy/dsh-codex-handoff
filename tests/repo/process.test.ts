import { describe, expect, it } from 'vitest'
import path from 'node:path'

import { SpawnGitProcessAdapter } from '../../src/repo/process.js'

describe('argv-only process adapter', () => {
  it('bounds combined output and reports truncation', async () => {
    const result = await new SpawnGitProcessAdapter().run({
      command: 'node',
      args: ['-e', 'process.stdout.write("x".repeat(10000))'],
      cwd: path.resolve('.'),
      timeoutMs: 2_000,
      maxOutputBytes: 128,
    })
    expect(result.outputTruncated).toBe(true)
    const stdoutBytes = typeof result.stdout === 'string' ? result.stdout.length : result.stdout.byteLength
    const stderrBytes = typeof result.stderr === 'string' ? result.stderr.length : result.stderr.byteLength
    expect(stdoutBytes + stderrBytes).toBeLessThanOrEqual(128)
  })

  it('terminates a timed-out child without a shell', async () => {
    const result = await new SpawnGitProcessAdapter().run({
      command: 'node',
      args: ['-e', 'setTimeout(() => {}, 10000)'],
      cwd: path.resolve('.'),
      timeoutMs: 100,
      maxOutputBytes: 4096,
    })
    expect(result.timedOut).toBe(true)
  })

  it('does not pass redirecting GIT_* environment variables to a child', async () => {
    const result = await new SpawnGitProcessAdapter().run({
      command: 'node',
      args: ['-e', 'process.stdout.write(process.env.GIT_DIR ?? "")'],
      cwd: path.resolve('.'),
      timeoutMs: 2_000,
      maxOutputBytes: 128,
      env: { GIT_DIR: 'outside', GIT_EXTERNAL_DIFF: 'evil', GIT_CONFIG_PARAMETERS: 'evil' },
    })
    const output = typeof result.stdout === 'string' ? result.stdout : new TextDecoder().decode(result.stdout)
    expect(output).toBe('')
  })
})
