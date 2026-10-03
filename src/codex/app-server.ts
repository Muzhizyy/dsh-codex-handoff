import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { HandoffError } from '../shared/errors.js'

const CLIENT_INFO = Object.freeze({ name: 'dsh-codex-handoff', title: 'DSH Codex Handoff', version: '0.2.0-rc.2' })
const MAX_RPC_LINE_BYTES = 1024 * 1024
const MAX_STDERR_BYTES = 16 * 1024
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

type JsonRecord = Record<string, unknown>

export interface AppServerRequestFailure {
  readonly sent: boolean
  readonly remote: boolean
  readonly method: string
}

export class AppServerFailure extends Error implements AppServerRequestFailure {
  readonly sent: boolean
  readonly remote: boolean
  readonly method: string

  constructor(options: AppServerRequestFailure & { readonly cause?: unknown }) {
    super('Codex app-server request did not complete.', options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AppServerFailure'
    this.sent = options.sent
    this.remote = options.remote
    this.method = options.method
  }
}

export interface JsonRpcTransport {
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>
  notify(method: string, params: unknown): void
  close(): Promise<void>
}

export interface CodexAppServerOptions {
  /** Absolute executable path, if the Host has an explicit trusted setting. */
  readonly binary?: string
  /** Exact Codex home resolved by the read-only source, passed through to Codex. */
  readonly codexHome?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly platform?: NodeJS.Platform
  readonly requestTimeoutMs?: number
  readonly createTransport?: (binary: string, args: readonly string[], env: NodeJS.ProcessEnv) => JsonRpcTransport
}

export interface CodexForkResult {
  readonly forkId: string
  readonly sourceThreadId: string
}

export interface CodexAppServer {
  readonly binary: string
  readonly codexHome: string
  fork(sourceThreadId: string, signal?: AbortSignal): Promise<CodexForkResult>
  injectUserContext(forkId: string, context: string, signal?: AbortSignal): Promise<void>
  close(): Promise<void>
}

export type AppServerTransportFactory = (binary: string, args: readonly string[], env: NodeJS.ProcessEnv) => JsonRpcTransport

function failure(code: 'CODEX_APP_SERVER_UNAVAILABLE' | 'CODEX_PROTOCOL_MISMATCH', message: string): HandoffError {
  return new HandoffError({ code, message, recoverable: true })
}

function record(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonRecord : undefined
}

function isAbsoluteFor(platform: NodeJS.Platform, candidate: string): boolean {
  return platform === 'win32' ? path.win32.isAbsolute(candidate) : path.isAbsolute(candidate)
}

function pathApi(platform: NodeJS.Platform): typeof path {
  return platform === 'win32' ? path.win32 : path
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const api = pathApi(platform)
  const a = api.normalize(left)
  const b = api.normalize(right)
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

async function executableFile(candidate: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const stat = await fs.stat(candidate)
    if (!stat.isFile()) return false
    if (platform === 'win32') return candidate.toLowerCase().endsWith('.exe')
    await fs.access(candidate, 1)
    return true
  } catch {
    return false
  }
}

/** Resolve only an executable file; never invoke PATH lookup through a shell. */
export async function resolveCodexBinary(options: Pick<CodexAppServerOptions, 'binary' | 'env' | 'platform'> = {}): Promise<string> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const configuredBinary = options.binary ?? env.CODEX_EXECUTABLE
  if (configuredBinary !== undefined) {
    if (!isAbsoluteFor(platform, configuredBinary) || !(await executableFile(configuredBinary, platform))) {
      throw failure('CODEX_APP_SERVER_UNAVAILABLE', 'The configured Codex executable is unavailable.')
    }
    return pathApi(platform).normalize(configuredBinary)
  }

  const pathValue = env.PATH ?? env.Path ?? env.path ?? ''
  const pathEntries = pathValue.split(platform === 'win32' ? ';' : path.delimiter).filter(Boolean)
  const names = platform === 'win32' ? ['codex.exe'] : ['codex']
  const api = pathApi(platform)
  for (const directory of pathEntries) {
    for (const name of names) {
      const candidate = api.join(directory, name)
      if (await executableFile(candidate, platform)) return candidate
    }
  }
  if (platform === 'win32') {
    const storeBinary = await discoverWindowsStoreBinary(env)
    if (storeBinary !== undefined) return storeBinary
  }
  throw failure('CODEX_APP_SERVER_UNAVAILABLE', 'The official Codex executable could not be found on PATH.')
}

