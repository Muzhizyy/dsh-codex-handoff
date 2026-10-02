import { promises as fs } from 'node:fs'
import path from 'node:path'
import { HARD_LIMITS, DEFAULT_LIMITS, utf8ByteLength } from '../shared/limits.js'
import type { Diagnostic, PathChange, RepositoryState } from '../shared/types.js'
import {
  canonicalizeCwd,
  checkDirectoryWritable,
  inspectRelevantPath,
  isPathWithin,
} from './paths.js'
import { parsePorcelainV2, parseRecentCommits } from './porcelain.js'
import { SpawnGitProcessAdapter, type GitProcessAdapter, type ProcessRequest, type ProcessResult } from './process.js'

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_OUTPUT_CAP_BYTES = 16 * 1024 * 1024
const DEFAULT_RECENT_COMMITS = 20

export interface GitRepositoryInspectorOptions {
  readonly processAdapter?: GitProcessAdapter
  /** Alias retained for ergonomic dependency injection in tests. */
  readonly process?: GitProcessAdapter
  readonly timeoutMs?: number
  readonly outputCapBytes?: number
  readonly recentCommitLimit?: number
  readonly now?: () => Date
}

function bounded(value: string, maximum: number): string {
  if (utf8ByteLength(value) <= maximum) return value
  let output = ''
  let bytes = 0
  for (const character of value) {
    const next = utf8ByteLength(character)
    if (bytes + next > maximum) break
    output += character
    bytes += next
  }
  return output
}

function diagnostic(code: string, message: string, recoverable: boolean, type?: string): Diagnostic {
  const base: Diagnostic = {
    code: bounded(code, 128),
    severity: recoverable ? 'warning' : 'error',
    message: bounded(message, HARD_LIMITS.diagnosticMessageChars),
    recoverable,
  }
  return type === undefined ? base : { ...base, record: { type } }
}

function text(value: Uint8Array | string): string {
  return typeof value === 'string' ? value : new globalThis.TextDecoder('utf-8', { fatal: false }).decode(value)
}

function outputFailure(result: ProcessResult, operation: string): Diagnostic | undefined {
  if (result.aborted) return diagnostic('CANCELLED', `${operation} was cancelled.`, true, 'git')
  if (result.timedOut) return diagnostic('GIT_INSPECTION_FAILED', `${operation} timed out.`, true, 'git')
  if (result.outputTruncated) return diagnostic('GIT_INSPECTION_FAILED', `${operation} exceeded its output limit.`, true, 'git')
  if (result.errorCode !== undefined) return diagnostic('GIT_INSPECTION_FAILED', `${operation} could not start.`, true, 'git')
  return undefined
}

function gitOptions(): string[] {
  // These options are all read-only and disable process-spawning Git features
  // such as external diff, textconv and fsmonitor hooks.
  return [
    '--no-pager',
    '--no-optional-locks',
    '-c', 'core.pager=cat',
    '-c', 'color.ui=false',
    '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'diff.external=',
    '-c', 'diff.textconv=',
    '-c', 'credential.helper=',
    '-c', 'protocol.allow=never',
  ]
}

function commandArgs(args: readonly string[]): string[] {
  return ['-C', args[0] ?? '', ...gitOptions(), ...args.slice(1)]
}

function relativePathChanges(changes: readonly PathChange[]): PathChange[] {
  return changes.map(item => {
    const pathName = item.path.split('\\').join('/')
    const oldPath = item.oldPath === undefined ? undefined : item.oldPath.split('\\').join('/')
    return oldPath === undefined ? { ...item, path: pathName } : { ...item, path: pathName, oldPath }
  })
}

/**
 * Deterministic read-only Git/filesystem observer. All Git invocations go
 * through the injectable argv-only adapter, making command allowlisting and
 * zero-mutation behavior testable without a live repository.
 */
export class GitRepositoryInspector {
  private readonly adapter: GitProcessAdapter
  private readonly timeoutMs: number
  private readonly outputCapBytes: number
  private readonly recentCommitLimit: number
  private readonly now: () => Date

