/*
 * Official Typert end-to-end acceptance. This file runs inside the exact DSH
 * checkout selected by run-pinned-dsh-spike.mjs. It intentionally imports the
 * generated contribution from this package and uses DSH's own Context,
 * TypertRegistry, TypertGatewayService, and Client `$mount` implementation.
 */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = resolve(process.env.DSH_REPO_ROOT ?? process.cwd())
const upstreamRoot = resolve(process.env.DSH_UPSTREAM_ROOT ?? process.cwd())
const contributorRoot = resolve(process.env.DSH_CONTRIBUTOR_ROOT ?? upstreamRoot, 'packages', 'api', 'codex-handoff')
const upstreamModule = (relativePath) => import(pathToFileURL(resolve(upstreamRoot, relativePath)).href)

// The official Client artifact is a browser CJS wrapper.  Exercise that exact
// wrapper through the documented static module-table facade before importing
// it; this is the same registration shape used by the web boot shell, not a
// Node/ESM fallback.
const clientModules = new Map()
const clientStaticModules = new Map()
globalThis.window = {
  __ModuleLoader__: {
    mode: 'live',
    pendingQueue: [],
    load: ({ id, factory }) => {
      clientModules.set(id, factory((specifier) => {
        const value = clientStaticModules.get(specifier) ?? clientModules.get(specifier)
        if (value === undefined) throw new Error(`static client module missing: ${specifier}`)
        return value
      }))
    },
    create: () => { throw new Error('Typert acceptance does not create a second client module system') },
  },
}
const { Context } = await upstreamModule('vendor/cordis/lib/index.js')
clientStaticModules.set('@deepseek-ai/cordis', await upstreamModule('vendor/cordis/lib/index.js'))
const RegistryModule = await upstreamModule('packages/typert/registry/lib/index.js')
const TypertRegistry = RegistryModule.default
const GatewayModule = await upstreamModule('packages/api/gateway/lib/index.js')
const TypertGatewayService = GatewayModule.default
await upstreamModule('packages/api/gateway/lib/client.js')
const ClientModule = clientModules.get('@deepseek-ai/dsh-api-gateway')
assert.ok(ClientModule !== undefined, 'official Client bundle did not register its module-table factory')
const rootRemote = await import(pathToFileURL(resolve(repoRoot, 'dist', 'remote.js')).href)
const rootTypert = await import(pathToFileURL(resolve(repoRoot, 'dist', 'typert.js')).href)
const rootHost = await import(pathToFileURL(resolve(repoRoot, 'dist', 'host', 'remote.js')).href)
const resolver = await import(pathToFileURL(resolve(repoRoot, 'dist', 'codex', 'resolver.js')).href)
const repoModule = await import(pathToFileURL(resolve(repoRoot, 'dist', 'repo', 'inspector.js')).href)
const engineModule = await import(pathToFileURL(resolve(repoRoot, 'dist', 'handoff', 'engine.js')).href)
const contributor = await import(pathToFileURL(resolve(contributorRoot, 'lib', 'types', 'index.js')).href)

assert.equal(typeof contributor.CodexHandoffRemote, 'function', 'official contributor class is missing')
assert.deepEqual(rootTypert.TYPERT.invocations.map(item => item.method).sort(), ['analyze', 'compatibility', 'create', 'discover', 'preview'])
assert.deepEqual(rootRemote.default.descriptors.map(item => item.method).sort(), ['analyze', 'compatibility', 'create', 'discover', 'preview'])

const fixtureRoot = resolve(repoRoot, 'tests', 'fixtures', 'codex', 'normal')
const source = new resolver.CodexSessionSource({
  home: fixtureRoot,
  sessions: resolve(fixtureRoot, 'sessions'),
  archivedSessions: resolve(fixtureRoot, 'archived_sessions'),
  sessionIndex: resolve(fixtureRoot, 'session_index.jsonl'),
})
const gateway = {
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
  find: async () => undefined,
  create: async () => ({ state: 'created', sessionId: 'destination-1', workspaceAttached: true, warnings: [] }),
}
const implementation = new rootHost.CodexHandoffRemoteService({
  source,
  repository: new repoModule.GitRepositoryInspector(),
  engine: new engineModule.SmartHandoffEngine(),
  gateway,
})

const ctx = new Context()
await ctx.plugin(TypertRegistry)
await ctx.plugin(TypertGatewayService)
ctx.provide('codexHandoffImplementation', implementation)
await ctx.plugin(contributor.CodexHandoffRemote)
const disposeHostContribution = ctx.typert.register(rootTypert.TYPERT)

const hostInvoke = async (channel, endpoint, payload, signal) => {
  assert.equal(channel, '/api')
  const [namespace, method] = endpoint.split('/')
  return { ok: true, value: await ctx.typertGateway.invoke({ namespace, method, args: payload.args, signal }) }
}
ctx.provide('connection', {
  isLoopback: true,
  generation: { getSnapshot: () => undefined },
  state: { getSnapshot: () => undefined, subscribe: () => () => {} },
  rpc: { call: hostInvoke },
  registerGenerationSource: () => () => {},
  start: () => ({ stop: () => {} }),
})
const client = ctx.plugin({ inject: ClientModule.inject, apply: ClientModule.apply })
await client
const disposeClientContribution = await ctx.remote.$mount(rootRemote.default)

const compatibility = await ctx.remote.codexHandoff.compatibility()
assert.equal(compatibility.ok, true)
assert.equal(compatibility.value.compatible, true)
const page = await ctx.remote.codexHandoff.discover({ archived: 'all', limit: 10, includeMessageIndex: false })
assert.equal(page.ok, true)
assert.equal(page.value.items.length, 1)
assert.equal(ctx.get('codexHandoff')?.name, 'codexHandoff')

await disposeClientContribution()
await disposeHostContribution()
await client.dispose()
console.log('official Typert Gateway register/invoke and Client $mount acceptance passed')
