import { spawn } from 'node:child_process'

export interface ProcessRequest {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly timeoutMs: number
  readonly maxOutputBytes: number
  readonly signal?: AbortSignal
  readonly env?: Readonly<Record<string, string>>
}

export interface ProcessResult {
  readonly stdout: Uint8Array | string
  readonly stderr: Uint8Array | string
  readonly exitCode: number | null
  readonly signal?: string
  readonly timedOut?: boolean
  readonly aborted?: boolean
  readonly outputTruncated?: boolean
  readonly errorCode?: string
}

export interface GitProcessAdapter {
  run(request: ProcessRequest): Promise<ProcessResult>
}

/** Safe process adapter used by GitRepositoryInspector. It never invokes a shell. */
export class SpawnGitProcessAdapter implements GitProcessAdapter {
  async run(request: ProcessRequest): Promise<ProcessResult> {
    if (request.signal?.aborted) {
      return { stdout: new Uint8Array(), stderr: new Uint8Array(), exitCode: null, aborted: true }
    }

    const output = { stdout: [] as Uint8Array[], stderr: [] as Uint8Array[] }
    let outputBytes = 0
    let truncated = false
    let timedOut = false
    let aborted = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined
    let abortListener: (() => void) | undefined
    let settled = false
    let resolveResult: (result: ProcessResult) => void = () => undefined

    // Keep a tiny structural type here so tests can spy on spawn options while
    // avoiding Node-specific process handles in the shared contracts.
    type ChildLike = {
      stdout?: { on(event: string, listener: (chunk: Uint8Array) => void): void }
      stderr?: { on(event: string, listener: (chunk: Uint8Array) => void): void }
      on(event: string, listener: (...args: unknown[]) => void): void
      once(event: string, listener: (...args: unknown[]) => void): void
      kill(signal?: string): boolean
    }
    let child: ChildLike | undefined

    const resultPromise = new Promise<ProcessResult>(resolve => {
      resolveResult = resolve
    })

    const safeEnv: Record<string, string> = {}
    // Preserve ordinary environment values (notably PATH), but force all
    // Git-interactive and optional-lock behavior to safe non-interactive modes.
    for (const [key, value] of Object.entries(process.env)) {
      // Git_* variables can redirect the repository, install external diff
      // helpers, inject config parameters, or enable tracing.  None are
      // inherited; the small allowlist below is applied after this loop.
      if (value !== undefined && !key.toLocaleUpperCase('en-US').startsWith('GIT_')) safeEnv[key] = value
    }
    if (request.env !== undefined) {
      for (const [key, value] of Object.entries(request.env)) {
        if (!key.toLocaleUpperCase('en-US').startsWith('GIT_')) safeEnv[key] = value
      }
    }
    Object.assign(safeEnv, {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '0',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_PAGER: 'cat',
      PAGER: 'cat',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never',
      GIT_EDITOR: ':',
      GIT_SEQUENCE_EDITOR: ':',
      GIT_ASKPASS: ':',
    })

    const chunks = (target: 'stdout' | 'stderr', chunk: Uint8Array): void => {
      if (settled) return
      const remaining = Math.max(0, request.maxOutputBytes - outputBytes)
      if (chunk.byteLength > remaining) {
        if (remaining > 0) output[target].push(chunk.slice(0, remaining))
        outputBytes += remaining
        truncated = true
        try {
          child?.kill('SIGTERM')
          forceKillTimer = setTimeout(() => {
            if (!settled) {
              try {
                child?.kill('SIGKILL')
              } catch {
                // Process may already have exited.
              }
            }
          }, 100)
        } catch {
          // Process may already have exited.
        }
        return
      }
      output[target].push(chunk)
      outputBytes += chunk.byteLength
    }

    const finish = (result: ProcessResult): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer)
      if (abortListener !== undefined) request.signal?.removeEventListener('abort', abortListener)
      resolveResult(result)
    }

    try {
      child = spawn(request.command, [...request.args], {
        cwd: request.cwd,
        env: safeEnv,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }) as unknown as ChildLike
    } catch (error) {
      finish({
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        exitCode: null,
        errorCode: error instanceof Error ? error.name : 'SPAWN_FAILED',
      })
      return resultPromise
    }

    child.stdout?.on('data', chunk => chunks('stdout', chunk))
    child.stderr?.on('data', chunk => chunks('stderr', chunk))
    child.once('error', (...args: unknown[]) => {
      const error = args[0]
      const errorCode = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : 'SPAWN_FAILED'
      finish({
        stdout: concat(output.stdout),
        stderr: concat(output.stderr),
        exitCode: null,
        errorCode,
        ...(truncated ? { outputTruncated: true } : {}),
        ...(timedOut ? { timedOut: true } : {}),
        ...(aborted ? { aborted: true } : {}),
      })
    })
    child.once('close', (...args: unknown[]) => {
      const code = typeof args[0] === 'number' ? args[0] : null
      const signal = typeof args[1] === 'string' ? args[1] : undefined
      const result: ProcessResult = {
        stdout: concat(output.stdout),
        stderr: concat(output.stderr),
        exitCode: code,
        ...(signal === undefined ? {} : { signal }),
        ...(truncated ? { outputTruncated: true } : {}),
        ...(timedOut ? { timedOut: true } : {}),
        ...(aborted ? { aborted: true } : {}),
      }
      finish(result)
    })

    if (request.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        try {
          child?.kill('SIGTERM')
          forceKillTimer = setTimeout(() => {
            if (!settled) {
              try {
                child?.kill('SIGKILL')
              } catch {
                // Process may already have exited.
              }
            }
          }, 100)
        } catch {
          // Process may already have exited.
        }
      }, request.timeoutMs)
    }
    if (request.signal !== undefined) {
      abortListener = () => {
        aborted = true
        try {
          child?.kill('SIGTERM')
          forceKillTimer = setTimeout(() => {
            if (!settled) {
              try {
                child?.kill('SIGKILL')
              } catch {
                // Process may already have exited.
              }
            }
          }, 100)
        } catch {
          // Process may already have exited.
        }
      }
      request.signal.addEventListener('abort', abortListener, { once: true })
      if (request.signal.aborted) abortListener()
    }
    return resultPromise
  }
}

export const SpawnProcessAdapter = SpawnGitProcessAdapter
export const NodeGitProcessAdapter = SpawnGitProcessAdapter
export const createGitProcessAdapter = (): GitProcessAdapter => new SpawnGitProcessAdapter()

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

/** Minimal deterministic fake adapter useful for tests and host integration. */
export class FakeGitProcessAdapter implements GitProcessAdapter {
  readonly requests: ProcessRequest[] = []
  private readonly handler: (request: ProcessRequest) => Promise<ProcessResult> | ProcessResult

  constructor(handler: (request: ProcessRequest) => Promise<ProcessResult> | ProcessResult) {
    this.handler = handler
  }

  run(request: ProcessRequest): Promise<ProcessResult> {
    this.requests.push(request)
    return Promise.resolve(this.handler(request))
  }
}

export function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}