  constructor(options: GitRepositoryInspectorOptions | GitProcessAdapter = {}) {
    const config: GitRepositoryInspectorOptions = 'run' in options ? { processAdapter: options } : options
    this.adapter = config.processAdapter ?? config.process ?? new SpawnGitProcessAdapter()
    this.timeoutMs = Math.max(1, config.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    this.outputCapBytes = Math.max(1, Math.min(config.outputCapBytes ?? DEFAULT_OUTPUT_CAP_BYTES, HARD_LIMITS.seedEventBytes))
    this.recentCommitLimit = Math.max(0, Math.min(config.recentCommitLimit ?? DEFAULT_RECENT_COMMITS, HARD_LIMITS.records))
    this.now = config.now ?? (() => new Date())
  }

  async inspect(cwd: string, relevantPaths: readonly string[], signal: AbortSignal = new AbortController().signal): Promise<RepositoryState> {
    const observedAt = this.now().toISOString()
    if (cwd.trim().length === 0) {
      return {
        observedAt,
        cwd: { requested: cwd, canonical: path.resolve(cwd), exists: false, writable: false },
        relevantPaths: [],
        diagnostics: [diagnostic('CWD_REQUIRED', 'A working directory is required.', false, 'cwd')],
      }
    }
    let resolved
    try {
      resolved = await canonicalizeCwd(cwd)
    } catch {
      resolved = { requested: cwd, canonical: path.resolve(cwd), exists: false, isDirectory: false, isSymbolicLink: false }
    }
    const diagnostics: Diagnostic[] = []
    if (!resolved.exists) {
      diagnostics.push(diagnostic('CWD_NOT_FOUND', 'The requested working directory does not exist.', false, 'cwd'))
      return { observedAt, cwd: { requested: cwd, canonical: resolved.canonical, exists: false, writable: false }, relevantPaths: [], diagnostics }
    }
    if (!resolved.isDirectory) {
      diagnostics.push(diagnostic('CWD_NOT_FOUND', 'The requested working directory is not a directory.', false, 'cwd'))
      return { observedAt, cwd: { requested: cwd, canonical: resolved.canonical, exists: true, writable: false }, relevantPaths: [], diagnostics }
    }

    const writable = await checkDirectoryWritable(resolved.canonical)
    const state: RepositoryState = {
      observedAt,
      cwd: { requested: cwd, canonical: resolved.canonical, exists: true, writable },
      relevantPaths: [],
      diagnostics,
    }
    if (signal.aborted) {
      state.diagnostics.push(diagnostic('CANCELLED', 'Repository inspection was cancelled.', true, 'repo'))
      return state
    }

    const rootResult = await this.runGit(['rev-parse', '--show-toplevel'], resolved.canonical, signal)
    const rootFailure = outputFailure(rootResult, 'Git repository detection')
    if (rootFailure !== undefined) {
      state.diagnostics.push(rootFailure)
      if (rootResult.errorCode === 'ENOENT') state.diagnostics.push(diagnostic('GIT_INSPECTION_FAILED', 'Git is not available.', true, 'git'))
      return await this.observeRelevantWithoutGit(state, resolved.canonical, relevantPaths, signal)
    }
    if (rootResult.exitCode !== 0) {
      state.diagnostics.push(diagnostic('NOT_A_GIT_REPOSITORY', 'The working directory is not a Git repository.', true, 'git'))
      return await this.observeRelevantWithoutGit(state, resolved.canonical, relevantPaths, signal)
    }

    const rootCandidate = removeSingleTrailingNewline(text(rootResult.stdout))
    let repoRoot: string
    try {
      repoRoot = await fs.realpath(rootCandidate)
    } catch {
      state.diagnostics.push(diagnostic('GIT_INSPECTION_FAILED', 'Git returned an unusable repository root.', true, 'git'))
      return await this.observeRelevantWithoutGit(state, resolved.canonical, relevantPaths, signal)
    }
    if (!isPathWithin(repoRoot, resolved.canonical)) {
      state.diagnostics.push(diagnostic('GIT_INSPECTION_FAILED', 'Git repository root does not contain the requested cwd.', true, 'git'))
      return await this.observeRelevantWithoutGit(state, resolved.canonical, relevantPaths, signal)
    }

    const gitState: NonNullable<RepositoryState['git']> = {
      repoRoot,
      detached: false,
      head: '',
      dirty: false,
      modified: [],
      added: [],
      deleted: [],
      renamed: [],
      untracked: [],
      staged: [],
      unstaged: [],
      recentCommits: [],
    }
    state.git = gitState

    const branch = await this.runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], resolved.canonical, signal)
    const branchFailure = outputFailure(branch, 'Git branch inspection')
    if (branchFailure !== undefined) state.diagnostics.push(branchFailure)
    else if (branch.exitCode === 0) {
      const name = removeSingleTrailingNewline(text(branch.stdout))
      if (name.length > 0) gitState.branch = bounded(name, 1024)
    } else gitState.detached = true

