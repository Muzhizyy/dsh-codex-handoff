import { promises as fs } from 'node:fs'
import path from 'node:path'

import { HARD_LIMITS, utf8ByteLength } from '../shared/limits.js'
import type { Diagnostic, RepositoryState } from '../shared/types.js'

/** The result of resolving a user supplied working directory without creating it. */
export interface CanonicalCwd {
  readonly requested: string
  readonly canonical: string
  readonly exists: boolean
  readonly isDirectory: boolean
  readonly isSymbolicLink: boolean
}

export interface RelevantPathObservation {
  readonly value: NonNullable<RepositoryState['relevantPaths'][number]>
  readonly diagnostics: readonly Diagnostic[]
}

const WINDOWS = path.sep === '\\'

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

function normalizeForComparison(value: string): string {
  const resolved = path.resolve(value)
  return WINDOWS ? resolved.toLocaleLowerCase('en-US') : resolved
}

/**
 * Returns true when `candidate` is the directory itself or a descendant of
 * `root`.  Comparison is case insensitive on Windows, while display paths
 * are never lower-cased.
 */
export function isPathWithin(root: string, candidate: string): boolean {
  const normalizedRoot = normalizeForComparison(root)
  const normalizedCandidate = normalizeForComparison(candidate)
  if (normalizedRoot === normalizedCandidate) return true
  const relative = path.relative(normalizedRoot, normalizedCandidate)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** Convert Git's slash-separated path to a stable relative display path. */
export function toRepoRelative(root: string, candidate: string): string {
  const relative = path.relative(root, candidate)
  return (relative === '' ? '.' : relative).split(path.sep).join('/')
}

/**
 * Best-effort sensitive-path policy.  The inspector never reads file
 * contents, but denying these paths also prevents future callers from
 * accidentally turning lstat observations into secret disclosure.
 */
export function sensitivePathReason(candidate: string): string | undefined {
  const segments = candidate
    .replaceAll('\\', '/')
    .split('/')
    .filter(segment => segment.length > 0)
  for (const segment of segments) {
    const lower = segment.toLocaleLowerCase('en-US')
    if (lower === '.git' || lower === '.ssh' || lower === '.aws' || lower === '.kube') {
      return 'path is inside a sensitive directory'
    }
    if (/^\.env(?:\.|$)/i.test(segment)) return 'path matches the .env secret policy'
    if (/^(?:auth|credential|credentials|secret|secrets|token|tokens)\.(?:json|ya?ml|toml|ini|cfg)$/i.test(segment)) {
      return 'path matches the credentials/secret policy'
    }
    if (/^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|known_hosts)$/i.test(segment)) {
      return 'path matches the private-key policy'
    }
    if (/(?:^|[._-])(?:credential|credentials|secret|secrets|token|tokens)(?:[._-]|$)/i.test(segment)) {
      return 'path matches the credentials/secret policy'
    }
    if (/\.(?:pem|key|p12|pfx|jks|kdbx)$/i.test(segment)) return 'path matches the private-key policy'
  }
  return undefined
}

function diagnostic(code: string, message: string, recoverable: boolean): Diagnostic {
  return {
    code: bounded(code, 128),
    severity: recoverable ? 'warning' : 'error',
    message: bounded(message, HARD_LIMITS.diagnosticMessageChars),
    recoverable,
  }
}

async function isMissing(error: unknown): Promise<boolean> {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  return (error as { code?: unknown }).code === 'ENOENT'
}

/** Resolve a path's real parent, preserving the fact that its leaf is absent. */
async function realpathOfExistingParent(candidate: string): Promise<string | undefined> {
  let current = candidate
  while (true) {
    try {
      return await fs.realpath(current)
    } catch (error) {
      if (!(await isMissing(error))) return undefined
      const parent = path.dirname(current)
      if (parent === current) return undefined
      current = parent
    }
  }
}

/**
 * Canonicalize cwd using realpath for an existing directory.  Missing paths
 * are not created: their absolute lexical path is returned with exists=false
 * so callers can show a selection error and stop before invoking Git.
 */
