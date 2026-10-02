import type { Diagnostic, PathChange, RepositoryState, SessionPage, SessionPreview, SourceRef } from './types.js'
import type { JsonValue } from './schemas.js'

/** Stable marker used whenever potentially sensitive text is removed. */
export const REDACTED = '[REDACTED]' as const

const PRIVATE_KEY = /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/gi
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi
const AWS_ACCESS_KEY = /\bAKIA[0-9A-Z]{16}\b/g
const CREDENTIAL_URL = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@[^\s]+/gi
const QUOTED_SECRET = /\b(password|passwd|secret|token|api[_-]?key|access[_-]?key|authorization|credential)\s*([:=])\s*("[^"]*"|'[^']*'|`[^`]*`|[^\s,;}\]]+)/gi
const MULTILINE_SECRET = /\b(password|passwd|secret|token|api[_-]?key|access[_-]?key|authorization|credential)\s*:\s*\r?\n\s*[^\r\n]+/gi
const HIGH_ENTROPY = /(?<![A-Za-z0-9])([A-Za-z0-9+/=_\-.]{32,})(?![A-Za-z0-9])/g

function looksHighEntropy(value: string): boolean {
  if (value.length < 32 || value.length > 512) return false
  const classes = Number(/[a-z]/.test(value)) + Number(/[A-Z]/.test(value)) + Number(/[0-9]/.test(value)) + Number(/[+/=_\-.]/.test(value))
  // Hex fingerprints and ordinary lowercase identifiers are not credentials;
  // mixed-class opaque tokens are treated as secrets at a boundary.
  return classes >= 3 && !/^sha256-[a-f0-9]{32,}$/i.test(value)
}

/** Best-effort, deterministic text redaction for data crossing Host/DSH boundaries. */
export function redactText(value: string): string {
  let output = value
    .replace(PRIVATE_KEY, REDACTED)
    .replace(CREDENTIAL_URL, `$1${REDACTED}`)
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(AWS_ACCESS_KEY, REDACTED)
    .replace(MULTILINE_SECRET, match => match.replace(/:\s*[\s\S]*$/u, `: ${REDACTED}`))
    .replace(QUOTED_SECRET, (_match, name: string, separator: string) => `${name}${separator} ${REDACTED}`)
  output = output.replace(HIGH_ENTROPY, token => looksHighEntropy(token) ? REDACTED : token)
  return output
}

function redactUnknown(value: unknown, seen: WeakSet<object>, depth: number): JsonValue {
  if (depth > 12) return REDACTED
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return redactText(value)
  if (typeof value !== 'object') return REDACTED
  if (seen.has(value)) return REDACTED
  seen.add(value)
  if (Array.isArray(value)) return value.slice(0, 10_000).map(item => redactUnknown(item, seen, depth + 1))
  const output: Record<string, JsonValue> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 10_000)) {
    const safeKey = redactText(key)
    output[safeKey] = /(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|authorization|credential)/i.test(key)
      ? (typeof item === 'string' ? REDACTED : redactUnknown(item, seen, depth + 1))
      : redactUnknown(item, seen, depth + 1)
  }
  return output
}

/** Recursively sanitize a JSON-safe value while preserving its shape. */
export function redactJson<T extends JsonValue>(value: T): T {
  return redactUnknown(value, new WeakSet<object>(), 0) as T
}

/** Sanitize diagnostics before they are merged into Smart or Full outputs. */
export function redactDiagnostic(diagnostic: Diagnostic): Diagnostic {
  return {
    ...diagnostic,
    code: redactText(diagnostic.code),
    message: redactText(diagnostic.message),
    ...(diagnostic.record === undefined ? {} : {
      record: {
        ...diagnostic.record,
        ...(diagnostic.record.type === undefined ? {} : { type: redactText(diagnostic.record.type) }),
      },
    }),
  }
}

/**
 * Redact source metadata that originated in an untrusted rollout record while
 * preserving the opaque locator used to correlate a record.  Locators and
 * fingerprints are protocol identifiers, not display text; `type` is a
 * parser-provided string and must therefore cross the same boundary as any
 * other untrusted text.
 */
