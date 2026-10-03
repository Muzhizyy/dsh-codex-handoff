import { describe, expect, it, vi } from 'vitest'

import {
  AppServerFailure,
  connectCodexAppServerTransport,
  resumeResponse,
  supportsPinnedProtocol,
  type JsonRpcTransport,
} from '../../src/codex/app-server.js'

class FakeTransport implements JsonRpcTransport {
  readonly requests: Array<{ method: string; params: unknown }> = []
  readonly notifications: string[] = []
  constructor(private readonly response: (method: string, params: unknown) => unknown | Promise<unknown>) {}
  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params })
    return await this.response(method, params)
  }
  notify(method: string): void { this.notifications.push(method) }
  close = vi.fn(async () => undefined)
}

function initialized(home: string, patch: Record<string, unknown> = {}) {
  return new FakeTransport(method => method === 'initialize' ? {
    codexHome: home,
    platformFamily: 'windows',
    platformOs: 'windows',
    userAgent: 'codex-cli/0.159.2',
    ...patch,
  } : undefined)
}

describe('official Codex app-server transport', () => {
  it.each([
    ['codex-cli 0.159.0-alpha.12.1', true],
    ['0.159.0-alpha.12.1', true],
    ['codex-cli 0.159.2', true],
    ['0.159.3', true],
    ['0.160.0', true],
    ['codex 1.0.0', true],
    ['codex-cli 0.159.0', false],
    ['codex-cli 0.159.1', false],
    ['codex-cli 0.159.0-alpha.12', false],
    ['codex-cli 0.159.0-alpha.12.2', false],
    ['codex-cli 0.159.0-alpha.12.99', false],
    ['codex-cli 0.159.0-beta.12.1', false],
    ['junk codex-cli 0.159.2', false],
    ['codex-cli build 0.159.2', false],
    ['codex-cli 0.159.0-alpha.12.1 extra', false],
    ['', false],
  ])('accepts only verified version output %j', (output, expected) => {
    expect(supportsPinnedProtocol(output)).toBe(expected)
  })

  it('falls back from a dead daemon proxy to an isolated stdio server before any thread RPC', async () => {
    const proxy = new FakeTransport(async method => {
      if (method === 'initialize') throw new AppServerFailure({ sent: false, remote: false, method })
      return undefined
    })
    const isolated = initialized('C:\\private\\codex-home')
    const args: string[][] = []
    const client = await connectCodexAppServerTransport(
      'C:\\Program Files\\Codex\\codex.exe',
      'C:\\private\\codex-home',
      'win32',
      {},
      (_binary, argv) => { args.push([...argv]); return args.length === 1 ? proxy : isolated },
    )
    expect(args).toEqual([['app-server', 'proxy'], ['app-server', '--listen', 'stdio://']])
    expect(proxy.close).toHaveBeenCalledOnce()
    expect(isolated.notifications).toEqual(['initialized'])
    await client.close()
  })

  it('fails closed on a genuine CODEX_HOME or protocol mismatch instead of falling back', async () => {
    const mismatched = initialized('C:\\other\\home')
    const makeTransport = vi.fn(() => mismatched)
    await expect(connectCodexAppServerTransport('codex.exe', 'C:\\expected\\home', 'win32', {}, makeTransport))
      .rejects.toMatchObject({ code: 'CODEX_PROTOCOL_MISMATCH' })
    expect(makeTransport).toHaveBeenCalledOnce()
    expect(mismatched.close).toHaveBeenCalledOnce()
  })

  it('validates fork provenance and injects exactly one inert user-message item', async () => {
    const transport = new FakeTransport(method => {
      if (method === 'initialize') return {
        codexHome: '/private/home', platformFamily: 'unix', platformOs: 'linux', userAgent: 'codex-cli/0.159.2',
      }
      if (method === 'thread/fork') return { thread: { id: 'derived-id', forkedFromId: 'source-id', ephemeral: false } }
      if (method === 'thread/inject_items') return {}
      return undefined
    })
    const client = await connectCodexAppServerTransport('codex', '/private/home', 'linux', {}, () => transport)
    await expect(client.fork('source-id')).resolves.toEqual({ forkId: 'derived-id', sourceThreadId: 'source-id' })
    await client.injectUserContext('derived-id', 'untrusted report')
    expect(transport.requests[1]).toEqual({ method: 'thread/fork', params: { threadId: 'source-id', excludeTurns: true } })
    expect(transport.requests[2]).toEqual({
      method: 'thread/inject_items',
      params: { threadId: 'derived-id', items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'untrusted report' }] }] },
    })
    await client.close()
  })

  it('does not accept malformed derived-thread responses and formats a resumable Windows command', async () => {
    const transport = new FakeTransport(method => method === 'initialize'
      ? { codexHome: '/home', platformFamily: 'unix', platformOs: 'linux', userAgent: 'codex-cli/0.159.2' }
      : { thread: { id: 'unrelated-thread', forkedFromId: 'another-source' } })
    const client = await connectCodexAppServerTransport('codex', '/home', 'linux', {}, () => transport)
    await expect(client.fork('source-id')).rejects.toMatchObject({ code: 'CODEX_PROTOCOL_MISMATCH' })
    await client.close()
    expect(resumeResponse('C:\\Program Files\\WindowsApps\\Codex\\codex.exe', 'fork-id', 'win32').displayCommand)
      .toBe("& 'C:\\Program Files\\WindowsApps\\Codex\\codex.exe' resume 'fork-id'")
  })
})
