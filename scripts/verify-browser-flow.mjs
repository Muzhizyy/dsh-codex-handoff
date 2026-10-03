/*
 * Real-browser integration of the packed 0.2.0-rc.2 plugin in the installed
 * DeepSeek Harness Web profile. All DSH and Codex state is isolated under a
 * freshly-created system-temp directory; Chrome gets an ephemeral context.
 */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = '0.2.0-rc.2'
const archiveName = `dsh-codex-handoff-${version}.tgz`
const archivePath = join(repoRoot, 'artifacts', archiveName)
const desktopRoot = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness')
const desktopExe = join(desktopRoot, 'DeepSeek Harness.exe')
const appArchive = join(desktopRoot, 'resources', 'app.asar')
const cliEntry = join(desktopRoot, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
const chromePath = process.env.DSH_CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const browserRequire = createRequire(process.env.DSH_BROWSER_TOOLS_PACKAGE ?? join(repoRoot, 'package.json'))
const { chromium } = browserRequire('playwright-core')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function inside(child, parent) {
  const suffix = relative(resolve(parent), resolve(child))
  return suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
}

function samePath(left, right) {
  const a = resolve(left).replace(/[\\/]+$/u, '')
  const b = resolve(right).replace(/[\\/]+$/u, '')
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function safeText(value) {
  return String(value)
    .replace(/(?:Bearer\s+)[^\s"']+/giu, 'Bearer [redacted]')
    .replace(/(?:api[_-]?key|token|authorization|cookie)(\s*[:=]\s*)[^\s,;"']+/giu, '$1[redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/giu, value => {
      try {
        const url = new URL(value)
        return `${url.protocol}//${url.host}${url.pathname}`
      } catch { return '[url]' }
    })
}

function pluginMethods(request) {
  const found = []
  const visit = (value, depth = 0) => {
    if (depth > 6 || value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }
    for (const [key, item] of Object.entries(value)) {
      if (key === 'method' && typeof item === 'string' && /codexHandoff/iu.test(item)) found.push(item)
      else visit(item, depth + 1)
    }
  }
  try { visit(request.postDataJSON()) } catch { /* non-JSON and GET requests are not plugin RPCs */ }
  return [...new Set(found)]
}

function sanitizedRpcErrors(value) {
  const errors = []
  const visit = (item, inError = false, depth = 0) => {
    if (depth > 8 || item === null) return
    if (typeof item === 'string') {
      const trimmed = item.trim().replace(/^data:\s*/u, '')
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try { visit(JSON.parse(trimmed), inError, depth + 1) } catch { /* ordinary text is not structured evidence */ }
      }
      return
    }
    if (typeof item !== 'object') return
    if (Array.isArray(item)) {
      for (const child of item) visit(child, inError, depth + 1)
      return
    }
    const record = item
    const code = typeof record.code === 'string' ? record.code : undefined
    const message = typeof record.message === 'string' ? record.message : undefined
    if (code !== undefined || inError && message !== undefined) {
      errors.push({ ...(code === undefined ? {} : { code: safeText(code).slice(0, 160) }), ...(message === undefined ? {} : { message: safeText(message).slice(0, 800) }) })
    }
    for (const [key, child] of Object.entries(record)) visit(child, inError || key.toLowerCase() === 'error', depth + 1)
  }
  visit(value)
  return errors
}

function parseRpcResponseText(text) {
  try { return [JSON.parse(text)] } catch { /* try newline/SSE JSON below */ }
  const values = []
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed === '[DONE]' || trimmed.startsWith('event:') || trimmed.startsWith(':')) continue
    const candidate = trimmed.replace(/^data:\s*/u, '')
    try { values.push(JSON.parse(candidate)) } catch { /* non-JSON protocol line */ }
  }
  return values
}

function cleanEnvironment(testHome, modelUrl) {
  const allowed = new Set([
    'APPDATA', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH', 'PATHEXT',
    'PROGRAMFILES', 'PROGRAMFILES(X86)', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR',
  ])
  const base = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
    allowed.has(key.toUpperCase()) && value !== undefined))
  return {
    ...base,
    DSH_HOME: testHome,
    DSH_AGENTS_HOME: join(testHome, 'agents'),
    CODEX_HOME: join(testHome, 'codex'),
    DSH_TELEMETRY_DISABLED: '1',
    DEEPSEEK_API_KEY: 'keyless-smoke-no-call',
    DEEPSEEK_BASE_URL: modelUrl,
    ELECTRON_RUN_AS_NODE: '1',
  }
}