const STORE_PACKAGE = /^OpenAI\.Codex_(\d+(?:\.\d+){3})_x64__2p2nqsd0c76g0$/i

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

function windowsAppsRoot(env: Readonly<Record<string, string | undefined>>): string {
  return path.win32.join(env.ProgramFiles ?? 'C:\\Program Files', 'WindowsApps')
}

async function discoverWindowsStoreBinary(env: Readonly<Record<string, string | undefined>>): Promise<string | undefined> {
  const root = windowsAppsRoot(env)
  try {
    const entries = await fs.readdir(root, { withFileTypes: true })
    const candidates = entries.flatMap(entry => {
      if (!entry.isDirectory()) return []
      const match = STORE_PACKAGE.exec(entry.name)
      return match === null ? [] : [{ directory: entry.name, version: match[1] as string }]
    }).sort((left, right) => compareVersions(right.version, left.version))
    for (const candidate of candidates) {
      const executable = path.win32.join(root, candidate.directory, 'app', 'resources', 'codex.exe')
      if (await executableFile(executable, 'win32')) return executable
    }
  } catch {
    // WindowsApps can deny directory enumeration even when the Store package
    // itself is executable. Fall through to a fixed, non-shell Appx query.
  }
  const installLocation = await queryStoreInstallLocation(env)
  if (installLocation === undefined || !isAbsoluteFor('win32', installLocation)) return undefined
  const normalizedRoot = path.win32.normalize(root).toLowerCase() + path.win32.sep
  const normalizedLocation = path.win32.normalize(installLocation)
  if (!normalizedLocation.toLowerCase().startsWith(normalizedRoot.toLowerCase())) return undefined
  const packageName = path.win32.basename(normalizedLocation)
  if (!STORE_PACKAGE.test(packageName)) return undefined
  const executable = path.win32.join(normalizedLocation, 'app', 'resources', 'codex.exe')
  return await executableFile(executable, 'win32') ? executable : undefined
}

async function queryStoreInstallLocation(env: Readonly<Record<string, string | undefined>>): Promise<string | undefined> {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows'
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = "$p = Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object { [version]$_.Version } -Descending | Select-Object -First 1; if ($p) { $p.InstallLocation }"
  return await new Promise(resolve => {
    let child: ChildProcess
    try {
      child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
        stdio: ['ignore', 'pipe', 'ignore'], shell: false, windowsHide: true,
        env: { ...process.env, ...env },
      })
    } catch {
      resolve(undefined)
      return
    }
    let output = ''
    let settled = false
    const finish = (value: string | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => { child.kill(); finish(undefined) }, 3_000)
    child.stdout?.on('data', (chunk: Buffer) => {
      if (output.length < 8192) output += chunk.toString('utf8').slice(0, 8192 - output.length)
      if (output.length >= 8192) { child.kill(); finish(undefined) }
    })
    child.once('error', () => finish(undefined))
    child.once('close', code => finish(code === 0 ? output.trim().split(/\r?\n/).at(-1) : undefined))
  })
}

function quoteForDisplay(value: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') return `'${value.replaceAll("'", "''")}'`
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

export function resumeResponse(binary: string, forkId: string, platform: NodeJS.Platform = process.platform): {
  readonly argv: readonly string[]
  readonly displayCommand: string
} {
  const argv = [binary, 'resume', forkId] as const
  return {
    argv,
    displayCommand: `${platform === 'win32' ? '& ' : ''}${quoteForDisplay(binary, platform)} resume ${quoteForDisplay(forkId, platform)}`,
  }
}

export function supportsPinnedProtocol(output: string): boolean {
  const match = output.match(/^\s*(?:codex(?:-cli)?\s+)?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?\s*$/i)
  if (match === null) return false

  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (![major, minor, patch].every(Number.isSafeInteger)) return false

  const prerelease = match[4]
  if (prerelease !== undefined) return match[1] === '0' && match[2] === '159' && match[3] === '0' && prerelease === 'alpha.12.1'
  return major > 0 || minor > 159 || (minor === 159 && patch >= 2)
}

function processEnvironment(options: CodexAppServerOptions): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...process.env }
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete result[key]
    else result[key] = value
  }
  if (options.codexHome !== undefined) result.CODEX_HOME = options.codexHome
  return result
}