export function redactSourceRef(source: SourceRef): SourceRef {
  return {
    ...source,
    ...(source.type === undefined ? {} : { type: redactText(source.type) }),
  }
}

function redactRepository(repository: RepositoryState): RepositoryState {
  const redactPathChange = (change: PathChange): PathChange => ({
    ...change,
    path: redactText(change.path),
    ...(change.oldPath === undefined ? {} : { oldPath: redactText(change.oldPath) }),
  })
  const git = repository.git === undefined ? undefined : {
    ...repository.git,
    repoRoot: redactText(repository.git.repoRoot),
    ...(repository.git.branch === undefined ? {} : { branch: redactText(repository.git.branch) }),
    head: redactText(repository.git.head),
    modified: repository.git.modified.map(redactPathChange),
    added: repository.git.added.map(redactPathChange),
    deleted: repository.git.deleted.map(redactPathChange),
    renamed: repository.git.renamed.map(redactPathChange),
    untracked: repository.git.untracked.map(redactPathChange),
    staged: repository.git.staged.map(redactText),
    unstaged: repository.git.unstaged.map(redactText),
    recentCommits: repository.git.recentCommits.map(commit => ({
      ...commit,
      hash: redactText(commit.hash),
      subject: redactText(commit.subject),
    })),
  }
  return {
    ...repository,
    cwd: {
      ...repository.cwd,
      requested: redactText(repository.cwd.requested),
      canonical: redactText(repository.cwd.canonical),
    },
    ...(git === undefined ? {} : { git }),
    relevantPaths: repository.relevantPaths.map(item => ({ ...item, path: redactText(item.path) })),
    diagnostics: repository.diagnostics.map(redactDiagnostic),
  }
}

/**
 * Final preview boundary used by both the source resolver and Remote.  Keep
 * opaque IDs stable, but recursively sanitize every display/diagnostic string
 * and every parser-provided source type before it can reach UI or a caller.
 */
export function redactSessionPreview(preview: SessionPreview): SessionPreview {
  return {
    ...preview,
    source: {
      ...preview.source,
      ...(preview.source.title === undefined ? {} : { title: redactText(preview.source.title) }),
      ...(preview.source.cwd === undefined ? {} : { cwd: redactText(preview.source.cwd) }),
      ...(preview.source.cliVersion === undefined ? {} : { cliVersion: redactText(preview.source.cliVersion) }),
    },
    largestRecords: preview.largestRecords.map(item => ({ ...item, source: redactSourceRef(item.source) })),
    snippets: preview.snippets.map(item => {
      const text = redactText(item.text)
      return {
        ...item,
        source: redactSourceRef(item.source),
        text,
        redacted: item.redacted || text !== item.text,
      }
    }),
    ...(preview.repository === undefined ? {} : { repository: redactRepository(preview.repository) }),
    diagnostics: preview.diagnostics.map(redactDiagnostic),
  }
}

/** Defensive source boundary for inventory pages returned by alternate hosts. */
export function redactSessionPage(page: SessionPage): SessionPage {
  return {
    ...page,
    items: page.items.map(item => ({
      ...item,
      ...(item.title === undefined ? {} : { title: redactText(item.title) }),
      ...(item.cwd === undefined ? {} : { cwd: redactText(item.cwd) }),
      ...(item.cliVersion === undefined ? {} : { cliVersion: redactText(item.cliVersion) }),
    })),
  }
}

/** Sanitize arbitrary error details into JSON-safe data for a remote boundary. */
export function redactDetails(value: unknown): JsonValue {
  return redactUnknown(value, new WeakSet<object>(), 0)
}

/** Keep the existing flat RemoteError DTO contract while removing nested secrets. */
export function redactRemoteDetails(value: unknown): Record<string, string | number | boolean | null> | undefined {
  if (value === undefined) return undefined
  const sanitized = redactDetails(value)
  if (sanitized === null || typeof sanitized !== 'object' || Array.isArray(sanitized)) return { detail: JSON.stringify(sanitized) ?? REDACTED }
  const entries = Object.entries(sanitized).slice(0, 32)
  return Object.fromEntries(entries.map(([key, item]) => [
    key.slice(0, 128),
    typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean' || item === null
      ? item
      : JSON.stringify(item).slice(0, 4096),
  ]))
}
