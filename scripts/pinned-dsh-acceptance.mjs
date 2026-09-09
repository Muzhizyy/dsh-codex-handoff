/*
 * Commit-pinned DSH acceptance contract.
 *
 * This file is copied into a temporary checkout of the pinned upstream
 * repository and executed there.  The only implementation imported from this
 * repository is the built seed compiler (DSH_SEED_MODULE); the acceptance
 * harness deliberately does not copy or compile any product code.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const repoRoot = resolve(process.env.DSH_REPO_ROOT ?? process.cwd())
const upstreamRoot = resolve(process.env.DSH_UPSTREAM_ROOT ?? process.cwd())
const seedModulePath = resolve(process.env.DSH_SEED_MODULE ?? '')
assert(isAbsolute(seedModulePath), 'DSH_SEED_MODULE must be an absolute path')
const execFileAsync = promisify(execFile)
// Keep each credential marker in a form covered by the shared redactor's
// documented patterns: a bearer scheme requires whitespace before its token.
const CANARY_SECRET = 'P0-canary-Bearer abc-AKIA1234567890ABCDEF'

async function git(cwd, args) {
  return execFileAsync('git', args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
}

/**
 * Exercise the actual pinned Cordis include/loader patch implementation. A
 * YAML parse or a regex over the patch is not sufficient here: this applies
 * the exact entry-list schema and patch engine used by the upstream bundle.
 */
async function exerciseOfficialBundlePatch() {
  const yamlModule = await import('js-yaml')
  const yaml = yamlModule.default ?? yamlModule
  const include = await import('@deepseek-ai/cordis-plugin-include')
  const loader = await import('@deepseek-ai/cordis-plugin-loader')
  assert(typeof include.entryListSchema === 'object', 'official entry-list schema is unavailable')
  assert.equal(typeof include.applyEntryPatches, 'function', 'official patch applier is unavailable')
  assert(typeof loader.Loader === 'function' || typeof loader.evaluate === 'function', 'official loader is unavailable')
  const patchText = await readFile(join(repoRoot, 'cordis.patch.yml'), 'utf8')
  const parsed = yaml.load(patchText, { schema: include.entryListSchema })
  assert(Array.isArray(parsed), 'cordis.patch.yml did not validate as an entry list')
  const warnings = []
  const applied = include.applyEntryPatches(
    [{ id: 'pinned-base', name: 'pinned-base' }],
    parsed,
    (...args) => warnings.push(args),
  )
  assert.equal(warnings.length, 0, `official patch loader emitted warnings: ${JSON.stringify(warnings)}`)
  assert(applied.some(entry => entry.id === 'codex-handoff'), 'official patch loader did not insert codex-handoff')
  const inserted = applied.find(entry => entry.id === 'codex-handoff')
  assert.deepEqual(inserted.inject, [
    'agents',
    'agentDefaultModel',
    'sessionQuery',
    'sessionPersistence',
    'workspaceRegistry',
    'storageDomain',
    'typert',
  ], 'official patch loader changed the required service injection list')
}

const {
  FullTrajectorySeedCompiler,
} = await import(pathToFileURL(seedModulePath).href)
const gatewayModulePath = resolve(join(repoRoot, 'dist', 'dsh', 'gateway.js'))
const {
  DshSessionGateway,
  createStorageDomainImportIndex,
  computeImportIdentity,
} = await import(pathToFileURL(gatewayModulePath).href)

const { Context } = await import('@deepseek-ai/cordis')
const AgentRegistryModule = await import('@deepseek-ai/dsh-agent')
const AgentRegistry = AgentRegistryModule.default
const AgentLoopModule = await import('@deepseek-ai/dsh-agent-loop')
const AgentLoop = AgentLoopModule.default
const SessionProjectionModule = await import('@deepseek-ai/dsh-session-projection')
const SessionProjectionRegistry = SessionProjectionModule.default
const LlmModule = await import('@deepseek-ai/dsh-llm')
const { createUserMessage, LlmAdapter } = LlmModule
const SessionModule = await import('@deepseek-ai/dsh-session')
const { Session, SessionId, SessionStore } = SessionModule
const SystemPromptModule = await import('@deepseek-ai/dsh-system-prompt')
const SystemPrompt = SystemPromptModule.default
const ToolRuntimeModule = await import('@deepseek-ai/dsh-tools')
const ToolRuntime = ToolRuntimeModule.default
const { defineTool } = ToolRuntimeModule
const JsonlPersistenceModule = await import(pathToFileURL(join(
  upstreamRoot,
  'packages',
  'session',
  'session-persistence-jsonl',
  'lib',
  'index.js',
)).href)
const JsonlSessionPersistence = JsonlPersistenceModule.default