function appServerEnvironment(testHome, modelUrl) {
  const allowed = new Set([
    'APPDATA', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH', 'PATHEXT',
    'PROGRAMFILES', 'PROGRAMFILES(X86)', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR',
  ])
  const environment = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]))
  for (const [key, value] of Object.entries(process.env)) {
    if (allowed.has(key.toUpperCase()) && value !== undefined) environment[key] = value
  }
  Object.assign(environment, {
    DSH_HOME: testHome,
    DSH_AGENTS_HOME: join(testHome, 'agents'),
    CODEX_HOME: join(testHome, 'codex'),
    DSH_TELEMETRY_DISABLED: '1',
    DEEPSEEK_API_KEY: 'keyless-smoke-no-call',
    DEEPSEEK_BASE_URL: modelUrl,
  })
  return environment
}

async function requirePath(path, label) {
  try { await access(path) } catch { throw new Error(`${label} is unavailable`) }
}

function startOwnedChild(executable, args, options) {
  return spawn(executable, args, {
    ...options,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

async function runCli(testHome, modelUrl, args, label, timeoutMs = 120_000) {
  const child = startOwnedChild(desktopExe, ['--expose-internals', cliEntry, ...args], {
    cwd: testHome,
    env: cleanEnvironment(testHome, modelUrl),
  })
  let output = ''
  child.stdout?.on('data', chunk => { if (output.length < 64_000) output += String(chunk) })
  child.stderr?.on('data', chunk => { if (output.length < 64_000) output += String(chunk) })
  const code = await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      void terminateOwned(child).finally(() => reject(new Error(`installed Desktop CLI ${label} timed out`)))
    }, timeoutMs)
    child.once('error', error => { clearTimeout(timer); reject(new Error(`installed Desktop CLI ${label} could not start (${error.code ?? 'unknown'})`)) })
    child.once('exit', (exitCode, signal) => { clearTimeout(timer); resolveExit({ exitCode, signal }) })
  })
  if (code.exitCode !== 0) throw new Error(`installed Desktop CLI ${label} failed (exit ${code.exitCode ?? code.signal}); ${safeText(output).slice(-1000)}`)
  return output
}

function waitExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise(resolveExit => child.once('exit', resolveExit))
}

async function terminateOwned(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32' && child.pid !== undefined) {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    await new Promise(resolveExit => { killer.once('error', resolveExit); killer.once('exit', resolveExit) })
  } else child.kill('SIGTERM')
  await Promise.race([waitExit(child), new Promise(resolveExit => setTimeout(resolveExit, 5_000))])
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await Promise.race([waitExit(child), new Promise(resolveExit => setTimeout(resolveExit, 5_000))])
  }
  assert(child.exitCode !== null || child.signalCode !== null, 'owned Web process did not terminate')
}

async function freePort() {
  const server = createServer()
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  assert(address !== null && typeof address !== 'string', 'port probe returned no TCP address')
  const port = address.port
  await new Promise((resolveClose, reject) => server.close(error => error === undefined ? resolveClose() : reject(error)))
  return port
}

