import { execFile } from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
export const PINNED_SHA = 'd347e703908d0406b7a7ef80e3a0e594d86b2215'
export const PINNED_REMOTE = 'https://github.com/deepseek-ai/deepseek-harness.git'
export const scriptDir = dirname(fileURLToPath(import.meta.url))
export const repoRoot = resolve(scriptDir, '..')

function executable(command) {
  if (process.platform === 'win32' && (command === 'corepack' || command === 'pnpm')) return `${command}.cmd`
  return command
}

function quoteForLog(value) {
  return /[\s"]/.test(value) ? JSON.stringify(value) : value
}

export async function run(command, args, cwd, env = {}) {
  const rendered = [command, ...args].map(quoteForLog).join(' ')
  process.stdout.write(`> ${rendered}\n`)
  const needsWindowsShim = process.platform === 'win32' && (command === 'corepack' || command === 'pnpm')
  try {
    const result = await execFileAsync(executable(command), args, {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      shell: needsWindowsShim,
      maxBuffer: 16 * 1024 * 1024,
    })
    if (result.stdout.trim()) process.stdout.write(result.stdout.trimEnd() + '\n')
    if (result.stderr.trim()) process.stderr.write(result.stderr.trimEnd() + '\n')
    return result
  } catch (error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout.trim() : ''
    const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : ''
    const details = [stdout, stderr].filter(Boolean).join('\n')
    throw new Error(`${rendered} failed${details ? `:\n${details}` : ''}`, { cause: error })
  }
}

export function normalizedPath(path) {
  const value = resolve(path).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? value.toLowerCase() : value
}

export function assertWithin(child, parent, label) {
  const childPath = normalizedPath(child)
  const parentPath = normalizedPath(parent)
  if (childPath === parentPath || !childPath.startsWith(parentPath + sep)) {
    throw new Error(`${label} is outside the generated temporary root: ${childPath}`)
  }
}

export async function verifyHead(checkout, label) {
  const { stdout } = await run('git', ['-C', checkout, 'rev-parse', 'HEAD'], repoRoot)
  const head = stdout.trim().toLowerCase()
  if (head !== PINNED_SHA) throw new Error(`${label} HEAD ${head} does not equal pinned ${PINNED_SHA}`)
  process.stdout.write(`verified ${label} HEAD ${head}\n`)
}

export async function ensureFile(path) {
  try {
    await access(path)
  } catch {
    throw new Error(`required file is missing: ${path}`)
  }
}

export async function createPinnedCheckout(tempRoot) {
  const configured = process.env.DSH_PINNED_CHECKOUT
  if (configured !== undefined && configured.trim() !== '') {
    const source = resolve(configured)
    await ensureFile(joinPath(source, '.git'))
    await verifyHead(source, 'DSH_PINNED_CHECKOUT')
    const worktree = joinPath(tempRoot, 'upstream-worktree')
    assertWithin(worktree, tempRoot, 'temporary worktree')
    await run('git', ['-C', source, 'worktree', 'add', '--detach', worktree, PINNED_SHA], repoRoot)
    await verifyHead(worktree, 'detached worktree')
    return { checkout: worktree, worktreeSource: source }
  }

  const clone = joinPath(tempRoot, 'upstream-clone')
  assertWithin(clone, tempRoot, 'temporary clone')
  await run('git', ['clone', '--filter=blob:none', '--no-checkout', '--depth=1', PINNED_REMOTE, clone], repoRoot)
  await run('git', ['-C', clone, 'fetch', '--depth=1', 'origin', PINNED_SHA], repoRoot)
  await run('git', ['-C', clone, 'checkout', '--detach', PINNED_SHA], repoRoot)
  await verifyHead(clone, 'shallow clone')
  return { checkout: clone }
}

export async function safeRemoveGenerated(path, tempRoot, label) {
  assertWithin(path, tempRoot, label)
  await rm(path, { recursive: true, force: true })
}

function joinPath(...parts) {
  return resolve(...parts)
}

export function isConfiguredCheckout(value) {
  return value !== undefined && value.trim() !== '' && isAbsolute(resolve(value))
}

export async function makeTempRoot(prefix) {
  return mkdtemp(resolve(tmpdir(), prefix))
}