    const head = await this.runGit(['rev-parse', 'HEAD'], resolved.canonical, signal)
    const headFailure = outputFailure(head, 'Git HEAD inspection')
    if (headFailure !== undefined) state.diagnostics.push(headFailure)
    else if (head.exitCode === 0) gitState.head = bounded(removeSingleTrailingNewline(text(head.stdout)), 256)

    const status = await this.runGit(['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=all', '--'], resolved.canonical, signal)
    const statusFailure = outputFailure(status, 'Git status inspection')
    if (statusFailure !== undefined) state.diagnostics.push(statusFailure)
    else if (status.exitCode === 0) {
      const parsed = parsePorcelainV2(status.stdout)
      gitState.modified = relativePathChanges(parsed.modified)
      gitState.added = relativePathChanges(parsed.added)
      gitState.deleted = relativePathChanges(parsed.deleted)
      gitState.renamed = relativePathChanges(parsed.renamed)
      gitState.untracked = relativePathChanges(parsed.untracked)
      gitState.staged = parsed.staged.map(item => item.split('\\').join('/'))
      gitState.unstaged = parsed.unstaged.map(item => item.split('\\').join('/'))
      state.diagnostics.push(...parsed.diagnostics)
    } else state.diagnostics.push(diagnostic('GIT_INSPECTION_FAILED', 'Git status inspection failed.', true, 'git'))

    if (this.recentCommitLimit > 0) {
      const log = await this.runGit(['log', '-n', String(this.recentCommitLimit), '--format=%H%x00%aI%x00%s%x00', '--no-decorate', '--'], resolved.canonical, signal)
      const logFailure = outputFailure(log, 'Git recent commit inspection')
      if (logFailure !== undefined) state.diagnostics.push(logFailure)
      else if (log.exitCode === 0) {
        const parsed = parseRecentCommits(log.stdout)
        gitState.recentCommits = parsed.commits
        state.diagnostics.push(...parsed.diagnostics)
      } else state.diagnostics.push(diagnostic('GIT_INSPECTION_FAILED', 'Git recent commit inspection failed.', true, 'git'))
    }

    gitState.dirty = gitState.modified.length > 0 || gitState.added.length > 0 || gitState.deleted.length > 0 || gitState.renamed.length > 0 || gitState.untracked.length > 0 || gitState.staged.length > 0 || gitState.unstaged.length > 0
    await this.observeRelevant(state, repoRoot, relevantPaths, signal)
    return state
  }

  private async observeRelevantWithoutGit(state: RepositoryState, cwd: string, relevantPaths: readonly string[], signal: AbortSignal): Promise<RepositoryState> {
    await this.observeRelevant(state, cwd, relevantPaths, signal)
    return state
  }

  private async observeRelevant(state: RepositoryState, root: string, relevantPaths: readonly string[], signal: AbortSignal): Promise<void> {
    const limit = Math.min(relevantPaths.length, DEFAULT_LIMITS.filesScanned)
    if (relevantPaths.length > limit) state.diagnostics.push(diagnostic('GIT_INSPECTION_FAILED', 'Some relevant paths were omitted by the inspection limit.', true, 'filesystem'))
    for (const requestedPath of relevantPaths.slice(0, limit)) {
      if (signal.aborted) {
        state.diagnostics.push(diagnostic('CANCELLED', 'Repository inspection was cancelled.', true, 'filesystem'))
        return
      }
      const observation = await inspectRelevantPath(root, requestedPath, state.observedAt)
      state.relevantPaths.push(observation.value)
      state.diagnostics.push(...observation.diagnostics)
    }
  }

  private async runGit(args: readonly string[], cwd: string, signal: AbortSignal): Promise<ProcessResult> {
    const request: ProcessRequest = {
      command: 'git',
      args: commandArgs([cwd, ...args]),
      cwd,
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.outputCapBytes,
      signal,
    }
    try {
      return await this.adapter.run(request)
    } catch (error) {
      return {
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        exitCode: null,
        errorCode: error instanceof Error ? error.name : 'PROCESS_FAILED',
      }
    }
  }
}

export const inspectRepository = async (
  cwd: string,
  relevantPaths: readonly string[] = [],
  signal?: AbortSignal,
  options?: GitRepositoryInspectorOptions,
): Promise<RepositoryState> => new GitRepositoryInspector(options).inspect(cwd, relevantPaths, signal ?? new AbortController().signal)

export const RepositoryInspectorImpl = GitRepositoryInspector

function removeSingleTrailingNewline(value: string): string {
  return value.endsWith('\r\n') ? value.slice(0, -2) : value.endsWith('\n') ? value.slice(0, -1) : value
}