async function hashFile(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function prepareSyntheticCodexHome(testHome) {
  const codexHome = join(testHome, 'codex')
  await mkdir(codexHome, { recursive: true })
  return { codexHome }
}

async function createCodexSourceThread(testHome, modelUrl, workspace) {
  const { createCodexAppServer } = await import(pathToFileURL(join(repoRoot, 'dist', 'codex', 'app-server.js')).href)
  const { CodexSessionSource } = await import(pathToFileURL(join(repoRoot, 'dist', 'codex', 'resolver.js')).href)
  const server = await createCodexAppServer({
    codexHome: join(testHome, 'codex'),
    env: appServerEnvironment(testHome, modelUrl),
  })
  let threadId
  const title = `Synthetic browser flow source ${Date.now()}`
  try {
    const transport = server.transport
    assert(transport !== null && typeof transport?.request === 'function', 'official Codex app-server transport is unavailable')
    const started = await transport.request('thread/start', {
      cwd: workspace,
      ephemeral: false,
      approvalPolicy: 'never',
      sandbox: 'read-only',
    })
    threadId = started?.thread?.id
    assert(typeof threadId === 'string' && threadId.length > 0, 'official Codex app-server did not start a persistent source thread')
    await server.injectUserContext(threadId, `${title}. Synthetic task only; no model or tool run is requested.`)
  } finally {
    await server.close()
  }
  const source = new CodexSessionSource({ codexHome: join(testHome, 'codex') })
  const page = await source.discover({ search: title, archived: 'active', limit: 200, includeMessageIndex: true })
  const summary = page.items.find(item => item.sessionId === threadId)
  assert(summary !== undefined, 'Codex app-server source thread is not discoverable through the handoff resolver')
  const descriptor = (await source.resolver.inventory()).find(item => item.sessionId === threadId)
  assert(descriptor?.path !== undefined, 'Codex app-server source rollout is missing from resolver inventory')
  const sourceSha256 = await hashFile(descriptor.path)
  const sourceRef = {
    discoveryId: summary.discoveryId,
    source: 'codex',
    sessionId: summary.sessionId,
    rolloutRevisionId: summary.rolloutRevisionId,
    expectedFingerprint: summary.fingerprint,
    archived: false,
  }
  const loaded = await source.load(sourceRef)
  assert(loaded.timeline.some(item => item.kind === 'message' && item.role === 'user' && item.text.includes(title)), 'resolver did not load the synthetic source body')
  assert(!loaded.timeline.some(item => item.kind === 'tool'), 'synthetic source unexpectedly contains a tool event')
  return {
    codexHome: join(testHome, 'codex'),
    workspace,
    threadId,
    title,
    source,
    descriptor,
    sourceRef,
    sourceSha256,
    sourceCwd: loaded.source.cwd,
  }
}

async function createCommittedWorkspace(root, testHome, modelUrl) {
  const workspace = join(root, 'committed-git-workspace')
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'README.md'), 'Isolated browser acceptance workspace.\n', 'utf8')
  const gitEnv = {
    ...cleanEnvironment(testHome, modelUrl),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: 'NUL',
    GIT_AUTHOR_NAME: 'DSH Browser Acceptance',
    GIT_AUTHOR_EMAIL: 'browser-acceptance@localhost.invalid',
    GIT_COMMITTER_NAME: 'DSH Browser Acceptance',
    GIT_COMMITTER_EMAIL: 'browser-acceptance@localhost.invalid',
  }
  for (const args of [['init', '-q', workspace], ['-C', workspace, 'add', 'README.md'], ['-C', workspace, 'commit', '-qm', 'Create isolated acceptance workspace']]) {
    try {
      execFileSync('git', args, { cwd: root, env: gitEnv, stdio: 'ignore', timeout: 15_000, windowsHide: true })
    } catch (error) {
      throw new Error(`could not commit isolated browser workspace (${error?.code ?? 'unknown'})`)
    }
  }
  return workspace
}

function startRejectingModelServer() {
  const requests = []
  const server = createServer((request, response) => {
    requests.push({ method: request.method ?? 'UNKNOWN', path: new URL(request.url ?? '/', 'http://127.0.0.1').pathname })
    request.resume()
    response.writeHead(503, { 'content-type': 'application/json' })
    response.end('{"error":"browser-flow smoke forbids model inference"}')
  })
  return new Promise((resolveServer, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') { reject(new Error('model rejection server did not bind')); return }
      resolveServer({ server, url: `http://127.0.0.1:${address.port}/v1`, requests })
    })
  })
}

