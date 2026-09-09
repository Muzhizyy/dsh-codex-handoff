import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const gate = resolve('scripts/check-forbidden-imports.mjs')

async function runGate(files) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-handoff-gate-'))
  try {
    for (const [path, content] of Object.entries(files)) {
      const destination = join(directory, path)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, content, 'utf8')
    }
    try {
      await execFileAsync(process.execPath, [gate], { env: { ...process.env, FORBIDDEN_IMPORT_ROOT: directory } })
      return { failed: false, output: '' }
    } catch (error) {
      return { failed: true, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('forbidden import gate', () => {
  it('rejects bare, node-prefixed and dynamic builtin imports in browser-safe shared code', async () => {
    const result = await runGate({
      'src/shared/bad.ts': "import fs from 'fs'; const value = import('node:path'); export { value };",
    })
    expect(result.failed).toBe(true)
    expect(result.output).toMatch(/Node builtin import/)
  })

  it('rejects package self/alias imports and DSH imports outside the thin LLM adapter', async () => {
    const result = await runGate({
      'src/shared/bad.ts': "import own from 'dsh-threadbridge'; import alias from '@/other'; export { own, alias };",
      'src/handoff/bad.ts': "import agent from '@deepseek-ai/dsh-agent'; export { agent };",
    })
    expect(result.failed).toBe(true)
    expect(result.output).toMatch(/self\/alias|outside thin LLM adapter/)
  })

  it('allows only dsh-llm imports from the exact adapter path', async () => {
    const allowed = await runGate({
      'src/handoff/llm-adapter.ts': "import { stream } from '@deepseek-ai/dsh-llm'; export { stream };",
    })
    expect(allowed.failed).toBe(false)
    const rejected = await runGate({
      'src/handoff/other.ts': "import { stream } from '@deepseek-ai/dsh-llm'; export { stream };",
    })
    expect(rejected.failed).toBe(true)
  })

  it('rejects raw persistence writes and direct session persistence imports in dsh', async () => {
    const result = await runGate({
      'src/dsh/gateway.ts': "import fs from 'node:fs'; import '@deepseek-ai/dsh-session-persistence'; sessionPersistence.create({});",
    })
    expect(result.failed).toBe(true)
    expect(result.output).toMatch(/persistence|builtin/i)
  })
})