async function probeVersion(binary: string, env: NodeJS.ProcessEnv): Promise<void> {
  const versionOutput = await runVersion(binary, env)
  if (versionOutput === undefined || !supportsPinnedProtocol(versionOutput)) {
    throw failure('CODEX_PROTOCOL_MISMATCH', 'The installed Codex version is outside the verified app-server protocol range.')
  }
}

async function probeRequiredMethods(binary: string, env: NodeJS.ProcessEnv): Promise<void> {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-codex-return-schema-'))
  try {
    const exitCode = await runBoundedProcess(binary, ['app-server', 'generate-json-schema', '--out', temporaryDirectory], env, 10_000)
    if (exitCode !== 0) throw failure('CODEX_PROTOCOL_MISMATCH', 'Installed Codex could not expose its stable app-server schema.')
    const schemaPath = path.join(temporaryDirectory, 'codex_app_server_protocol.schemas.json')
    const stats = await fs.stat(schemaPath)
    if (stats.size <= 0 || stats.size > 5 * 1024 * 1024) throw failure('CODEX_PROTOCOL_MISMATCH', 'Installed Codex app-server schema exceeded its safe inspection bound.')
    const parsed: unknown = JSON.parse(await fs.readFile(schemaPath, 'utf8'))
    const found = new Set<string>()
    collectRequestMethods(parsed, found)
    if (!found.has('thread/fork') || !found.has('thread/inject_items')) {
      throw failure('CODEX_PROTOCOL_MISMATCH', 'Installed Codex does not advertise the required stable fork/inject methods.')
    }
  } catch (error) {
    if (error instanceof HandoffError) throw error
    throw failure('CODEX_PROTOCOL_MISMATCH', 'Installed Codex app-server schema could not be validated.')
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined)
  }
}

function collectRequestMethods(value: unknown, output: Set<string>, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) collectRequestMethods(item, output, seen)
    return
  }
  const item = value as JsonRecord
  const methods = record(item.properties)?.method
  const allowed = record(methods)?.enum
  if (Array.isArray(allowed)) {
    for (const method of allowed) if (typeof method === 'string') output.add(method)
  }
  for (const nested of Object.values(item)) collectRequestMethods(nested, output, seen)
}

async function runBoundedProcess(binary: string, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<number | null> {
  return await new Promise(resolve => {
    let child: ChildProcess
    try {
      child = spawn(binary, [...args], { stdio: ['ignore', 'ignore', 'ignore'], shell: false, windowsHide: true, env })
    } catch {
      resolve(null)
      return
    }
    let settled = false
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(code)
    }
    const timer = setTimeout(() => { child.kill(); finish(null) }, timeoutMs)
    child.once('error', () => finish(null))
    child.once('close', finish)
  })
}

async function runVersion(binary: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return await new Promise(resolve => {
    let child: ChildProcess
    try {
      child = spawn(binary, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], shell: false, windowsHide: true, env })
    } catch {
      resolve(undefined)
      return
    }
    let output = ''
    const timer = setTimeout(() => { child.kill(); resolve(undefined) }, 5_000)
    child.stdout?.on('data', (chunk: Buffer) => {
      if (output.length < 4096) output += chunk.toString('utf8').slice(0, 4096 - output.length)
    })
    child.once('error', () => { clearTimeout(timer); resolve(undefined) })
    child.once('close', code => {
      clearTimeout(timer)
      resolve(code === 0 ? output.trim() : undefined)
    })
  })
}

interface PendingRequest {
  readonly method: string
  readonly resolve: (value: unknown) => void
  readonly reject: (error: AppServerFailure) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly abort?: () => void
  sent: boolean
}

class StdioJsonRpcTransport implements JsonRpcTransport {
  private nextId = 0
  private readonly pending = new Map<number, PendingRequest>()
  private readonly decoder = new TextDecoder()
  private buffered = ''
  private closed = false
  private stderrBytes = 0
  private readonly exited: Promise<void>

  constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly requestTimeoutMs: number) {
    child.stdout.on('data', (chunk: Buffer) => this.consume(chunk))
    child.stderr.on('data', (chunk: Buffer) => { this.stderrBytes = Math.min(MAX_STDERR_BYTES, this.stderrBytes + chunk.byteLength) })
    child.stdin.on('error', () => this.failAll())
    this.exited = new Promise(resolve => {
      child.once('error', () => { this.failAll(); resolve() })
      child.once('close', () => { this.failAll(); resolve() })
    })
  }

  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed || signal?.aborted === true) {
      return Promise.reject(new AppServerFailure({ sent: false, remote: false, method }))
    }
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        method,
        resolve,
        reject,
        timer: setTimeout(() => this.rejectPending(id), this.requestTimeoutMs),
        sent: false,
      }
      if (signal !== undefined) {
        const abort = (): void => this.rejectPending(id)
        signal.addEventListener('abort', abort, { once: true })
        Object.assign(pending, { abort: (): void => signal.removeEventListener('abort', abort) })
      }
      this.pending.set(id, pending)
      try {
        if (signal?.aborted === true) {
          this.rejectPending(id)
          return
        }
        pending.sent = true
        this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, error => {
          if (error !== null && error !== undefined) this.rejectPending(id)
        })
      } catch {
        this.rejectPending(id)
      }
    })
  }

  notify(method: string, params: unknown): void {
    if (this.closed) throw new AppServerFailure({ sent: false, remote: false, method })
    try {
      this.child.stdin.write(`${JSON.stringify({ method, params })}\n`)
    } catch (error) {
      throw new AppServerFailure({ sent: false, remote: false, method, cause: error })
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.failAll()
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    this.child.kill()
    await Promise.race([this.exited, new Promise<void>(resolve => setTimeout(resolve, 1_000))])
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL')
  }

  private consume(chunk: Buffer): void {
    this.buffered += this.decoder.decode(chunk, { stream: true })
    if (this.buffered.length > MAX_RPC_LINE_BYTES && !this.buffered.includes('\n')) {
      this.failAll()
      this.child.kill()
      return
    }
    for (;;) {
      const newline = this.buffered.indexOf('\n')
      if (newline < 0) break
      const line = this.buffered.slice(0, newline).trim()
      this.buffered = this.buffered.slice(newline + 1)
      if (line.length === 0) continue
      if (Buffer.byteLength(line, 'utf8') > MAX_RPC_LINE_BYTES) {
        this.failAll()
        this.child.kill()
        return
      }
      let message: JsonRecord
      try {
        const parsed: unknown = JSON.parse(line)
        const candidate = record(parsed)
        if (candidate === undefined) continue
        message = candidate
      } catch {
        this.failAll()
        this.child.kill()
        return
      }
      const id = typeof message.id === 'number' ? message.id : undefined
      if (id === undefined) continue
      const pending = this.pending.get(id)
      if (pending === undefined) continue
      this.removePending(id, pending)
      if ('error' in message) {
        pending.reject(new AppServerFailure({ sent: pending.sent, remote: true, method: pending.method }))
      } else if ('result' in message) {
        pending.resolve(message.result)
      } else {
        pending.reject(new AppServerFailure({ sent: pending.sent, remote: false, method: pending.method }))
      }
    }
  }

  private rejectPending(id: number): void {
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.removePending(id, pending)
    pending.reject(new AppServerFailure({ sent: pending.sent, remote: false, method: pending.method }))
  }

  private removePending(id: number, pending: PendingRequest): void {
    clearTimeout(pending.timer)
    pending.abort?.()
    this.pending.delete(id)
  }

  private failAll(): void {
    for (const [id, pending] of this.pending) {
      this.removePending(id, pending)
      pending.reject(new AppServerFailure({ sent: pending.sent, remote: false, method: pending.method }))
    }
  }
}

function spawnTransport(binary: string, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number): JsonRpcTransport {
  try {
    const child = spawn(binary, [...args], { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, env })
    return new StdioJsonRpcTransport(child, timeoutMs)
  } catch (error) {
    throw new AppServerFailure({ sent: false, remote: false, method: 'initialize', cause: error })
  }
}

class CodexAppServerClient implements CodexAppServer {
  private closed = false

  constructor(
    readonly binary: string,
    readonly codexHome: string,
    private readonly transport: JsonRpcTransport,
  ) {}

  async fork(sourceThreadId: string, signal?: AbortSignal): Promise<CodexForkResult> {
    const response = record(await this.transport.request('thread/fork', { threadId: sourceThreadId, excludeTurns: true }, signal))
    const thread = record(response?.thread)
    const forkId = typeof thread?.id === 'string' ? thread.id : undefined
    if (forkId === undefined || forkId.length === 0 || thread?.forkedFromId !== sourceThreadId || thread.ephemeral === true) {
      throw failure('CODEX_PROTOCOL_MISMATCH', 'Codex returned an invalid or non-derived fork response.')
    }
    return { forkId, sourceThreadId }
  }