async function launchWeb(testHome, modelUrl, webCwd) {
  const port = await freePort()
  const child = startOwnedChild(desktopExe, ['--expose-internals', cliEntry, '--profile', 'web', '--no-open', '--port', String(port)], {
    cwd: webCwd,
    env: cleanEnvironment(testHome, modelUrl),
  })
  let output = ''
  let ready = false
  const observe = chunk => {
    output += String(chunk)
    if (output.length > 24_000) output = output.slice(-24_000)
    if (/dsh web:\s+https?:\/\//u.test(output)) ready = true
  }
  child.stdout?.on('data', observe)
  child.stderr?.on('data', observe)
  try {
    const deadline = Date.now() + 60_000
    while (!ready && Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`installed Web profile exited before readiness; ${safeText(output).slice(-1_000)}`)
      await new Promise(resolveDelay => setTimeout(resolveDelay, 250))
    }
    if (!ready) throw new Error(`installed Web profile did not report readiness; ${safeText(output).slice(-1_000)}`)
    const readyLine = output.match(/dsh web:\s+(https?:\/\/[^\s)]+)/u)
    assert(readyLine?.[1] !== undefined, 'Web profile readiness line did not include its private authenticated URL')
    const authenticatedUrl = new URL(readyLine[1])
    assert(['127.0.0.1', 'localhost', '::1'].includes(authenticatedUrl.hostname), 'Web profile announced a non-loopback browser URL')
    assert(authenticatedUrl.port === String(port), 'Web profile readiness URL does not match the owned test port')
    assert(authenticatedUrl.searchParams.has('token'), 'Web profile readiness URL is missing its authentication token')
    return { child, port, url: authenticatedUrl.origin, launchUrl: authenticatedUrl.href, getOutput: () => output }
  } catch (error) {
    await terminateOwned(child).catch(() => undefined)
    throw error
  }
}

async function verifyCodexBranch(source, forkId, receiptId) {
  const descriptors = await source.source.resolver.inventory()
  const derived = descriptors.find(item => item.sessionId === forkId && item.parsed?.metadata?.id === forkId)
  assert(derived !== undefined, 'Codex reported success but the exact derived thread is absent from resolver inventory')
  const forkText = await readFile(derived.path, 'utf8')
  assert(forkText.includes(`dsh-codex-handoff:receipt=${receiptId}`), 'derived rollout does not persist the exact fresh handoff receipt context')
  assert(forkText.includes(source.title), 'derived rollout does not persist the synthetic source body in its prepared context')
  const normalized = await source.source.resolver.resolveLogicalThread(forkId)
  assert(!normalized.session.timeline.some(item => item.kind === 'tool'), 'derived Codex thread contains a replayed tool event')
  assert(await hashFile(source.descriptor.path) === source.sourceSha256, 'Codex return modified the source rollout')
  return { path: derived.path, sessionId: derived.parsed.metadata.id }
}

