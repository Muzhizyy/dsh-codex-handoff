import { HARD_LIMITS, utf8ByteLength } from '../shared/limits.js'
import type { Diagnostic, PathChange } from '../shared/types.js'

export interface ParsedPorcelainStatus {
  readonly modified: PathChange[]
  readonly added: PathChange[]
  readonly deleted: PathChange[]
  readonly renamed: PathChange[]
  readonly untracked: PathChange[]
  readonly staged: string[]
  readonly unstaged: string[]
  readonly diagnostics: Diagnostic[]
}

function bounded(value: string, max: number): string {
  if (utf8ByteLength(value) <= max) return value
  let out = ''
  let used = 0
  for (const char of value) {
    const size = utf8ByteLength(char)
    if (used + size > max) break
    out += char
    used += size
  }
  return out
}

function diagnostic(message: string, ordinal: number): Diagnostic {
  return {
    code: 'GIT_INSPECTION_FAILED',
    severity: 'warning',
    message: bounded(message, HARD_LIMITS.diagnosticMessageChars),
    record: { ordinal, type: 'porcelain-v2' },
    recoverable: true,
  }
}

function decode(value: Uint8Array | string): string {
  if (typeof value === 'string') return value
  return new globalThis.TextDecoder('utf-8', { fatal: false }).decode(value)
}

function change(path: string, index: boolean, worktree: boolean, oldPath?: string): PathChange {
  const base: PathChange = { path: bounded(path, 4096), index, worktree }
  if (oldPath === undefined) return base
  return { ...base, oldPath: bounded(oldPath, 4096) }
}

function hasIndexChange(x: string): boolean {
  return x !== '.' && x !== '?'
}

function hasWorktreeChange(y: string): boolean {
  return y !== '.' && y !== '?'
}

/**
 * Parse Git porcelain v2 status output.  `-z` makes each record NUL
 * terminated and emits a rename's old path as the immediately following NUL
 * record; no shell or locale-dependent parsing is involved.
 */
export function parsePorcelainV2(value: Uint8Array | string): ParsedPorcelainStatus {
  const text = decode(value)
  const modified: PathChange[] = []
  const added: PathChange[] = []
  const deleted: PathChange[] = []
  const renamed: PathChange[] = []
  const untracked: PathChange[] = []
  const staged: string[] = []
  const unstaged: string[] = []
  const diagnostics: Diagnostic[] = []
  const stagedSet = new Set<string>()
  const unstagedSet = new Set<string>()
  const records = text.split('\0')

  for (let ordinal = 0; ordinal < records.length; ordinal += 1) {
    const record = records[ordinal] ?? ''
    if (record.length === 0) continue
    const tag = record[0]
    if (tag === '!' || tag === '#') continue

    if (tag === '?') {
      const path = record.startsWith('? ') ? record.slice(2) : ''
      if (path.length === 0) {
        diagnostics.push(diagnostic('Malformed untracked porcelain record.', ordinal))
        continue
      }
      untracked.push(change(path, false, true))
      continue
    }

    if (tag !== '1' && tag !== '2' && tag !== 'u') {
      diagnostics.push(diagnostic(`Unsupported porcelain record type ${tag || '(empty)'}.`, ordinal))
      continue
    }
    const fields = record.split(' ')
    const xy = fields[1]
    if (xy === undefined || xy.length !== 2) {
      diagnostics.push(diagnostic('Malformed porcelain status XY field.', ordinal))
      continue
    }
    const x = xy[0] ?? '.'
    const y = xy[1] ?? '.'
    // `u` has three stage hashes (path starts at field 10), while ordinary
    // type-1 records have two hashes (field 8) and type-2 records add a
    // rename score (field 9).
    const pathFieldIndex = tag === '2' ? 9 : tag === 'u' ? 10 : 8
    const path = fields.slice(pathFieldIndex).join(' ')
    if (path.length === 0) {
      diagnostics.push(diagnostic('Malformed porcelain status path.', ordinal))
      continue
    }
    const index = hasIndexChange(x)
    const worktree = hasWorktreeChange(y)
    if (index && !stagedSet.has(path)) {
      stagedSet.add(path)
      staged.push(path)
    }
    // Untracked files are reported separately; they are not a tracked
    // unstaged change for the purpose of RepositoryState.unstaged.
    if (worktree && !unstagedSet.has(path)) {
      unstagedSet.add(path)
      unstaged.push(path)
    }

    if (tag === '2') {
      const oldPath = records[ordinal + 1]
      ordinal += 1
      if (oldPath === undefined || oldPath.length === 0) {
        diagnostics.push(diagnostic('Rename record is missing its old path.', ordinal))
      }
      renamed.push(oldPath === undefined ? change(path, index, worktree) : change(path, index, worktree, oldPath))
      continue
    }

    const codes = `${x}${y}`
    if (codes.includes('D')) deleted.push(change(path, index, worktree))
    else if (codes.includes('A')) added.push(change(path, index, worktree))
    else modified.push(change(path, index, worktree))
  }

  return { modified, added, deleted, renamed, untracked, staged, unstaged, diagnostics }
}

export const parseGitPorcelainV2 = parsePorcelainV2
export const parsePorcelainStatus = parsePorcelainV2

export interface ParsedRecentCommit {
  readonly hash: string
  readonly subject: string
  readonly authoredAt: string
}

export function parseRecentCommits(value: Uint8Array | string): { commits: ParsedRecentCommit[]; diagnostics: Diagnostic[] } {
  const text = decode(value)
  const chunks = text.split('\0')
  const commits: ParsedRecentCommit[] = []
  const diagnostics: Diagnostic[] = []
  for (let index = 0; index + 2 < chunks.length; index += 3) {
    const hash = chunks[index] ?? ''
    const authoredAt = chunks[index + 1] ?? ''
    const subject = chunks[index + 2] ?? ''
    if (hash.length === 0 && authoredAt.length === 0 && subject.length === 0) continue
    const date = new Date(authoredAt)
    if (hash.length === 0 || !Number.isFinite(date.getTime())) {
      diagnostics.push({
        code: 'GIT_INSPECTION_FAILED',
        severity: 'warning',
        message: 'Malformed recent commit record.',
        record: { ordinal: index / 3, type: 'git-log' },
        recoverable: true,
      })
      continue
    }
    commits.push({ hash: bounded(hash, 256), subject: bounded(subject, 4096), authoredAt: date.toISOString() })
  }
  if (chunks.length > 0 && (chunks.length - 1) % 3 !== 0 && chunks.at(-1) !== '') {
    diagnostics.push({ code: 'GIT_INSPECTION_FAILED', severity: 'warning', message: 'Truncated recent commit output.', recoverable: true })
  }
  return { commits, diagnostics }
}
