/*
 * Exercise the installed DSH 0.2.0-rc.2 Desktop CLI against a disposable
 * Desktop profile. A fresh profile is initialized through the official
 * dsh-app-boot export used by DesktopProjectManager; no GUI is launched.
 * This never falls back to ~/.dsh.
 */
import { access, readFile, realpath } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = '0.2.0-rc.2'
const expectedArchiveName = `dsh-codex-handoff-${version}.tgz`

function inside(child, parent) {
  const suffix = relative(parent, child)
  return suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
}

function samePath(left, right) {
  const a = resolve(left).replace(/[\\/]+$/u, '')
  const b = resolve(right).replace(/[\\/]+$/u, '')
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

async function requirePath(path, label) {
  try {
    await access(path)
  } catch {
    throw new Error(`${label} is missing`)
  }
}

function sanitizedEnvironment(testHome) {
  const allowed = new Set([
    'APPDATA', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH', 'PATHEXT',
    'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR',
  ])
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
    allowed.has(key.toUpperCase()) && value !== undefined))
  return { ...env, DSH_HOME: testHome, ELECTRON_RUN_AS_NODE: '1' }
}

async function runDesktopCli(executable, cliEntry, testHome, args, label) {
  try {
    const result = await execFileAsync(executable, ['--expose-internals', cliEntry, ...args], {
      cwd: repoRoot,
      env: sanitizedEnvironment(testHome),
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    })
    return `${result.stdout}\n${result.stderr}`
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown'
    throw new Error(`installed Desktop CLI ${label} failed (${code}); raw output was suppressed`)
  }
}

async function runDesktopNode(executable, testHome, source, label) {
  try {
    const result = await execFileAsync(executable, ['--expose-internals', '-e', source], {
      cwd: repoRoot,
      env: sanitizedEnvironment(testHome),
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    })
    return `${result.stdout}\n${result.stderr}`
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown'
    throw new Error(`installed Desktop runtime ${label} failed (${code}); raw output was suppressed`)
  }
}

