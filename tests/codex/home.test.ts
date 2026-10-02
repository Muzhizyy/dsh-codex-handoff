import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveCodexHome, resolveCodexHomePath } from '../../src/codex/home.js'

describe('Codex home resolution', () => {
  it('uses config, then CODEX_HOME, then the OS home default', () => {
    expect(resolveCodexHomePath({ config: { codexHome: 'C:/configured/.codex' }, env: { CODEX_HOME: 'C:/environment/.codex' }, platform: 'win32' })).toBe(path.win32.normalize('C:/configured/.codex'))
    expect(resolveCodexHomePath({ env: { CODEX_HOME: 'C:/environment/.codex' }, platform: 'win32' })).toBe(path.win32.normalize('C:/environment/.codex'))
    expect(resolveCodexHomePath({ env: {}, homeDirectory: 'C:/Users/synthetic', platform: 'win32' })).toBe(path.win32.normalize('C:/Users/synthetic/.codex'))
  })

  it('reports an absent but valid absolute home without scanning a fallback', async () => {
    const result = await resolveCodexHome({ codexHome: path.resolve('tests', 'fixtures', 'codex', 'does-not-exist'), canonicalize: false })
    expect(result.exists).toBe(false)
    expect(result.source).toBe('config')
  })
})
