import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { GitRepositoryInspector } from '../../src/repo/inspector.js'
import { canonicalizeCwd, inspectRelevantPath } from '../../src/repo/paths.js'
import { FakeGitProcessAdapter, bytes } from '../../src/repo/process.js'
import { RepositoryStateSchema } from '../../src/shared/schemas.js'

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { windowsHide: true }, (error: unknown) => {
      if (error === null || error === undefined) resolve()
      else reject(error)
    })
  })
}

async function disposableRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-repo-'))
  await git(root, ['init', '-q'])
  await git(root, ['config', 'user.email', 'test@example.invalid'])
  await git(root, ['config', 'user.name', 'Test'])
  await fs.writeFile(path.join(root, 'unicode 文件.txt'), 'initial\n', 'utf8')
  await git(root, ['add', '--', 'unicode 文件.txt'])
  await git(root, ['commit', '-q', '-m', 'initial'])
  return root
}

async function removeTree(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true })
}

function hash(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

describe('GitRepositoryInspector', () => {
  it('fails closed when lstat succeeds but cwd realpath loses permission or races away', async () => {
    const root = await disposableRepo()
    try {
      const realpath = vi.spyOn(fs, 'realpath')
      realpath.mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
      const permission = await canonicalizeCwd(root)
      expect(permission.exists).toBe(false)
      expect(permission.isDirectory).toBe(false)
      realpath.mockRejectedValueOnce(Object.assign(new Error('raced away'), { code: 'ENOENT' }))
      const raced = await canonicalizeCwd(root)
      expect(raced.exists).toBe(false)
      expect(raced.isDirectory).toBe(false)
      realpath.mockRestore()
    } finally {
      await removeTree(root)
    }
  })

  it('isolates a malicious relevant-path lstat failure while retaining valid observations', async () => {
    const root = await disposableRepo()
    try {
      const originalLstat = fs.lstat
      const lstat = vi.spyOn(fs, 'lstat').mockImplementation(async candidate => {
        if (String(candidate).includes('malicious')) {
          throw Object.assign(new Error('denied'), { code: 'EACCES' })
        }
        return originalLstat(candidate)
      })
      const state = await new GitRepositoryInspector().inspect(
        root,
        ['unicode 文件.txt', 'malicious path.txt', 'missing.txt'],
        new AbortController().signal,
      )
      expect(state.relevantPaths.find(item => item.path === 'unicode 文件.txt')?.exists).toBe(true)
      expect(state.relevantPaths.find(item => item.path === 'malicious path.txt')?.exists).toBe(false)
      expect(state.relevantPaths.find(item => item.path === 'missing.txt')?.exists).toBe(false)
      expect(state.diagnostics.filter(item => item.message.includes('could not be inspected')).length).toBe(1)
      lstat.mockRestore()
    } finally {
      await removeTree(root)
    }
  })

  it('turns path-resolution and containment exceptions into bounded per-path diagnostics', async () => {
    const root = await disposableRepo()
    try {
      const originalResolve = path.resolve
      const resolve = vi.spyOn(path, 'resolve').mockImplementation((...segments: string[]) => {
        if (segments.includes('malicious-resolve')) throw new Error('path resolve denied')
        return originalResolve(...segments)
      })
      const resolved = await inspectRelevantPath(root, 'malicious-resolve', new Date().toISOString())
      expect(resolved.value.exists).toBe(false)
      expect(resolved.diagnostics).toHaveLength(1)
      resolve.mockRestore()

      const originalRelative = path.relative
      const relative = vi.spyOn(path, 'relative').mockImplementation((from: string, to: string) => {
        if (to.includes('malicious-containment')) throw new Error('containment race')
        return originalRelative(from, to)
      })
      const contained = await inspectRelevantPath(root, 'malicious-containment', new Date().toISOString())
      expect(contained.value.exists).toBe(false)
      expect(contained.diagnostics).toHaveLength(1)
      relative.mockRestore()

      const valid = await inspectRelevantPath(root, 'unicode 文件.txt', new Date().toISOString())
      expect(valid.value.exists).toBe(true)
      expect(valid.diagnostics).toHaveLength(0)
    } finally {
      await removeTree(root)
    }
  })

  it('observes a clean and dirty repository, including Unicode and spaces', async () => {
    const root = await disposableRepo()
    try {
      const inspector = new GitRepositoryInspector()
      const clean = await inspector.inspect(root, ['unicode 文件.txt', 'missing.txt'], new AbortController().signal)
      expect(RepositoryStateSchema.safeParse(clean).success).toBe(true)
      expect(clean.git?.branch).toBeTruthy()
      expect(clean.git?.dirty).toBe(false)
      expect(clean.git?.recentCommits[0]?.subject).toBe('initial')
      expect(clean.relevantPaths.find(item => item.path === 'unicode 文件.txt')?.kind).toBe('file')
      expect(clean.relevantPaths.find(item => item.path === 'missing.txt')?.exists).toBe(false)

      await fs.writeFile(path.join(root, 'unicode 文件.txt'), 'changed\n', 'utf8')
      await fs.writeFile(path.join(root, '-dash path.txt'), 'untracked\n', 'utf8')
      const dirty = await inspector.inspect(root, ['-dash path.txt'], new AbortController().signal)
      expect(dirty.git?.dirty).toBe(true)
      expect(dirty.git?.modified.map(item => item.path)).toContain('unicode 文件.txt')
      expect(dirty.git?.untracked.map(item => item.path)).toContain('-dash path.txt')
    } finally {
      await removeTree(root)
    }
  })

  it('reports staged and worktree rename categories from porcelain v2', async () => {
    const root = await disposableRepo()
    try {
      await git(root, ['mv', 'unicode 文件.txt', 'renamed 文件.txt'])
      const state = await new GitRepositoryInspector().inspect(root, [], new AbortController().signal)
      expect(state.git?.renamed[0]).toMatchObject({ path: 'renamed 文件.txt', oldPath: 'unicode 文件.txt', index: true, worktree: false })
      expect(state.git?.staged).toContain('renamed 文件.txt')
    } finally {
      await removeTree(root)
    }
  })

  it('reports detached, non-Git and missing cwd states', async () => {
    const root = await disposableRepo()
    const nonGit = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-non-git-'))
    try {
      await git(root, ['checkout', '-q', '--detach', 'HEAD'])
      const inspector = new GitRepositoryInspector()
      const detached = await inspector.inspect(root, [], new AbortController().signal)
      expect(detached.git?.detached).toBe(true)
      const plain = await inspector.inspect(nonGit, [], new AbortController().signal)
      expect(plain.git).toBeUndefined()
      expect(plain.diagnostics.some(item => item.code === 'NOT_A_GIT_REPOSITORY')).toBe(true)
      const missing = await inspector.inspect(path.join(nonGit, 'does-not-exist'), [], new AbortController().signal)
      expect(missing.cwd.exists).toBe(false)
      expect(missing.diagnostics[0]?.code).toBe('CWD_NOT_FOUND')
    } finally {
      await removeTree(root)
      await removeTree(nonGit)
    }
  })

  it('denies sensitive/out-of-repository relevant paths and never reads them', async () => {
    const root = await disposableRepo()
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-outside-'))
    try {
      await fs.writeFile(path.join(root, '.env.local'), 'SECRET=do-not-read', 'utf8')
      const inspector = new GitRepositoryInspector()
      const state = await inspector.inspect(root, ['.env.local', path.join(outside, 'escape.txt')], new AbortController().signal)
      expect(state.relevantPaths.every(item => item.exists === false)).toBe(true)
      expect(state.diagnostics.some(item => item.message.includes('denied'))).toBe(true)
    } finally {
      await removeTree(root)
      await removeTree(outside)
    }
  })

  it('rejects a relevant path that traverses a symlink/junction outside the repo', async () => {
    const root = await disposableRepo()
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-link-target-'))
    const link = path.join(root, 'linked')
    try {
      try {
        await fs.symlink(outside, link, path.sep === '\\' ? 'junction' : 'dir')
      } catch {
        // Symlink creation may be disabled by the Windows test runner policy.
        return
      }
      const state = await new GitRepositoryInspector().inspect(root, ['linked/secret.txt'], new AbortController().signal)
      expect(state.relevantPaths[0]?.exists).toBe(false)
      expect(state.diagnostics.length).toBeGreaterThan(0)
    } finally {
      await removeTree(root)
      await removeTree(outside)
    }
  })

  it('uses only the allowlisted argv Git calls and does not mutate source files', async () => {
    const root = await disposableRepo()
    try {
      const before = hash(await fs.readFile(path.join(root, 'unicode 文件.txt')))
      const indexBefore = hash(await fs.readFile(path.join(root, '.git', 'index')))
      const adapter = new FakeGitProcessAdapter(request => {
        const command = request.args.join(' ')
        if (command.includes('rev-parse --show-toplevel')) return { stdout: bytes(root + '\n'), stderr: new Uint8Array(), exitCode: 0 }
        if (command.includes('symbolic-ref')) return { stdout: bytes('main\n'), stderr: new Uint8Array(), exitCode: 0 }
        if (command.includes('rev-parse HEAD')) return { stdout: bytes('a'.repeat(40) + '\n'), stderr: new Uint8Array(), exitCode: 0 }
        if (command.includes('status')) return { stdout: bytes(''), stderr: new Uint8Array(), exitCode: 0 }
        if (command.includes('log')) return { stdout: bytes('a'.repeat(40) + '\0' + '2026-01-01T00:00:00+00:00' + '\0fixture\0'), stderr: new Uint8Array(), exitCode: 0 }
        return { stdout: new Uint8Array(), stderr: new Uint8Array(), exitCode: 1 }
      })
      const state = await new GitRepositoryInspector({ processAdapter: adapter }).inspect(root, [], new AbortController().signal)
      expect(state.git?.dirty).toBe(false)
      expect(adapter.requests.every(request => request.command === 'git')).toBe(true)
      expect(adapter.requests.every(request => request.args.includes('-C'))).toBe(true)
      expect(adapter.requests.filter(request => request.args.includes('status') || request.args.includes('log')).every(request => request.args.includes('--'))).toBe(true)
      expect(hash(await fs.readFile(path.join(root, 'unicode 文件.txt')))).toBe(before)
      expect(hash(await fs.readFile(path.join(root, '.git', 'index')))).toBe(indexBefore)
    } finally {
      await removeTree(root)
    }
  })

  it('surfaces cancellation and process timeouts as recoverable diagnostics', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-timeout-'))
    try {
      const timeout = new FakeGitProcessAdapter(() => ({ stdout: new Uint8Array(), stderr: new Uint8Array(), exitCode: null, timedOut: true }))
      const state = await new GitRepositoryInspector({ processAdapter: timeout }).inspect(root, [], new AbortController().signal)
      expect(state.diagnostics.some(item => item.code === 'GIT_INSPECTION_FAILED')).toBe(true)
      const controller = new AbortController()
      controller.abort()
      const cancelled = await new GitRepositoryInspector({ processAdapter: timeout }).inspect(root, [], controller.signal)
      expect(cancelled.diagnostics.some(item => item.code === 'CANCELLED')).toBe(true)
    } finally {
      await removeTree(root)
    }
  })
})