export async function canonicalizeCwd(requested: string): Promise<CanonicalCwd> {
  const lexical = path.resolve(requested)
  try {
    const stats = await fs.lstat(lexical)
    try {
      const canonical = await fs.realpath(lexical)
      const isDirectory = stats.isSymbolicLink()
        ? (await fs.stat(lexical)).isDirectory()
        : stats.isDirectory()
      return {
        requested,
        canonical,
        exists: true,
        isDirectory,
        isSymbolicLink: stats.isSymbolicLink(),
      }
    } catch {
      // lstat succeeded but canonicalization failed (permission/race/dangling
      // link). Do not expose a stale positive fact: callers must fail closed.
      return {
        requested,
        canonical: lexical,
        exists: false,
        isDirectory: false,
        isSymbolicLink: false,
      }
    }
  } catch (error) {
    if (!(await isMissing(error))) throw error
    const canonicalParent = await realpathOfExistingParent(path.dirname(lexical))
    return {
      requested,
      canonical: canonicalParent === undefined ? lexical : path.join(canonicalParent, path.basename(lexical)),
      exists: false,
      isDirectory: false,
      isSymbolicLink: false,
    }
  }
}

/** Backwards-compatible descriptive aliases for consumers that prefer domain names. */
export const canonicalizeWorkingDirectory = canonicalizeCwd
export const isSensitivePath = sensitivePathReason

interface FileStats {
  readonly size: number
  isSymbolicLink(): boolean
  isFile(): boolean
  isDirectory(): boolean
}

function pathKind(stats: FileStats): 'file' | 'directory' | 'symlink' | 'other' {
  if (stats.isSymbolicLink()) return 'symlink'
  if (stats.isFile()) return 'file'
  if (stats.isDirectory()) return 'directory'
  return 'other'
}

/** Observe a relevant path with lstat and containment checks, never reading content. */
export async function inspectRelevantPath(
  repoRoot: string,
  requestedPath: string,
  observedAt: string,
): Promise<RelevantPathObservation> {
  try {
    const lexical = path.resolve(repoRoot, requestedPath)
    const displayPath = toRepoRelative(repoRoot, lexical)
    const deniedReason = sensitivePathReason(displayPath)
    if (deniedReason !== undefined) {
      return {
        value: { path: bounded(displayPath, 4096), exists: false, observedAt },
        diagnostics: [diagnostic('GIT_INSPECTION_FAILED', `Relevant path denied: ${deniedReason}.`, true)],
      }
    }
    if (!isPathWithin(repoRoot, lexical)) {
      return {
        value: { path: bounded(displayPath, 4096), exists: false, observedAt },
        diagnostics: [diagnostic('GIT_INSPECTION_FAILED', 'Relevant path is outside the repository root.', true)],
      }
    }

    let stats: FileStats
    try {
      stats = await fs.lstat(lexical)
    } catch (error) {
      if (await isMissing(error)) {
        const parentTarget = await realpathOfExistingParent(path.dirname(lexical))
        if (parentTarget === undefined || !isPathWithin(repoRoot, parentTarget)) {
          return {
            value: { path: bounded(displayPath, 4096), exists: false, observedAt },
            diagnostics: [diagnostic('GIT_INSPECTION_FAILED', 'Relevant path resolves outside the repository.', true)],
          }
        }
        return { value: { path: bounded(displayPath, 4096), exists: false, observedAt }, diagnostics: [] }
      }
      return {
        value: { path: bounded(displayPath, 4096), exists: false, observedAt },
        diagnostics: [diagnostic('GIT_INSPECTION_FAILED', 'Relevant path could not be inspected.', true)],
      }
    }

    // Resolve the leaf (or nearest existing parent for a race) before
    // exposing any fact. A symlink/junction that escapes is denied.
    const resolvedTarget = await realpathOfExistingParent(lexical)
    if (resolvedTarget === undefined || !isPathWithin(repoRoot, resolvedTarget)) {
      return {
        value: { path: bounded(displayPath, 4096), exists: false, observedAt },
        diagnostics: [diagnostic('GIT_INSPECTION_FAILED', 'Relevant path resolves outside the repository.', true)],
      }
    }

    const kind = pathKind(stats)
    const size = Math.min(stats.size, HARD_LIMITS.sourceFileBytes)
    return {
      value: { path: bounded(displayPath, 4096), exists: true, kind, size, observedAt },
      diagnostics: [],
    }
  } catch {
    // Hostile or racing paths stay isolated to this observation. Never allow
    // path resolution or containment failures to abort later paths.
    return {
      value: { path: bounded(requestedPath, 4096), exists: false, observedAt },
      diagnostics: [diagnostic('GIT_INSPECTION_FAILED', 'Relevant path could not be safely resolved.', true)],
    }
  }
}

/** Check directory writability without creating or modifying anything. */
export async function checkDirectoryWritable(directory: string): Promise<boolean> {
  try {
    // `2` is the POSIX/Node W_OK bit. Keeping the value local also allows the
    // browser-safe contract build to type-check without importing Node enums.
    await fs.access(directory, 2)
    return true
  } catch {
    return false
  }
}
