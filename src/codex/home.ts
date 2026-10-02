import path from 'node:path'
import os from 'node:os'
import { realpath } from 'node:fs/promises'
import { HandoffError } from '../shared/errors.js'

/** Inputs accepted by the home resolver.  Tests may provide an environment and
 * platform explicitly; production callers can omit both. */
export interface CodexHomeOptions {
  readonly codexHome?: string
  readonly config?: { readonly codexHome?: string }
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly platform?: string
  readonly homeDirectory?: string
  readonly canonicalize?: boolean
}

export interface CodexHomeResolution {
  readonly path: string
  readonly source: 'config' | 'environment' | 'default'
  readonly exists: boolean
  readonly canonical: boolean
}

export interface CodexRoots {
  readonly home: string
  readonly sessions: string
  readonly archivedSessions: string
  readonly sessionIndex: string
}

const runtimeProcess = (globalThis as unknown as { process?: { readonly env: Record<string, string | undefined>; readonly platform: string } }).process

function candidateFromOptions(options: CodexHomeOptions): { value?: string; source: CodexHomeResolution['source'] } {
  if (options.codexHome !== undefined) return { value: options.codexHome, source: 'config' }
  if (options.config?.codexHome !== undefined) return { value: options.config.codexHome, source: 'config' }
  const env = options.env ?? runtimeProcess?.env ?? {}
  if (env.CODEX_HOME !== undefined && env.CODEX_HOME.trim() !== '') return { value: env.CODEX_HOME, source: 'environment' }
  const home = options.homeDirectory ?? os.homedir()
  // Codex uses .codex on all supported OSes.  `path.join` also retains drive
  // and UNC semantics on Windows, and does not lower-case display paths.
  return { value: path.join(home, '.codex'), source: 'default' }
}

function assertAbsolute(candidate: string, pathApi: { isAbsolute(value: string): boolean; normalize(value: string): string } = path): string {
  const value = candidate.trim()
  if (value === '' || !pathApi.isAbsolute(value)) throw new Error('CODEX_HOME must be an absolute path')
  return pathApi.normalize(value)
}

/** Resolve CODEX_HOME without probing arbitrary files under the user's home. */
export async function resolveCodexHome(options: CodexHomeOptions = {}): Promise<CodexHomeResolution> {
  const selected = candidateFromOptions(options)
  const requested = resolveCodexHomePath(options)
  const shouldCanonicalize = options.canonicalize ?? true
  let resolved = requested
  let canonical = false
  let exists = false
  try {
    const actual = await realpath(requested)
    resolved = actual
    canonical = true
    exists = true
  } catch (error: unknown) {
    const code = error instanceof Error && 'code' in error ? String((error as Error & { code?: unknown }).code) : ''
    if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'EACCES' && code !== 'EPERM') throw error
    // An absent home is a normal discovery state.  Keep a normalized absolute
    // path so callers can report CODEX_HOME_NOT_FOUND without scanning a fallback.
    if (code === 'EACCES' || code === 'EPERM') throw new HandoffError({ code: 'CODEX_ACCESS_DENIED', message: 'The configured Codex home cannot be accessed.', recoverable: true, cause: error })
  }
  if (!shouldCanonicalize) {
    resolved = requested
    canonical = false
  }
  return { path: resolved, source: selected.source, exists, canonical }
}

export function codexRoots(home: string): CodexRoots {
  const normalized = assertAbsolute(home)
  return {
    home: normalized,
    sessions: path.join(normalized, 'sessions'),
    archivedSessions: path.join(normalized, 'archived_sessions'),
    sessionIndex: path.join(normalized, 'session_index.jsonl'),
  }
}

export const resolveCodexRoots = codexRoots

/** Pure path variant for callers that only need deterministic precedence. */
export function resolveCodexHomePath(options: CodexHomeOptions = {}): string {
  const selected = candidateFromOptions(options)
  const pathApi = options.platform === 'win32' ? path.win32 : path
  return assertAbsolute(selected.value ?? '', pathApi)
}

export class CodexHomeResolver {
  readonly options: CodexHomeOptions
  constructor(options: CodexHomeOptions = {}) { this.options = options }
  resolve(): Promise<CodexHomeResolution> { return resolveCodexHome(this.options) }
  path(): string { return resolveCodexHomePath(this.options) }
  roots(): CodexRoots { return codexRoots(this.path()) }
}