const TEXT_RESPONSE = (text) => [
  { type: 'block-start', index: 0, blockType: 'text' },
  ...Array.from(text, (character) => ({ type: 'text-delta', index: 0, text: character })),
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** A deterministic adapter with no network, filesystem, or tool side effects. */
class ScriptedAdapter extends LlmAdapter {
  constructor(responses = []) {
    super()
    this.responses = [...responses]
    this.requests = []
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(options) {
    this.requests.push(options)
    const response = this.responses.shift()
    if (response === undefined) throw new Error('pinned acceptance adapter script exhausted')
    for (const chunk of response) {
      if (options.signal?.aborted) throw new Error('pinned acceptance adapter aborted')
      yield chunk
    }
  }
}

function event(kind, id, order, body, extra = {}) {
  return { kind, id, order, ...body, source: { locator: `acceptance:${id}` }, ...extra }
}

function lifecycle(type, id, order, payload) {
  return event('lifecycle', id, order, { lifecycle: { type, ...payload } })
}

function makeNormalizedSession() {
  const timeline = []
  const add = (value) => timeline.push(value)
  const source = {
    agent: 'codex',
    sessionId: 'pinned-source-session',
    rolloutRevisionId: 'pinned-rollout-1',
    fingerprint: `sha256-${'a'.repeat(64)}`,
    startedAt: '2026-01-01T00:00:00.000Z',
    archived: false,
  }
  const normalize = () => timeline.map((value, index) => ({ ...value, order: index }))

  add(lifecycle('turn-start', 'turn-start-1', 0, { turnId: 'turn-1', evidence: 'codex-turn-started' }))
  add(lifecycle('step-start', 'step-start-1', 1, { turnId: 'turn-1', step: 1, evidence: 'derived-response-cycle' }))
  add(event('message', 'user-1', 2, { role: 'user', text: `Inspect history; sensitive value "${CANARY_SECRET}"` }))
  add(event('message', 'assistant-1', 3, { role: 'assistant', text: `I will inspect the recorded result (${CANARY_SECRET}).` }))
  add(event('tool-call', 'tool-call-1', 4, { callId: 'call-1', name: 'read', argumentsText: JSON.stringify({ path: 'safe.txt', token: CANARY_SECRET }) }))
  add(event('tool-result', 'tool-result-1', 5, { callId: 'call-1', name: 'read', content: `historical result ${CANARY_SECRET}`, failed: false }))
  add(lifecycle('step-end', 'step-end-1', 6, { turnId: 'turn-1', step: 1, evidence: 'derived-response-cycle' }))
  add(lifecycle('step-start', 'step-start-2', 7, { turnId: 'turn-1', step: 2, evidence: 'derived-response-cycle' }))
  add(event('reasoning-summary', 'reasoning-1', 8, { text: `The prior tool result is retained as inert history: ${CANARY_SECRET}` }))
  add(event('annotation', 'annotation-1', 9, { category: 'boundary', text: `Historical annotation ${CANARY_SECRET}` }))
  add(event('message', 'assistant-2', 10, { role: 'assistant', text: 'The recorded result was preserved without execution.' }))
  add(lifecycle('step-end', 'step-end-2', 11, { turnId: 'turn-1', step: 2, evidence: 'derived-response-cycle' }))
  add(lifecycle('turn-end', 'turn-end-1', 12, { turnId: 'turn-1', outcome: { kind: 'completed', evidence: 'codex-turn-complete' } }))
  add(lifecycle('turn-start', 'turn-start-2', 13, { turnId: 'turn-2', evidence: 'codex-turn-started' }))
  add(lifecycle('step-start', 'step-start-3', 14, { turnId: 'turn-2', step: 1, evidence: 'derived-response-cycle' }))
  add(event('message', 'user-2', 15, { role: 'user', text: 'The next rollout was interrupted.' }))
  add(event('message', 'assistant-3', 16, { role: 'assistant', text: 'Partial response before interruption.' }))
  add(lifecycle('step-end', 'step-end-3', 17, { turnId: 'turn-2', step: 1, evidence: 'derived-response-cycle' }))
  add(lifecycle('turn-end', 'turn-end-2', 18, { turnId: 'turn-2', outcome: { kind: 'interrupted', evidence: 'end-of-log' } }))

  return {
    schemaVersion: 2,
    source,
    lineage: [{ rolloutRevisionId: source.rolloutRevisionId, relation: 'head', representation: 'jsonl' }],
    timeline: normalize(),
    diagnostics: [{ code: 'P0_CANARY', severity: 'warning', message: CANARY_SECRET, recoverable: true }],
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

function assertDenseSeed(seed) {
  assert(seed.length > 0, 'compiler produced no DSH events')
  for (const [index, item] of seed.entries()) {
    assert.equal(item.seq, index, `seed seq ${index} is not dense`)
    assert(Number.isSafeInteger(item.time) && item.time >= 0, `seed time ${index} is invalid`)
    assert.notEqual(JSON.stringify(item), undefined, `seed event ${index} is not JSON-safe`)
  }
}

function assertSeedContract(seed, compilation) {
  assertDenseSeed(seed)
  const types = seed.map((item) => item.type)
  assert(types.filter((type) => type === 'turn/start').length >= 2, 'multi-turn seed was not emitted')
  assert(types.includes('step/start') && types.includes('step/end'), 'multi-step seed was not emitted')
  assert(types.includes('tool/call') && types.includes('tool/result'), 'tool history was not emitted')
  assert(types.includes('turn/end'), 'turn closing event was not emitted')
  assert(seed.some((item) => item.type === 'turn/end' && item.data?.reason?.kind === 'interrupted'), 'interrupted outcome was lost')
  assert(seed.some((item) => item.type === 'assistant/message' && Array.isArray(item.data?.stream)), 'stream field missing')
  const call = seed.find((item) => item.type === 'tool/call')
  const result = seed.find((item) => item.type === 'tool/result')
  assert(call && result, 'paired tool events missing')
  assert(Array.isArray(result.sourceEventSeqs) && result.sourceEventSeqs.includes(call.seq), 'tool provenance reference missing')
  assert(compilation.diagnostics.every((diagnostic) => typeof diagnostic.code === 'string'), 'diagnostic code missing')
  const notice = seed.find((item) => (item.data?.source ?? item.data?.message?.source)?.plugin === 'dsh-threadbridge')
  const noticeSource = notice?.data?.source ?? notice?.data?.message?.source
  assert(noticeSource?.form === 'notice', `includeNotice did not emit a plugin-source notice: ${seed.map((item) => `${item.type}:${JSON.stringify(item.data).slice(0, 500)}`).join(' | ')}`)
  assert(typeof noticeSource.summary === 'string' && noticeSource.summary.length > 0, 'plugin-source notice summary missing')
  assert.equal(noticeSource.sourceSessionId, normalized.source.sessionId)
  assert.equal(noticeSource.rolloutRevisionId, normalized.source.rolloutRevisionId)
  assert.equal(noticeSource.fingerprint, normalized.source.fingerprint)
  assert.equal(noticeSource.mode, 'full')
  assert.equal(noticeSource.compilerSchema, '1.0.0')

  const serialized = JSON.stringify(seed)
  assert(!serialized.includes(CANARY_SECRET), 'compiled seed leaked the P0 canary secret')
  assert(!serialized.includes(repoRoot), 'compiled provenance leaked the repository path')
  assert(!serialized.includes('AKIA1234567890ABCDEF'), 'compiled provenance leaked an AWS access key')
  assert(!serialized.includes('Bearer abc'), 'compiled provenance leaked a bearer token')
}

async function mountRuntime({ adapter, persistenceRoot, storageRoot, presets = false }) {
  const ctx = new Context()
  if (storageRoot !== undefined) {
    const StorageModule = await import(pathToFileURL(join(
      upstreamRoot,
      'packages', 'storage', 'storage', 'lib', 'index.js',
    )).href)
    const StorageJsonModule = await import(pathToFileURL(join(
      upstreamRoot,
      'packages', 'storage', 'storage-json', 'lib', 'index.js',
    )).href)
    const StorageDomainModule = await import(pathToFileURL(join(
      upstreamRoot,
      'packages', 'storage', 'storage-domain', 'lib', 'index.js',
    )).href)
    await ctx.plugin(StorageModule.default)
    await ctx.plugin(StorageJsonModule, { root: storageRoot })
    await ctx.plugin(StorageDomainModule, { backend: 'json' })
  }
  if (presets) {
    const LoaderModule = await import('@deepseek-ai/cordis-plugin-loader')
    const IncludeModule = await import('@deepseek-ai/cordis-plugin-include')
    const GroupModule = await import('@deepseek-ai/cordis-plugin-group')
    const AgentPresetsModule = await import('@deepseek-ai/dsh-agent-presets')
    const Loader = LoaderModule.default
    const Include = IncludeModule.default
    const Group = GroupModule.default
    const AgentPresets = AgentPresetsModule.default
    const fixtureRoot = join(upstreamRoot, 'packages', 'preset', 'agent-presets', 'tests', 'fixtures')
    ctx.baseUrl = pathToFileURL(fixtureRoot).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.builtins.group = Group
    await ctx.plugin(LlmModule.default)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { persona: '' })
    await ctx.plugin(ToolRuntime)
    if (persistenceRoot !== undefined) {
      await ctx.plugin(JsonlSessionPersistence, { root: persistenceRoot, compression: 'none' })
    }
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(AgentPresets, {
      default: 'standard',
      roots: [
        { path: join(fixtureRoot, 'system'), trust: 'system' },
        { path: join(fixtureRoot, 'user'), trust: 'user' },
      ],
      includeShippedRoot: false,
      includeUserRoot: false,
    })
    ctx.llm.registerAdapter(['mock'], adapter)
    return ctx
  }

  await ctx.plugin(LlmModule.default)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (persistenceRoot !== undefined) {
    await ctx.plugin(JsonlSessionPersistence, { root: persistenceRoot, compression: 'none' })
  }
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function wrapCreateContract(ctx) {
  const create = ctx.agents.create.bind(ctx.agents)
  let observed
  ctx.agents.create = async (options) => {
    observed = options
    for (const field of ['parentSession', 'isSeeded', 'origin', 'delegationDepth', 'inheritedEventCount']) {
      assert(!Object.hasOwn(options, field), `create options unexpectedly contains fork field ${field}`)
    }
    if (options.meta !== undefined) {
      for (const field of ['parentSession', 'isSeeded', 'origin', 'delegationDepth']) {
        assert(!Object.hasOwn(options.meta, field), `create meta unexpectedly contains fork field ${field}`)
      }
    }
    return create(options)
  }
  return () => observed
}

async function exerciseSeedAndPreset(compiledSeed) {
  const adapter = new ScriptedAdapter()
  const ctx = await mountRuntime({ adapter, presets: true })
  try {
    const observedCreate = wrapCreateContract(ctx)
    const id = SessionId('pinned-seed-poison')
    const handle = await ctx.agents.create({
      sessionId: id,
      meta: { cwd: process.cwd() },
      seed: compiledSeed,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    assert(observedCreate(), 'create contract was not observed')
    assert.equal(adapter.requests.length, 0, 'seed creation dispatched an LLM request')
    const events = handle.agent.session.snapshotEvents()
    assert.equal(events.at(-1)?.type, 'session/end-seed', 'DSH did not append automatic end-seed')
    assert(handle.agent.session.deriveMessages().length > 0, 'deriveMessages returned no history')
    assert.equal(ctx.agents.get(id), handle.agent, 'created agent is not live in registry')
    assert(ctx.agents.list().some((agent) => agent === handle.agent), 'created agent missing from list')
    await handle.dispose()
    assert.equal(ctx.agents.get(id), undefined, 'dispose did not remove live agent')

    // A completed imported transcript is intentionally locked against preset
    // selection. Exercise the real preset mount on a fresh agent so this
    // acceptance distinguishes the two DSH contracts instead of weakening the
    // session lock to accommodate a seed.
    const presetHandle = await ctx.agents.create({
      sessionId: SessionId('pinned-preset'),
      meta: { cwd: process.cwd(), agentPreset: 'standard' },
      agentOptions: { provider: 'mock', model: 'mock' },
      setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'standard') },
    })
    const presetEvents = presetHandle.agent.session.snapshotEvents()
    const schemas = ctx.tools.schemas(presetHandle.agent)
    assert(schemas.some((schema) => schema.name === 'alpha'), 'real preset tool was not mounted')
    assert.equal(presetHandle.agent.session.header.agentPreset, 'standard', 'preset header was not recorded')
    assert(!presetEvents.some((item) => item.type === 'agent-preset/selected'), 'mount unexpectedly used the mutable select path')
    await presetHandle.dispose()
  } finally {
    await ctx.fiber.dispose()
  }
}

function preparedImportFor(normalizedSession, compiledSeed) {
  const source = {
    discoveryId: 'pinned-discovery',
    source: 'codex',
    sessionId: normalizedSession.source.sessionId,
    rolloutRevisionId: normalizedSession.source.rolloutRevisionId,
    expectedFingerprint: normalizedSession.source.fingerprint,
  }
  const cwd = process.cwd()
  const identity = computeImportIdentity({ source, mode: 'full', cwd })
  const seedBytes = new TextEncoder().encode(JSON.stringify(compiledSeed)).byteLength
  return {
    identity,
    source,
    sourceFingerprint: normalizedSession.source.fingerprint,
    mode: 'full',
    cwd,
    seed: compiledSeed,
    seedBytes,
    totalBytes: seedBytes,
  }
}

function registerPoisonReadTool(ctx, counter, name = 'read') {
  return ctx.tools.register(defineTool({
    name,
    description: 'Historical read poison fixture; it must never execute during import or resume.',
    parameters: { path: { type: 'string' } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      counter.count += 1
      throw new Error('historical poison tool executed')
    },
  }))
}

function gatewayRuntime(ctx, handles, createCalls = []) {
  return {
    agents: {
      create: async (options) => {
        createCalls.push(options)
        const handle = await ctx.agents.create(options)
        handles.push(handle)
        return handle
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock' }) },
    agentPresets: ctx.agentPresets,
    sessionQuery: {
      inspect: async (id) => ctx.agents.get(SessionId(id))?.session,
    },
    sessionPersistence: ctx.sessionPersistence,
    workspaceRegistry: {
      resolveByPath: async () => ({ attachSession: async () => undefined }),
    },
    storageDomain: ctx.storageDomain,
    typert: {},
    llm: ctx.llm,
    dshVersion: '0.1.3-alpha.1',
    observedSessionFormat: 2,
  }
}

async function readPersisted(ctx, id) {
  const reader = await ctx.sessionPersistence.open(id, 'read')
  try {
    return await reader.read()
  } finally {
    await reader.close()
  }
}

function sourceNotice(events) {
  return events.find((item) => (item.data?.source ?? item.data?.message?.source)?.plugin === 'dsh-threadbridge')
}

async function exerciseGatewayLifecycle(normalizedSession, compiledSeed) {
  const persistenceRoot = await mkdtemp(join(tmpdir(), 'dsh-pinned-gateway-persist-'))
  const storageRoot = await mkdtemp(join(tmpdir(), 'dsh-pinned-gateway-storage-'))
  const prepared = preparedImportFor(normalizedSession, compiledSeed)
  const destinationId = SessionId(prepared.identity.destinationSessionId)
  const poison = { count: 0 }
  try {
    const adapter = new ScriptedAdapter()
    const ctx = await mountRuntime({ adapter, persistenceRoot, storageRoot, presets: true })
    let handles = []
    const createCalls = []
    let index
    let gateway
    const ledgerStates = []
    try {
      ctx.on('domain/changed', (change) => {
        if (change.domain !== 'dsh_codex_handoff' || change.table !== 'ledgers' || change.key !== 'imports') return
        const state = change.value?.records?.[prepared.identity.key]?.state
        if (state !== undefined) ledgerStates.push(state)
      })
      index = await createStorageDomainImportIndex(ctx.storageDomain)
      const unregisterPoison = registerPoisonReadTool(ctx, poison)
      const runtime = gatewayRuntime(ctx, handles, createCalls)
      gateway = new DshSessionGateway(runtime, {
        index,
        fingerprint: async (request) => request.sourceFingerprint,
      })
      assert.equal(gateway.compatibility().compatible, true, JSON.stringify(gateway.compatibility()))
      const outcome = await gateway.create(prepared)
      assert.equal(outcome.state, 'created', JSON.stringify(outcome))
      assert.equal(outcome.sessionId, prepared.identity.destinationSessionId)
      assert.equal(handles.length, 1, 'gateway did not use the real DSH agent factory')
      assert.equal(createCalls[0]?.sessionId, prepared.identity.destinationSessionId)
      assert.equal(createCalls[0]?.meta?.agentPreset, 'standard', 'import create did not carry the resolved preset')
      assert.deepEqual(createCalls[0]?.seed, compiledSeed, 'import create did not receive the compiler seed')
      const handle = handles[0]
      const session = handle.agent.session
      const events = session.snapshotEvents()
      assert.equal(events.length, compiledSeed.length + 1, 'gateway create did not preserve seed plus exactly one end-seed')
      assert.deepEqual(events.slice(0, compiledSeed.length), compiledSeed, 'gateway create mutated compiled seed')
      assert.equal(events.at(-1)?.type, 'session/end-seed', 'gateway create missing end-seed')
      const comparison = Session.create(SessionId('pinned-derive-compare'), compiledSeed)
      assert.deepEqual(session.deriveMessages(), comparison.deriveMessages(), 'gateway create deriveMessages diverged from Session.create')
      const notice = sourceNotice(events)
      const noticeSource = notice?.data?.source ?? notice?.data?.message?.source
      assert(noticeSource?.form === 'notice', 'gateway observation had no plugin-source notice')
      for (const [key, value] of Object.entries({
        summary: notice.data.source.summary,
        sourceSessionId: prepared.source.sessionId,
        rolloutRevisionId: prepared.source.rolloutRevisionId,
        fingerprint: prepared.sourceFingerprint,
        mode: prepared.mode,
        compilerSchema: '1.0.0',
      })) assert.equal(noticeSource[key], value, `notice metadata ${key} mismatch`)
      const serializedObservation = JSON.stringify({ header: session.header, events })
      assert(!serializedObservation.includes(repoRoot), 'gateway observation leaked source path')
      assert(!serializedObservation.includes(CANARY_SECRET), 'gateway observation leaked the P0 canary secret')
      assert(!/password|authorization|secret/i.test(serializedObservation), 'gateway observation leaked sensitive raw text')
      assert.equal(adapter.requests.length, 0, 'gateway import dispatched an LLM request')
      assert(ctx.tools.schemas(handle.agent).some((schema) => schema.name === 'alpha'), 'gateway did not mount the real standard preset')
      assert.equal(session.header.agentPreset, 'standard', 'gateway did not persist the mounted preset metadata')
      assert.deepEqual(await index.get(prepared.identity.key), expectRecordState(await index.get(prepared.identity.key), 'created'))
      assert(ledgerStates.includes('prepared'), `ledger did not durably publish prepared: ${ledgerStates.join(',')}`)
      assert(ledgerStates.includes('creating'), `ledger did not durably publish creating: ${ledgerStates.join(',')}`)
      assert(ledgerStates.includes('created'), `ledger did not durably publish created: ${ledgerStates.join(',')}`)
      await ctx.sessions.flush(session)
      const persistedBeforeRestart = await readPersisted(ctx, destinationId)
      assert(persistedBeforeRestart.length >= events.length, 'flush did not durably persist the complete gateway session')
      assert((await ctx.sessionPersistence.list()).some((row) => String(row.header.id) === String(destinationId)), 'session persistence list missed gateway session')
      unregisterPoison()
      await handle.dispose()
      assert.equal(ctx.agents.get(destinationId), undefined, 'dispose left gateway agent live')
      assert((await ctx.sessionPersistence.list()).some((row) => String(row.header.id) === String(destinationId)), 'dispose removed durable session')
      await ctx.fiber.dispose()

      const resumedAdapter = new ScriptedAdapter()
      const ctx2 = await mountRuntime({ adapter: resumedAdapter, persistenceRoot, storageRoot, presets: true })
      const handles2 = []
      try {
        const index2 = await createStorageDomainImportIndex(ctx2.storageDomain)
        const unregisterPoison2 = registerPoisonReadTool(ctx2, poison)
        const listedBeforeResume = await ctx2.sessionPersistence.list()
        assert(listedBeforeResume.some((row) => String(row.header.id) === String(destinationId)), 'fresh context did not list durable session before resume')
        assert.equal((await index2.get(prepared.identity.key)).state, 'created', 'fresh context lost created ledger row')
        const resumed = await ctx2.agents.resume({
          resumeSessionId: destinationId,
          agentOptions: { provider: 'mock', model: 'mock' },
          setup: async (agentContext) => { await ctx2.agentPresets.mount(agentContext, 'standard') },
        })
        handles2.push(resumed)
        const resumedEvents = resumed.agent.session.snapshotEvents()
        const persistedSeed = persistedBeforeRestart.at(-1)?.type === 'session/end-seed'
          ? persistedBeforeRestart.slice(0, -1)
          : persistedBeforeRestart
        assert.equal(resumedEvents.length, persistedSeed.length + 1, 'resume did not retain the persisted seed plus one end-seed')
        assert.deepEqual(resumedEvents.slice(0, persistedSeed.length), persistedSeed, 'resume changed persisted seed events')
        assert.equal(resumedEvents.at(-1)?.type, 'session/end-seed', 'resume did not end with end-seed')
        assert.deepEqual(resumed.agent.session.deriveMessages(), session.deriveMessages(), 'restart resume changed derived messages')
        assert.equal(resumedAdapter.requests.length, 0, 'resume dispatched an unexpected LLM request')
        assert.equal(resumed.agent.session.header.agentPreset, 'standard', 'restart lost agent preset metadata')
        assert(ctx2.agents.list().some((agent) => agent === resumed.agent), 'resumed agent is not live in registry')
        await resumed.dispose()
        unregisterPoison2()
      } finally {
        for (const handle of handles2) await handle.dispose().catch(() => undefined)
        await ctx2.fiber.dispose()
      }
    } finally {
      if (ctx.fiber.active) await ctx.fiber.dispose().catch(() => undefined)
    }
  } finally {
    await rm(persistenceRoot, { recursive: true, force: true })
    await rm(storageRoot, { recursive: true, force: true })
  }
  assert.equal(poison.count, 0, 'historical tool handler was invoked during gateway create/flush/dispose/restart/resume')
}

function expectRecordState(record, state) {
  assert.equal(record?.state, state)
  return record
}

async function exerciseLivePersistence() {
  const persistenceRoot = await mkdtemp(join(tmpdir(), 'dsh-pinned-accept-'))
  try {
    const adapter = new ScriptedAdapter([TEXT_RESPONSE('live answer')])
    const ctx = await mountRuntime({ adapter, persistenceRoot })
    let originalCount
    try {
      const observedCreate = wrapCreateContract(ctx)
      const handle = await ctx.agents.create({
        sessionId: SessionId('pinned-live'),
        meta: { cwd: process.cwd() },
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      assert(observedCreate(), 'live create contract was not observed')
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'Answer with the scripted response.' }],
        source: { kind: 'user' },
      }))
      await handle.agent.whenIdle()
      assert.equal(adapter.requests.length, 1, 'live followup did not dispatch exactly one request')
      assert.equal(adapter.requests[0].provider, 'mock')
      assert.equal(adapter.requests[0].model, 'mock')
      assert(handle.agent.session.deriveMessages().length > 0, 'live deriveMessages returned no messages')
      const events = handle.agent.session.snapshotEvents()
      assert(events.some((item) => item.type === 'request/header'), 'live request header was not recorded')
      assert(events.some((item) => item.type === 'assistant/message' && Array.isArray(item.data?.stream)), 'live assistant stream was not recorded')
      assertDenseSeed(events)
      await ctx.sessions.flush(handle.agent.session)
      const listed = await ctx.sessionPersistence.list()
      assert(listed.some((item) => String(item.header.id) === 'pinned-live'), 'persisted session was not listed')
      originalCount = events.length
      await handle.dispose()
    } finally {
      await ctx.fiber.dispose()
    }

    const resumedAdapter = new ScriptedAdapter()
    const resumedCtx = await mountRuntime({ adapter: resumedAdapter, persistenceRoot })
    try {
      const resumed = await resumedCtx.agents.resume({
        resumeSessionId: SessionId('pinned-live'),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      assert(resumed.agent.session.snapshotEvents().length >= originalCount, 'resume lost persisted events')
      assert(resumed.agent.session.deriveMessages().length > 0, 'resume deriveMessages returned no messages')
      assert.equal(resumedAdapter.requests.length, 0, 'resume dispatched an unexpected LLM request')
      assert(resumedCtx.agents.list().includes(resumed.agent), 'resumed agent is not live in registry')
      await resumed.dispose()
    } finally {
      await resumedCtx.fiber.dispose()
    }
  } finally {
    await rm(persistenceRoot, { recursive: true, force: true })
  }
}

/**
 * End-to-end bridge acceptance: a real disposable Codex home and Git checkout
 * go through discovery, repository preview, deterministic Smart analysis and
 * Full create against the real pinned DSH Agent/Session implementation.
 */
async function exerciseCodexRepositoryE2E() {
  const codexHome = await mkdtemp(join(tmpdir(), 'dsh-pinned-codex-home-'))
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'dsh-pinned-e2e-repo-'))
  const persistenceRoot = await mkdtemp(join(tmpdir(), 'dsh-pinned-e2e-persist-'))
  const storageRoot = await mkdtemp(join(tmpdir(), 'dsh-pinned-e2e-storage-'))
  let ctx
  let ctx2
  try {
    await git(repositoryRoot, ['init'])
    await git(repositoryRoot, ['config', 'user.email', 'e2e@example.invalid'])
    await git(repositoryRoot, ['config', 'user.name', 'DSH E2E'])
    const sourceFile = join(repositoryRoot, 'task.txt')
    await writeFile(sourceFile, 'unfinished task\n', 'utf8')
    await git(repositoryRoot, ['add', 'task.txt'])
    await git(repositoryRoot, ['commit', '-m', 'fixture'])
    const repoBefore = (await git(repositoryRoot, ['status', '--porcelain', '-z'])).stdout
    const sourceBefore = await readFile(sourceFile)

    const sessionsRoot = join(codexHome, 'sessions', '2026', '09', '05')
    const archivedRoot = join(codexHome, 'archived_sessions')
    await mkdir(sessionsRoot, { recursive: true })
    await mkdir(archivedRoot, { recursive: true })
    const rolloutPath = join(sessionsRoot, 'rollout-e2e.jsonl')
    const rollout = [
      { timestamp: '2026-09-05T10:00:00.000Z', ordinal: 0, type: 'session_meta', payload: { id: 'e2e-source-session', cwd: repositoryRoot, timestamp: '2026-09-05T10:00:00.000Z', cli_version: '0.1.0', source: 'cli', provider: 'openai', model: 'test' } },
      { timestamp: '2026-09-05T10:00:01.000Z', ordinal: 1, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect the unfinished task.' }] } },
      { timestamp: '2026-09-05T10:00:02.000Z', ordinal: 2, type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":"cat task.txt"}', call_id: 'history-call-1' } },
      { timestamp: '2026-09-05T10:00:03.000Z', ordinal: 3, type: 'response_item', payload: { type: 'function_call_output', call_id: 'history-call-1', output: 'unfinished task' } },
      { timestamp: '2026-09-05T10:00:04.000Z', ordinal: 4, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The task is unfinished.' }] } },
    ].map(item => JSON.stringify(item)).join('\n') + '\n'
    await writeFile(rolloutPath, rollout, 'utf8')
    await writeFile(join(codexHome, 'session_index.jsonl'), JSON.stringify({ id: 'e2e-source-session', thread_name: 'E2E unfinished task', updated_at: '2026-09-05T10:00:04.000Z' }) + '\n', 'utf8')

    const resolver = await import(pathToFileURL(join(repoRoot, 'dist', 'codex', 'resolver.js')).href)
    const repoModule = await import(pathToFileURL(join(repoRoot, 'dist', 'repo', 'inspector.js')).href)
    const engineModule = await import(pathToFileURL(join(repoRoot, 'dist', 'handoff', 'engine.js')).href)
    const gatewayModule = await import(pathToFileURL(join(repoRoot, 'dist', 'dsh', 'gateway.js')).href)
    const hostModule = await import(pathToFileURL(join(repoRoot, 'dist', 'host', 'remote.js')).href)
    const source = new resolver.CodexSessionSource({
      home: codexHome,
      sessions: join(codexHome, 'sessions'),
      archivedSessions: archivedRoot,
      sessionIndex: join(codexHome, 'session_index.jsonl'),
    })
    const discovered = await source.discover({ archived: 'all', limit: 10, includeMessageIndex: false })
    assert.equal(discovered.items.length, 1, 'E2E discovery did not find the disposable Codex rollout')
    const item = discovered.items[0]
    assert(item, 'E2E discovery returned no selected item')
    const sourceRef = {
      discoveryId: item.discoveryId,
      source: 'codex',
      sessionId: item.sessionId,
      rolloutRevisionId: item.rolloutRevisionId,
      expectedFingerprint: item.fingerprint,
      archived: item.archived,
    }
    const adapter = new ScriptedAdapter()
    ctx = await mountRuntime({ adapter, persistenceRoot, storageRoot, presets: true })
    const handles = []
    const createCalls = []
    const index = await gatewayModule.createStorageDomainImportIndex(ctx.storageDomain)
    const gateway = new gatewayModule.DshSessionGateway(gatewayRuntime(ctx, handles, createCalls), {
      index,
      fingerprint: async request => request.sourceFingerprint,
    })
    const remote = new hostModule.CodexHandoffRemoteService({
      source,
      repository: new repoModule.GitRepositoryInspector(),
      engine: new engineModule.SmartHandoffEngine(),
      gateway,
    })
    const preview = await remote.preview({ source: sourceRef })
    assert.equal(preview.source.sessionId, item.sessionId, 'E2E preview selected the wrong source')
    assert.equal(preview.repository?.cwd.canonical.toLowerCase(), repositoryRoot.toLowerCase(), 'E2E preview used the wrong repository')
    const smart = await remote.analyze({
      source: sourceRef,
      cwd: repositoryRoot,
      expectedFingerprint: item.fingerprint,
      useModel: false,
      consent: { disclosureVersion: 'smart-v1', accepted: true, acceptedMode: 'smart', modelAnalysis: false, fullPersistence: false },
    })
    assert(smart.manifest !== undefined, 'E2E deterministic Smart analysis produced no manifest')
    assert.equal(adapter.requests.length, 0, 'deterministic Smart analysis called the model')
    const fullRequest = {
      source: sourceRef,
      cwd: repositoryRoot,
      expectedFingerprint: item.fingerprint,
      mode: 'full',
      consent: { disclosureVersion: 'full-v1', accepted: true, acceptedMode: 'full', modelAnalysis: false, fullPersistence: true },
      full: { confirmedLarge: true },
    }
    const first = await remote.create(fullRequest)
    assert.equal(first.state, 'created', 'E2E Full import did not create a DSH session')
    const second = await remote.create(fullRequest)
    assert.equal(second.state, 'existing', 'E2E same-key Full import was not idempotent')
    assert.equal(createCalls.length, 1, 'E2E idempotent retry created a duplicate Agent')
    const destinationId = SessionId(first.sessionId)
    const handle = handles[0]
    assert(handle, 'E2E gateway did not retain the real Agent handle')
    await ctx.sessions.flush(handle.agent.session)
    assert.equal((await git(repositoryRoot, ['status', '--porcelain', '-z'])).stdout, repoBefore, 'E2E import mutated the real Git repository')
    assert.deepEqual(await readFile(sourceFile), sourceBefore, 'E2E import mutated the Codex source repository file')
    const persisted = await readPersisted(ctx, destinationId)
    assert(persisted.length > 0, 'E2E Full session was not durably persisted')
    const poisoned = { count: 0 }
    const unregisterPoison = registerPoisonReadTool(ctx, poisoned, 'shell')
    await handle.dispose()
    unregisterPoison()
    await ctx.fiber.dispose()
    ctx = undefined

    const resumedAdapter = new ScriptedAdapter([TEXT_RESPONSE('continued')])
    ctx2 = await mountRuntime({ adapter: resumedAdapter, persistenceRoot, storageRoot, presets: true })
    const resumed = await ctx2.agents.resume({
      resumeSessionId: destinationId,
      agentOptions: { provider: 'mock', model: 'mock' },
      setup: async agentContext => { await ctx2.agentPresets.mount(agentContext, 'standard') },
    })
    const beforeFollowup = resumed.agent.session.snapshotEvents().length
    assert.equal(resumedAdapter.requests.length, 0, 'E2E resume dispatched an LLM request')
    const resumedPoison = { count: 0 }
    const unregisterResumedPoison = registerPoisonReadTool(ctx2, resumedPoison, 'shell')
    resumed.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue' }], source: { kind: 'user' } }))
    await resumed.agent.whenIdle()
    assert.equal(resumedAdapter.requests.length, 1, 'E2E explicit post-resume turn did not use normal DSH Agent flow')
    assert(resumed.agent.session.snapshotEvents().length > beforeFollowup, 'E2E post-resume turn produced no events')
    assert.equal(poisoned.count, 0, 'E2E historical tool was replayed during import/resume')
    assert.equal(resumedPoison.count, 0, 'E2E historical tool was replayed during the explicit continuation')
    unregisterResumedPoison()
    await resumed.dispose()
  } finally {
    if (ctx?.fiber.active) await ctx.fiber.dispose().catch(() => undefined)
    if (ctx2?.fiber.active) await ctx2.fiber.dispose().catch(() => undefined)
    await Promise.all([
      rm(codexHome, { recursive: true, force: true }),
      rm(repositoryRoot, { recursive: true, force: true }),
      rm(persistenceRoot, { recursive: true, force: true }),
      rm(storageRoot, { recursive: true, force: true }),
    ])
  }
}

const normalized = makeNormalizedSession()
const compilation = new FullTrajectorySeedCompiler({ includeNotice: true }).compileDetailed(normalized)
const seed = compilation.seed
assertSeedContract(seed, compilation)
await exerciseOfficialBundlePatch()
await exerciseSeedAndPreset(seed)
await exerciseLivePersistence()
await exerciseGatewayLifecycle(normalized, seed)
await exerciseCodexRepositoryE2E()
console.log('pinned DSH acceptance passed: seed, poison history, preset mount, live stream, gateway ledger, storage-domain restart/resume, disposable Codex/Git discover-preview-Smart-Full-idempotent E2E')
