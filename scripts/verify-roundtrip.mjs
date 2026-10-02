/**
 * Independent pinned-runtime proof for the return receipt store and optional
 * real DSH/Codex round trip. The full flow never invokes a model or tool.
 *
 * Run storage proof with Windows Node after the exact DSH 0.2.0-rc.2 checkout has been built:
 *   DSH_UPSTREAM_ROOT=<absolute built checkout> node scripts/verify-roundtrip.mjs
 * Or use installed DSH 0.2.0-rc.2 Desktop's Electron Node runtime:
 *   DSH_DESKTOP_ROOT=<absolute install> node scripts/verify-roundtrip.mjs
 * Add --full plus DSH_VERIFY_CODEX_HOME (isolated Temp child) and
 * DSH_VERIFY_SOURCE_ID (synthetic source in that home) for the full flow.
 *
 * Uses a disposable storage root. It never opens the user's DSH profile or
 * Codex home, and it does not invoke a model or tool.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const upstreamInput = process.env.DSH_UPSTREAM_ROOT
const desktopInput = process.env.DSH_DESKTOP_ROOT
assert(Boolean(upstreamInput) !== Boolean(desktopInput), 'set exactly one of DSH_UPSTREAM_ROOT or DSH_DESKTOP_ROOT')
if (desktopInput && process.env.DSH_VERIFY_IN_ELECTRON !== '1') {
  assert(isAbsolute(desktopInput), 'DSH_DESKTOP_ROOT must be absolute')
  const executable = join(resolve(desktopInput), 'DeepSeek Harness.exe')
  await access(executable)
  const output = await new Promise((resolveOutput, rejectOutput) => {
    execFile(executable, ['--expose-internals', fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      cwd: repoRoot,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_VERIFY_IN_ELECTRON: '1' },
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
    }, (error, stdout, stderr) => error ? rejectOutput(new Error(`installed Desktop verification failed: ${stdout.slice(0, 400)} ${stderr.slice(0, 1400)}`, { cause: error })) : resolveOutput(stdout))
  })
  process.stdout.write(output)
  process.exit(0)
}

let Context
let StorageModule
let StorageJsonModule
let StorageDomainModule
let installedRequire
if (upstreamInput) {
  assert(isAbsolute(upstreamInput), 'DSH_UPSTREAM_ROOT must be absolute')
  const upstreamRoot = resolve(upstreamInput)
  const upstreamPackage = JSON.parse(await readFile(join(upstreamRoot, 'package.json'), 'utf8'))
  assert(upstreamPackage.packageManager?.startsWith('pnpm@'), 'DSH_UPSTREAM_ROOT is not the pinned monorepo root')
  assert.equal(upstreamPackage.version, '0.2.0-rc.2', 'DSH_UPSTREAM_ROOT is not the pinned 0.2 release candidate')
  const importBuilt = async (...segments) => {
    const filename = join(upstreamRoot, ...segments, 'lib', 'index.js')
    await access(filename)
    return import(pathToFileURL(filename).href)
  }
  ;({ Context } = await importBuilt('vendor', 'cordis'))
  StorageModule = await importBuilt('packages', 'storage', 'storage')
  StorageJsonModule = await importBuilt('packages', 'storage', 'storage-json')
  StorageDomainModule = await importBuilt('packages', 'storage', 'storage-domain')
} else {
  assert(process.versions.electron, 'installed Desktop verification must run under the bundled Electron Node runtime')
  const cliEntry = join(resolve(desktopInput), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
  installedRequire = createRequire(cliEntry)
  ;({ Context } = installedRequire('@deepseek-ai/cordis'))
  StorageModule = installedRequire('@deepseek-ai/dsh-storage')
  StorageJsonModule = installedRequire('@deepseek-ai/dsh-storage-json')
  StorageDomainModule = installedRequire('@deepseek-ai/dsh-storage-domain')
}
const { createStorageDomainReturnStore } = await import(pathToFileURL(join(repoRoot, 'dist', 'host', 'return-sync.js')).href)

const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-return-domain-proof-'))
const receiptId = randomUUID()
const now = new Date('2026-10-02T00:00:00.000Z').toISOString()
const context = 'Verifier-only redacted return context.'
const sha256 = text => createHash('sha256').update(text).digest('hex')
const record = {
  schemaVersion: 1,
  receiptId,
  receiptDigest: sha256('receipt'),
  snapshotDigest: sha256('snapshot'),
  createdAt: now,
  expiresAt: new Date(Date.parse(now) + 600_000).toISOString(),
  state: 'prepared',
  context,
  contextSha256: sha256(context),
  sourceThreadId: randomUUID(),
  sourceRolloutRevisionId: randomUUID(),
  sourceFingerprint: sha256('source'),
  dshSessionId: randomUUID(),
  dshCursor: 1,
  canonicalCwd: temporaryRoot,
  workspaceIdentity: 'verifier:1',
  gitFingerprint: sha256('git'),
  workspaceSummary: 'verifier repository',
  warnings: [],
  updatedAt: now,
}

async function mount() {
  const ctx = new Context()
  await ctx.plugin(StorageModule.default)
  await ctx.plugin(StorageJsonModule, { root: temporaryRoot })
  await ctx.plugin(StorageDomainModule, { backend: 'json' })
  return ctx
}

let ctx
let store
try {
  ctx = await mount()
  store = await createStorageDomainReturnStore(ctx.storageDomain)
  assert.equal((await store.get(receiptId)), undefined, 'fresh global unexpectedly contains a receipt')
  assert.deepEqual(await store.createOrReuse(record, new Date(now)), record, 'prepared receipt was not stored')
  const dispatching = { ...record, state: 'dispatching', attemptId: randomUUID(), updatedAt: now }
  assert.deepEqual(await store.update(receiptId, ['prepared'], null, dispatching), dispatching, 'state claim did not persist')
  await store.close()
  store = undefined

  // Closing the owned domain must release its name for a fresh handle.
  store = await createStorageDomainReturnStore(ctx.storageDomain)
  assert.deepEqual(await store.get(receiptId), dispatching, 'same-facility reopen lost the receipt')
  await store.close()
  store = undefined
  await ctx.fiber.dispose()
  ctx = undefined

  // A new facility reads from the durable backend, not an in-memory global.
  ctx = await mount()
  store = await createStorageDomainReturnStore(ctx.storageDomain)
  assert.deepEqual(await store.get(receiptId), dispatching, 'new-facility reload lost the receipt')
  assert.equal((await store.findBySnapshot(record.snapshotDigest))?.receiptId, receiptId)
  await store.close()
  store = undefined
  await ctx.fiber.dispose()
  ctx = undefined
  process.stdout.write('PASS pinned DSH storage-domain global: fresh prepare, state claim, close/reopen, durable new-facility reload\n')
} finally {
  await store?.close().catch(() => undefined)
  if (ctx?.fiber.active) await ctx.fiber.dispose().catch(() => undefined)
  await rm(temporaryRoot, { recursive: true, force: true })
}

if (process.argv.includes('--full')) await verifyFullFlow()

async function verifyFullFlow() {
  assert(installedRequire, '--full currently requires the installed Desktop Electron runtime')
  const codexHome = process.env.DSH_VERIFY_CODEX_HOME
  const sourceId = process.env.DSH_VERIFY_SOURCE_ID
  assert(codexHome && isAbsolute(codexHome) && sourceId, '--full requires absolute DSH_VERIFY_CODEX_HOME and DSH_VERIFY_SOURCE_ID')
  const canonicalHome = await (await import('node:fs/promises')).realpath(codexHome)
  const canonicalTemp = await (await import('node:fs/promises')).realpath(tmpdir())
  const suffix = relative(canonicalTemp, canonicalHome)
  assert(suffix && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix), 'Codex home must be an isolated child of the system temp directory')

  const AgentRegistry = installedRequire('@deepseek-ai/dsh-agent').default
  const AgentLoop = installedRequire('@deepseek-ai/dsh-agent-loop').default
  const ProjectionRegistry = installedRequire('@deepseek-ai/dsh-session-projection').default
  const LlmModule = installedRequire('@deepseek-ai/dsh-llm')
  const SessionModule = installedRequire('@deepseek-ai/dsh-session')
  const SystemPrompt = installedRequire('@deepseek-ai/dsh-system-prompt').default
  const ToolRuntime = installedRequire('@deepseek-ai/dsh-tools').default
  const JsonlPersistence = installedRequire('@deepseek-ai/dsh-session-persistence-jsonl').default
  const SessionQuerySqlite = installedRequire('@deepseek-ai/dsh-session-query-sqlite').default
  const { CodexSessionSource } = await import(pathToFileURL(join(repoRoot, 'dist', 'codex', 'resolver.js')).href)
  const { FullTrajectorySeedCompiler } = await import(pathToFileURL(join(repoRoot, 'dist', 'dsh', 'seed.js')).href)
  const { DshSessionGateway, createStorageDomainImportIndex, computeImportIdentity } = await import(pathToFileURL(join(repoRoot, 'dist', 'dsh', 'gateway.js')).href)
  const { ReturnSyncService } = await import(pathToFileURL(join(repoRoot, 'dist', 'host', 'return-sync.js')).href)
  const { createCodexAppServer } = await import(pathToFileURL(join(repoRoot, 'dist', 'codex', 'app-server.js')).href)
  const { GitRepositoryInspector } = await import(pathToFileURL(join(repoRoot, 'dist', 'repo', 'inspector.js')).href)

  const source = new CodexSessionSource({ codexHome: canonicalHome })
  const page = await source.discover({ search: sourceId, archived: 'active', limit: 200 })
  assert(!page.nextCursor, 'synthetic Codex source search was incomplete')
  const summary = page.items.filter(item => item.sessionId === sourceId)
  assert.equal(summary.length, 1, 'synthetic Codex source was not unique')
  const chosen = summary[0]
  const sourceRef = {
    discoveryId: chosen.discoveryId, source: 'codex', sessionId: chosen.sessionId,
    rolloutRevisionId: chosen.rolloutRevisionId, expectedFingerprint: chosen.fingerprint, archived: false,
  }
  const normalized = await source.load(sourceRef)
  const sourceDescriptor = (await source.resolver.inventory()).find(item => item.sessionId === sourceId)
  assert(sourceDescriptor, 'synthetic Codex source rollout file was unavailable')
  const sourceShaBefore = sha256(await readFile(sourceDescriptor.path))
  const cwd = await (await import('node:fs/promises')).realpath(normalized.source.cwd)
  const seed = new FullTrajectorySeedCompiler({ includeNotice: true }).compile(normalized)
  const identity = computeImportIdentity({ source: sourceRef, sourceFingerprint: normalized.source.fingerprint, mode: 'full', cwd })
  const seedBytes = Buffer.byteLength(JSON.stringify(seed), 'utf8')
  const prepared = { source: sourceRef, sourceFingerprint: normalized.source.fingerprint, mode: 'full', cwd, seed, seedBytes, totalBytes: seedBytes, identity }

  const dshRoot = await mkdtemp(join(tmpdir(), 'dsh-real-roundtrip-'))
  const storageRoot = join(dshRoot, 'storage')
  const persistenceRoot = join(dshRoot, 'sessions')
  let context
  let index
  let returnStore
  let gateway
  let service
  try {
    context = new Context()
    await context.plugin(StorageModule.default)
    await context.plugin(StorageJsonModule, { root: storageRoot })
    await context.plugin(StorageDomainModule, { backend: 'json' })
    await context.plugin(LlmModule.default)
    await context.plugin(SessionModule.SessionStore)
    await context.plugin(ProjectionRegistry)
    await context.plugin(SystemPrompt)
    await context.plugin(ToolRuntime)
    await context.plugin(JsonlPersistence, { root: persistenceRoot, compression: 'none' })
    await context.plugin(SessionQuerySqlite, { path: join(dshRoot, 'query.db'), openAt: 'never' })
    await context.plugin(AgentRegistry)
    await context.plugin(AgentLoop, { agents: [] })
    class NoModelAdapter extends LlmModule.LlmAdapter {
      resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }) }
      async *stream() { throw new Error('model invocation is forbidden in the round-trip verifier') }
    }
    context.llm.registerAdapter(['mock'], new NoModelAdapter())
    index = await createStorageDomainImportIndex(context.storageDomain)
    returnStore = await createStorageDomainReturnStore(context.storageDomain)
    let handle
    const runtime = {
      agents: { create: async options => { handle = await context.agents.create(options); return handle } },
      agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock' }) },
      sessionQuery: { observeSession: (id, options) => context.sessionQuery.observeSession(SessionModule.SessionId(id), options) },
      sessionPersistence: context.sessionPersistence,
      workspaceRegistry: { resolveByPath: async () => ({ attachSession: async () => undefined }) },
      storageDomain: context.storageDomain,
      typert: {},
      dshVersion: '0.2.0-rc.2', observedSessionFormat: 4,
    }
    gateway = new DshSessionGateway(runtime, { index, fingerprint: async request => (await source.load(request.source)).source.fingerprint })
    assert(gateway.compatibility().compatible, 'real DSH gateway did not expose required v4 capabilities')
    const created = await gateway.create(prepared)
    assert.equal(created.state, 'created', 'real DSH gateway did not create the session')
    assert(handle, 'real DSH Agents.create did not return a handle')
    const progress = 'Synthetic DSH progress: completed the local integration review.'
    handle.agent.session.append('user/message', LlmModule.createUserMessage({
      content: [{ type: 'text', text: progress }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await context.sessions.flush(handle.agent.session)
    const observation = await context.sessionQuery.observeSession(SessionModule.SessionId(created.sessionId), { projectionMode: 'none' })
    try {
      assert(observation.events.some(item => item.type === 'user/message' && JSON.stringify(item.data).includes(progress)), 'official DSH SessionQuery omitted appended progress')
    } finally { observation[Symbol.dispose]() }

    service = new ReturnSyncService({
      source, repository: new GitRepositoryInspector(), importIndex: index,
      sessionQuery: runtime.sessionQuery, store: returnStore, codexHome: canonicalHome,
    })
    const preview = await service.returnPreview({ dshSessionId: created.sessionId })
    assert(preview.context.includes(progress), 'return preview omitted real DSH progress')
    assert(preview.context.includes('## Original goal'), 'return preview omitted original-goal section')
    const returned = await service.returnSync({ receiptId: preview.receiptId })
    assert.equal(returned.status, 'created', 'official Codex return did not create a persistent fork')
    const repeated = await service.returnSync({ receiptId: preview.receiptId })
    assert.equal(repeated.status, 'existing', 'completed receipt was not idempotent')
    assert.equal(repeated.codexForkId, returned.codexForkId, 'idempotent return changed fork identity')
    const secondPreview = await service.returnPreview({ dshSessionId: created.sessionId })
    assert.equal(secondPreview.receiptId, preview.receiptId, 'unchanged snapshot did not reuse the durable receipt')

    const forkDescriptor = (await source.resolver.inventory()).find(item => item.sessionId === returned.codexForkId)
    assert(forkDescriptor, 'official Codex fork rollout was not persisted')
    const forkRaw = await readFile(forkDescriptor.path, 'utf8')
    assert(forkRaw.includes(progress) && forkRaw.includes(`dsh-codex-handoff:receipt=${preview.receiptId}`), 'persisted fork raw rollout omitted injected return context')
    const forkPage = await source.discover({ search: returned.codexForkId, archived: 'active', limit: 200 })
    const forkSummary = forkPage.items.find(item => item.sessionId === returned.codexForkId)
    assert(forkSummary, 'official fork was not discoverable')
    const forkNormalized = await source.load({
      discoveryId: forkSummary.discoveryId, source: 'codex', sessionId: returned.codexForkId,
      rolloutRevisionId: forkSummary.rolloutRevisionId, expectedFingerprint: forkSummary.fingerprint, archived: false,
    })
    const assistantOrTools = value => value.timeline.filter(item => item.kind === 'tool' || item.kind === 'message' && item.role === 'assistant').length
    const forkRawRecords = forkRaw.trim().split(/\r?\n/u).map(line => JSON.parse(line))
    assert(forkRawRecords.every(item => item.type !== 'response_item' || item.payload?.type === 'message'), 'fork raw rollout contains a tool or model response item')
    assert(assistantOrTools(forkNormalized) <= assistantOrTools(normalized), 'return fork invoked a model or tool')
    const inspector = await createCodexAppServer({ codexHome: canonicalHome })
    try {
      assert(typeof inspector.transport?.request === 'function', 'Codex inspector transport unavailable')
      const read = await inspector.transport.request('thread/read', { threadId: returned.codexForkId, includeTurns: true })
      assert(Array.isArray(read?.thread?.turns) && read.thread.turns.length === 0, 'official Codex thread/read shows a started turn')
    } finally { await inspector.close() }
    assert.equal(sha256(await readFile(sourceDescriptor.path)), sourceShaBefore, 'source rollout changed during return')
    process.stdout.write('PASS real DSH v4 create/query/persist + plugin return preview/sync + official Codex fork/inject; raw context durable, source unchanged, idle, existing/reuse\n')
  } finally {
    await service?.close().catch(() => undefined)
    await gateway?.disposeAll().catch(() => undefined)
    await returnStore?.close().catch(() => undefined)
    await index?.close?.().catch(() => undefined)
    if (context?.fiber.active) await context.fiber.dispose().catch(() => undefined)
    await rm(dshRoot, { recursive: true, force: true })
  }
}