  async injectUserContext(forkId: string, context: string, signal?: AbortSignal): Promise<void> {
    const response = await this.transport.request('thread/inject_items', {
      threadId: forkId,
      items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: context }] }],
    }, signal)
    const value = record(response)
    if (value === undefined || Object.keys(value).length !== 0) {
      throw failure('CODEX_PROTOCOL_MISMATCH', 'Codex returned an unexpected injection acknowledgement.')
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.transport.close()
  }
}

async function initializeTransport(
  transport: JsonRpcTransport,
  expectedHome: string,
  platform: NodeJS.Platform,
): Promise<string> {
  try {
    const response = record(await transport.request('initialize', {
      clientInfo: CLIENT_INFO,
      capabilities: { experimentalApi: false },
    }))
    const reportedHome = typeof response?.codexHome === 'string' ? response.codexHome : undefined
    if (reportedHome === undefined || !samePath(reportedHome, expectedHome, platform)) {
      throw failure('CODEX_PROTOCOL_MISMATCH', 'Codex app-server is using a different Codex home.')
    }
    if (typeof response?.platformFamily !== 'string' || typeof response.platformOs !== 'string' || typeof response.userAgent !== 'string') {
      throw failure('CODEX_PROTOCOL_MISMATCH', 'Codex app-server initialization did not match the verified protocol.')
    }
    transport.notify('initialized', {})
    return reportedHome
  } catch (error) {
    await transport.close().catch(() => undefined)
    if (error instanceof HandoffError) throw error
    // EOF, timeout, spawn failure, and broken stdio on the proxy path say
    // that no usable daemon connection was established; they are not evidence
    // that the installed stable protocol is incompatible. The caller may
    // safely try the isolated stdio server before any fork request is sent.
    throw error instanceof AppServerFailure
      ? error
      : new AppServerFailure({ sent: false, remote: false, method: 'initialize', cause: error })
  }
}

/** Start the official JSON-RPC app-server without a shell or credential-file access. */
export async function createCodexAppServer(options: CodexAppServerOptions = {}): Promise<CodexAppServer> {
  const platform = options.platform ?? process.platform
  const env = processEnvironment(options)
  const binary = await resolveCodexBinary({ ...(options.binary === undefined ? {} : { binary: options.binary }), env, platform })
  await probeVersion(binary, env)
  await probeRequiredMethods(binary, env)

  let expectedHome: string
  if (options.codexHome !== undefined) expectedHome = options.codexHome
  else {
    const home = env.CODEX_HOME
    if (typeof home === 'string' && home.length > 0) expectedHome = home
    else {
      const userHome = env.USERPROFILE ?? env.HOME
      if (typeof userHome !== 'string' || userHome.length === 0) throw failure('CODEX_APP_SERVER_UNAVAILABLE', 'Codex home could not be resolved safely.')
      expectedHome = pathApi(platform).join(userHome, '.codex')
    }
  }
  const canonicalExpectedHome = await fs.realpath(expectedHome).catch(() => pathApi(platform).resolve(expectedHome))
  const timeoutMs = Math.max(1, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
  const makeTransport = options.createTransport ?? ((pathName, args, processEnv) => spawnTransport(pathName, args, processEnv, timeoutMs))
  return await connectCodexAppServerTransport(binary, canonicalExpectedHome, platform, env, makeTransport)
}

/** Connect to the daemon proxy first, falling back only before any thread RPC. */
export async function connectCodexAppServerTransport(
  binary: string,
  expectedHome: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  makeTransport: AppServerTransportFactory,
): Promise<CodexAppServer> {
  for (const args of [['app-server', 'proxy'], ['app-server', '--listen', 'stdio://']] as const) {
    let transport: JsonRpcTransport
    try {
      transport = makeTransport(binary, args, env)
    } catch {
      continue
    }
    try {
      const codexHome = await initializeTransport(transport, expectedHome, platform)
      return new CodexAppServerClient(binary, codexHome, transport)
    } catch (error) {
      if (error instanceof HandoffError && error.code === 'CODEX_PROTOCOL_MISMATCH') throw error
    }
  }
  throw failure('CODEX_APP_SERVER_UNAVAILABLE', 'Codex app-server could not be started.')
}