async function pathExists(path) {
  try {
    await access(path)
    return true
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
    if (code === 'ENOENT') return false
    throw new Error('could not inspect isolated Desktop profile state')
  }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('installed Desktop acceptance requires Windows')

  const testHomeValue = process.env.DSH_TEST_HOME?.trim()
  if (testHomeValue === undefined || testHomeValue === '') {
    throw new Error('set DSH_TEST_HOME to an isolated Desktop home under .desktop-test or the system temp directory')
  }
  if (!isAbsolute(testHomeValue)) throw new Error('DSH_TEST_HOME must be an absolute path')
  const testHome = await realpath(testHomeValue)
  const allowedRoots = await Promise.all([
    realpath(resolve(repoRoot, '.desktop-test')),
    realpath(tmpdir()),
  ])
  if (!allowedRoots.some(root => inside(testHome, root))) {
    throw new Error('DSH_TEST_HOME must be a child of .desktop-test or the system temp directory')
  }
  if (samePath(testHome, resolve(homedir(), '.dsh'))) {
    throw new Error('refusing to use the default ~/.dsh home')
  }

  const desktopRoot = resolve(process.env.DSH_DESKTOP_ROOT
    ?? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness'))
  const executable = join(desktopRoot, 'DeepSeek Harness.exe')
  const appAsar = join(desktopRoot, 'resources', 'app.asar')
  const cliEntry = join(desktopRoot, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
  await requirePath(executable, 'installed DeepSeek Harness executable')
  await requirePath(appAsar, 'installed DeepSeek Harness app.asar')

  const profile = join(testHome, 'profiles', 'desktop')
  const manifestPath = join(profile, 'package.json')
  const patchPath = join(profile, 'cordis.patch.yml')
  const workspacePath = join(profile, 'pnpm-workspace.yaml')
  const lockPath = join(profile, 'lock')
  if (!await pathExists(profile)) {
    const initialize = `
      const { createRequire } = require('node:module')
      const boot = createRequire(${JSON.stringify(cliEntry)})('@deepseek-ai/dsh-app-boot')
      const template = boot.PROFILE_TEMPLATES?.web
      if (typeof boot.initProfile !== 'function' || !Array.isArray(template?.bundles)) {
        throw new Error('installed app-boot does not expose the official Desktop profile initializer')
      }
      boot.initProfile(${JSON.stringify(profile)}, template.bundles)
    `
    await runDesktopNode(executable, testHome, initialize, 'official profile initialization')
  }
  await requirePath(manifestPath, 'initialized isolated Desktop profile manifest')
  await requirePath(patchPath, 'Desktop-initialized profile patch layer')
  await requirePath(workspacePath, 'Desktop-initialized pnpm workspace settings')
  let profileLocked = false
  try {
    await access(lockPath)
    profileLocked = true
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
    if (code !== 'ENOENT') throw new Error('could not verify the isolated Desktop profile lock state')
  }
  if (profileLocked) throw new Error('Desktop profile lock exists; fully quit the app and retry')

  const before = JSON.parse(await readFile(manifestPath, 'utf8'))
  const expectedDesktopBundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
  if (before.name !== 'dsh-profile-desktop' || before.private !== true
    || JSON.stringify(before.dsh?.profile?.bundles) !== JSON.stringify(expectedDesktopBundles)
    || before.dependencies === null || typeof before.dependencies !== 'object' || Array.isArray(before.dependencies)) {
    throw new Error('DSH_TEST_HOME does not contain an initialized Desktop plugin profile')
  }
  if ('dsh-codex-handoff' in before.dependencies || before.dsh.profile.bundles.includes('dsh-codex-handoff')) {
    throw new Error('isolated Desktop profile already contains dsh-codex-handoff; use a clean profile')
  }

  if (process.argv.includes('--initialize-profile-only')) {
    process.stdout.write(`official Desktop profile initialization passed at ${version}; isolated DSH_HOME only, no GUI launched\n`)
    return
  }

  if (process.argv.includes('--profile-list-only')) {
    const listed = await runDesktopCli(executable, cliEntry, testHome,
      ['plugin', '--profile', 'desktop', 'list'], 'profile list')
    if (/dsh-codex-handoff/u.test(listed)) throw new Error('Desktop CLI lists dsh-codex-handoff before installation')
    process.stdout.write(`installed Desktop CLI profile list passed at ${version}; isolated DSH_HOME only\n`)
    return
  }

  const archiveValue = resolve(process.env.DSH_PLUGIN_TARBALL ?? join(repoRoot, 'artifacts', expectedArchiveName))
  if (basename(archiveValue) !== expectedArchiveName) throw new Error(`DSH_PLUGIN_TARBALL must name ${expectedArchiveName}`)
  const archive = await realpath(archiveValue)
  const archiveRoot = await realpath(resolve(repoRoot, 'artifacts'))
  if (!inside(archive, archiveRoot)) throw new Error('plugin tarball must be inside the repository artifacts directory')
  await requirePath(archive, 'prebuilt plugin tarball')

  const initialList = await runDesktopCli(executable, cliEntry, testHome,
    ['plugin', '--profile', 'desktop', 'list'], 'list before add')
  if (/dsh-codex-handoff/u.test(initialList)) throw new Error('Desktop CLI lists dsh-codex-handoff before installation')

  let added = false
  let failure
  let cleanupFailure
  try {
    await runDesktopCli(executable, cliEntry, testHome,
      ['plugin', '--profile', 'desktop', 'add', archive], 'plugin add')
    added = true

    const after = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (!('dsh-codex-handoff' in (after.dependencies ?? {}))) throw new Error('Desktop add did not persist the plugin dependency')
    if (after.dsh?.profile?.bundles?.filter(name => name === 'dsh-codex-handoff').length !== 1) {
      throw new Error('Desktop add did not persist exactly one plugin bundle')
    }
    const installedPackagePath = join(profile, 'node_modules', 'dsh-codex-handoff', 'package.json')
    const installedPackage = JSON.parse(await readFile(installedPackagePath, 'utf8'))
    if (installedPackage.version !== version) throw new Error(`installed package version is not ${version}`)

    const installedList = await runDesktopCli(executable, cliEntry, testHome,
      ['plugin', '--profile', 'desktop', 'list'], 'list after add')
    if (!/dsh-codex-handoff/u.test(installedList)) throw new Error('Desktop CLI list omitted the installed plugin')

    await runDesktopCli(executable, cliEntry, testHome,
      ['plugin', '--profile', 'desktop', 'remove', 'dsh-codex-handoff'], 'plugin remove')
    added = false
    const afterRemove = JSON.parse(await readFile(manifestPath, 'utf8'))
    if ('dsh-codex-handoff' in (afterRemove.dependencies ?? {})
      || afterRemove.dsh?.profile?.bundles?.includes('dsh-codex-handoff')) {
      throw new Error('Desktop remove left the plugin installed in the isolated profile')
    }
    const finalList = await runDesktopCli(executable, cliEntry, testHome,
      ['plugin', '--profile', 'desktop', 'list'], 'list after remove')
    if (/dsh-codex-handoff/u.test(finalList)) throw new Error('Desktop CLI still lists the plugin after removal')
  } catch (error) {
    failure = error
  } finally {
    if (added) {
      try {
        await runDesktopCli(executable, cliEntry, testHome,
          ['plugin', '--profile', 'desktop', 'remove', 'dsh-codex-handoff'], 'cleanup remove')
      } catch (error) {
        cleanupFailure = error
      }
    }
  }
  if (failure !== undefined) {
    if (cleanupFailure !== undefined) throw new Error(`${failure instanceof Error ? failure.message : String(failure)}; isolated cleanup also failed`)
    throw failure
  }
  if (cleanupFailure !== undefined) throw cleanupFailure
  process.stdout.write(`installed DeepSeek Harness Desktop CLI/profile acceptance passed at ${version}; isolated package add/list/remove\n`)
}

await main()