async function main() {
  assert(process.platform === 'win32', 'real installed Desktop browser flow requires native Windows Node.js')
  const tempBase = await realpath(tmpdir())
  const tempHome = await mkdtemp(join(tempBase, 'dsh-codex-browser-flow-'))
  const testHome = join(tempHome, 'dsh-home')
  const artifactDir = join(tempHome, 'artifacts')
  await mkdir(testHome, { recursive: true })
  await mkdir(artifactDir, { recursive: true })
  const realTestHome = await realpath(testHome)
  assert(inside(realTestHome, tempBase), 'isolated DSH home must be beneath the system temp directory')
  assert(!samePath(realTestHome, join(homedir(), '.dsh')), 'refusing to use the default DSH home')
  await Promise.all([
    requirePath(desktopExe, 'installed DeepSeek Harness executable'),
    requirePath(appArchive, 'installed DeepSeek Harness archive'),
    requirePath(chromePath, 'installed Chrome browser'),
    requirePath(archivePath, 'prebuilt plugin archive'),
  ])
  assert(basename(archivePath) === archiveName, 'packed plugin version does not match the installed test')
  const archiveHashBefore = await hashFile(archivePath)
  await prepareSyntheticCodexHome(testHome)
  const model = await startRejectingModelServer()
  const modelUrl = model.url
  let source
  let committedWorkspace
  let web
  let browser
  let context
  let page
  let forkRollout
  const pageErrors = []
  const consoleErrors = []
  const failedLocalResponses = []
  const deniedExternalRequests = []
  const pluginRpcResponses = []
  const rpcResponseReads = []
  const screenshots = []
  const captureScreenshot = async name => {
    await page.screenshot({ path: join(artifactDir, name), fullPage: true })
    screenshots.push(name)
  }
  let failure
  try {
    committedWorkspace = await createCommittedWorkspace(tempHome, testHome, modelUrl)
    await runCli(testHome, modelUrl, ['plugin', '--profile', 'web', 'add', archivePath], 'isolated plugin add')
    const manifestPath = join(testHome, 'profiles', 'web', 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    assert(manifest.dependencies?.['dsh-codex-handoff'] !== undefined, 'installed profile manifest does not contain the packed plugin')
    assert(manifest.dsh?.profile?.bundles?.filter(name => name === 'dsh-codex-handoff').length === 1, 'installed profile does not have exactly one plugin bundle')
    const installedPackage = JSON.parse(await readFile(join(testHome, 'profiles', 'web', 'node_modules', 'dsh-codex-handoff', 'package.json'), 'utf8'))
    assert(installedPackage.version === version, `loaded package version is not ${version}`)
    source = await createCodexSourceThread(testHome, modelUrl, committedWorkspace)

    web = await launchWeb(testHome, modelUrl, committedWorkspace)
    browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    context = await browser.newContext({
      viewport: { width: 1680, height: 1000 }, locale: 'en-US', timezoneId: 'Asia/Shanghai', acceptDownloads: false,
    })
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: web.url })
    page = await context.newPage()
    page.on('pageerror', error => pageErrors.push(safeText(error.message)))
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(safeText(message.text())) })
    page.on('response', response => {
      if (new URL(response.url()).origin === web.url && response.status() >= 400) {
        failedLocalResponses.push(`${response.request().method()} ${new URL(response.url()).pathname} => ${response.status()}`)
      }
      const request = response.request()
      const methods = pluginMethods(request)
      const responsePath = new URL(response.url()).pathname
      if (methods.length > 0 && /\/api(?:\/|$)/u.test(responsePath)) {
        const readResponse = (async () => {
          let responseText = ''
          try { responseText = await response.text() } catch { /* body may be unavailable after navigation */ }
          const responseValues = parseRpcResponseText(responseText)
          const rpcErrors = responseValues.flatMap(sanitizedRpcErrors)
          const isCreate = methods.some(method => /codexHandoff(?:\/|\.)create$/iu.test(method))
          pluginRpcResponses.push({
            path: responsePath,
            methods,
            status: response.status(),
            contentType: response.headers()['content-type'] ?? 'unknown',
            errors: rpcErrors,
            ...(isCreate ? { responseTextPreview: safeText(responseText).slice(0, 1_000) } : {}),
          })
        })().catch(() => undefined)
        rpcResponseReads.push(readResponse)
      }
    })
    page.on('requestfailed', request => {
      if (new URL(request.url()).origin === web.url) failedLocalResponses.push(`${request.method()} ${new URL(request.url()).pathname} => request failed`)
    })
    await page.route('**/*', async route => {
      const raw = route.request().url()
      let parsed
      try { parsed = new URL(raw) } catch { await route.abort(); return }
      if (parsed.protocol === 'data:' || parsed.protocol === 'blob:'
        || parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1') {
        await route.continue()
      } else {
        deniedExternalRequests.push(`${parsed.protocol}//${parsed.host}`)
        await route.abort('blockedbyclient')
      }
    })
    await page.goto(web.launchUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const openHandoff = page.getByRole('button', { name: 'Continue from Codex', exact: true })
    try {
      await openHandoff.waitFor({ state: 'visible', timeout: 30_000 })
    } catch {
      const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 1_200)
      throw new Error(`installed plugin action did not load into the Web UI; visible page text: ${safeText(body)}`)
    }
    const previewNotice = page.getByText(/Preview Notice/iu).first()
    await previewNotice.waitFor({ state: 'visible', timeout: 10_000 })
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await previewNotice.waitFor({ state: 'hidden', timeout: 10_000 })
    await captureScreenshot('01-plugin-loaded-after-notice.png')
    await page.locator('[data-composer-input][contenteditable="true"]').waitFor({ state: 'visible', timeout: 20_000 })
    await captureScreenshot('02-web-ready-owned-workspace.png')

    await openHandoff.click()
    const dialog = page.getByRole('dialog', { name: 'Continue from Codex' })
    await dialog.waitFor({ state: 'visible', timeout: 10_000 })
    const sourceRow = dialog.locator(`button[data-session-id="${source.threadId}"]`)
    await sourceRow.waitFor({ state: 'visible', timeout: 20_000 })
    await sourceRow.click()
    await dialog.getByRole('region', { name: 'Preview' }).waitFor({ state: 'visible', timeout: 20_000 })
    await dialog.locator('details.dsh-codex-handoff-options > summary').click()
    await dialog.getByRole('radio', { name: 'Full', exact: true }).check()
    await captureScreenshot('03-full-preview.png')
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click()
    await dialog.getByRole('button', { name: 'Create session', exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Create session', exact: true }).click()
    const createState = await Promise.race([
      dialog.waitFor({ state: 'hidden', timeout: 60_000 }).then(() => 'created').catch(() => 'timeout'),
      dialog.getByRole('alert').waitFor({ state: 'visible', timeout: 60_000 }).then(() => 'error').catch(() => 'timeout'),
    ])
    if (createState === 'error') {
      const alertText = (await dialog.getByRole('alert').allInnerTexts()).map(safeText).join(' | ')
      await Promise.allSettled(rpcResponseReads)
      throw new Error(`Full import showed a UI error: ${alertText}; plugin RPC response evidence: ${JSON.stringify(pluginRpcResponses)}`)
    }
    if (createState !== 'created') {
      await Promise.allSettled(rpcResponseReads)
      throw new Error(`Full import timed out without closing or showing an alert; plugin RPC response evidence: ${JSON.stringify(pluginRpcResponses)}`)
    }
    await page.getByRole('button', { name: 'Sync to Codex', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
    await captureScreenshot('04-created-session.png')

    await page.getByRole('button', { name: 'Sync to Codex', exact: true }).click()
    const returnDialog = page.getByRole('dialog', { name: 'Sync to Codex' })
    await returnDialog.waitFor({ state: 'visible', timeout: 10_000 })
    await returnDialog.getByRole('button', { name: 'Create Codex branch', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
    const contextDetails = returnDialog.locator('details').filter({ has: returnDialog.locator('summary').filter({ hasText: /^Prepared context and details$/u }) })
    await contextDetails.locator('summary').click()
    const receiptRow = contextDetails.locator('dt').filter({ hasText: /^Receipt ID$/u }).locator('xpath=following-sibling::dd[1]')
    const receiptId = (await receiptRow.innerText()).trim()
    assert(receiptId.length > 0, 'return preview did not expose its durable receipt ID')
    await captureScreenshot('05-return-preview.png')
    await returnDialog.getByRole('button', { name: 'Create Codex branch', exact: true }).click()
    await returnDialog.getByText('A Codex branch was created with the latest progress.', { exact: true }).waitFor({ state: 'visible', timeout: 90_000 })
    await returnDialog.locator('summary').filter({ hasText: /^Technical details$/u }).click()
    const forkIdRow = returnDialog.locator('dt').filter({ hasText: 'Codex branch ID' }).locator('xpath=following-sibling::dd[1]')
    const forkId = (await forkIdRow.innerText()).trim()
    assert(forkId.length > 0, 'success view did not display the created Codex branch ID')
    const resumeInput = returnDialog.getByLabel('Resume command (select to copy)')
    await resumeInput.waitFor({ state: 'visible' })
    const resumeCommand = await resumeInput.inputValue()
    assert(resumeCommand.includes('resume') && resumeCommand.includes(forkId), 'success view does not expose a resume command for its created branch')
    await captureScreenshot('06-return-success.png')
    await returnDialog.getByRole('button', { name: 'Copy resume command', exact: true }).click()
    await returnDialog.getByText('Resume command copied.', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
    const clipboardValue = await page.evaluate(() => navigator.clipboard.readText())
    assert(clipboardValue === resumeCommand, 'copied resume command differs from the displayed command')

    await Promise.allSettled(rpcResponseReads)
    assert(model.requests.length === 0, `unexpected model inference request(s): ${JSON.stringify(model.requests)}`)
    assert(deniedExternalRequests.length === 0, `browser attempted external network access: ${[...new Set(deniedExternalRequests)].join(', ')}`)
    assert(failedLocalResponses.length === 0, `local UI/API request failures: ${failedLocalResponses.join('; ')}`)
    assert(pageErrors.length === 0, `browser page errors: ${pageErrors.join('; ')}`)
    assert(consoleErrors.length === 0, `browser console errors: ${consoleErrors.join('; ')}`)
    forkRollout = await verifyCodexBranch(source, forkId, receiptId)
    assert(await hashFile(archivePath) === archiveHashBefore, 'plugin archive changed during browser acceptance')
  } catch (error) {
    failure = error
    if (page !== undefined) {
      try { await captureScreenshot('failure.png') } catch { /* browser already closed */ }
    }
  } finally {
    try { await context?.close() } catch { /* preserve the scenario failure */ }
    try { await browser?.close() } catch { /* preserve the scenario failure */ }
    if (web !== undefined) {
      try { await terminateOwned(web.child) } catch (error) { failure ??= error }
    }
    await new Promise(resolveClose => model.server.close(() => resolveClose()))
  }
  const evidence = {
    status: failure === undefined ? 'passed' : 'failed',
    version,
    failure: failure === undefined ? undefined : safeText(failure instanceof Error ? failure.message : failure),
    ownedWebOutputTail: safeText(web?.getOutput() ?? '').slice(-8_000),
    sourceThreadId: source?.threadId,
    derivedThreadId: forkRollout?.sessionId,
    modelRequests: model.requests,
    browserConsoleErrors: consoleErrors,
    browserPageErrors: pageErrors,
    failedLocalResponses,
    deniedExternalOrigins: [...new Set(deniedExternalRequests)],
    pluginRpcResponses,
    screenshots,
  }
  try {
    await writeFile(join(artifactDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  } catch (error) {
    failure ??= new Error(`could not write sanitized browser evidence report (${error?.code ?? 'unknown'})`)
  }
  if (failure !== undefined) {
    const suffix = `; evidence directory: ${artifactDir}; model requests: ${model.requests.length}; browser console errors: ${consoleErrors.length}; page errors: ${pageErrors.length}; failed local responses: ${failedLocalResponses.length}; external browser requests blocked: ${deniedExternalRequests.length}`
    throw new Error(`${safeText(failure instanceof Error ? failure.message : failure)}${suffix}`)
  }
  process.stdout.write(`REAL BROWSER FLOW PASSED: installed ${version} archive loaded in isolated DSH Web profile; UI Full import, return preview/branch creation, copied resume command; 0 model calls, 0 external browser requests, exact derived Codex thread ${forkRollout.sessionId}; screenshots and sanitized evidence: ${artifactDir}\n`)
}

await main()
