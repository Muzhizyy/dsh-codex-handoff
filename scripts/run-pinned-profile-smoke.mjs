/*
 * Pinned CLI/profile acceptance. This uses the upstream Commander entry and
 * plugin forwarder, never a local substitute. It installs this packed plugin
 * into a disposable real `web` profile, boots that profile, exercises the
 * official Client loader/ReactDOM smoke, then removes the dependency and
 * verifies the profile layer is gone.
 */
import { access, mkdtemp, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  PINNED_SHA,
  assertWithin,
  createPinnedCheckout,
  repoRoot,
  run,
  safeRemoveGenerated,
  verifyHead,
} from './pinned-checkout.mjs'

const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-codex-profile-'))
const absoluteTempRoot = resolve(tempRoot)
let pinned
let failure

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function ensureFile(path, label) {
  try {
    await access(path)
  } catch {
    throw new Error(`${label} is missing: ${path}`)
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

function countOccurrences(value, pattern) {
  return [...value.matchAll(pattern)].length
}

async function findFreePort() {
  const server = createServer()
  return await new Promise((resolvePort, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('free-port probe returned no TCP address')))
        return
      }
      server.close(error => error === undefined ? resolvePort(address.port) : reject(error))
    })
  })
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise(resolve => child.once('exit', resolve))
}

async function terminateProcessTree(child) {
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32' && child.pid !== undefined) {
      try {
        await new Promise((resolve, reject) => {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          })
          killer.once('error', reject)
          killer.once('exit', () => resolve())
        })
      } catch {
        // The child can exit between readiness and taskkill; wait below is
        // the authoritative lifecycle check.
      }
    } else {
      child.kill('SIGTERM')
    }
  }
  await Promise.race([
    waitForExit(child),
    new Promise(resolve => setTimeout(resolve, 5_000)),
  ])
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await Promise.race([
      waitForExit(child),
      new Promise(resolve => setTimeout(resolve, 5_000)),
    ])
  }
  assert(child.exitCode !== null || child.signalCode !== null, 'pinned Web profile process tree did not terminate')
}

async function bootWebUntilReady(cli, environment) {
  const port = await findFreePort()
  return await new Promise((resolveReady, reject) => {
    const child = spawn(process.execPath, [cli, '--profile', 'web', '--no-open', '--port', String(port)], {
      cwd: repoRoot,
      env: { ...process.env, ...environment },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let settled = false
    let readySeen = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error === undefined) resolveReady(output)
      else reject(error)
    }
    const observe = (chunk) => {
      output += String(chunk)
      if (!readySeen && /dsh web:\s+https?:\/\//u.test(output)) {
        // Readiness is an observable product line emitted only after the real
        // profile has composed and the WebServer has started listening.
        readySeen = true
        void terminateProcessTree(child).then(
          // Windows taskkill terminates the Node process with code 1 even
          // though the profile reached the real listening state.  The
          // termination is deliberate; readiness is the acceptance result.
          () => finish(),
          error => finish(error),
        )
      }
    }
    child.stdout?.on('data', observe)
    child.stderr?.on('data', observe)
    child.once('error', error => finish(error))
    child.once('exit', (code, signal) => {
      if (!settled && !readySeen) finish(new Error(`pinned Web profile exited before readiness (code=${code ?? 'null'}, signal=${signal ?? 'none'}): ${output}`))
    })
    const timer = setTimeout(() => {
      void terminateProcessTree(child).finally(() => finish(new Error(`timed out waiting for pinned Web profile readiness on port ${port}: ${output}`)))
    }, 30_000)
  })
}

async function dumpConfig(cli, environment) {
  const result = await run('node', [cli, '--profile', 'web', '--dump-config'], repoRoot, environment)
  return `${result.stdout}\n${result.stderr}`
}

function assertDumpConfig(output, expectedCount, phase) {
  const count = countOccurrences(output, /^- id:\s*codex-handoff\b/gimu)
  assert(count === expectedCount, `${phase} dump-config expected dsh-codex-handoff count ${expectedCount}, got ${count}`)
  assert(!/unmatched/iu.test(output), `${phase} dump-config contains an unmatched plugin row`)
}

try {
  pinned = await createPinnedCheckout(absoluteTempRoot)
  const checkout = pinned.checkout
  assertWithin(checkout, absoluteTempRoot, 'pinned profile checkout')
  await verifyHead(checkout, 'pinned profile checkout')
  await run('corepack', ['pnpm', 'install', '--frozen-lockfile'], checkout)
  await run('corepack', ['pnpm', 'rebuild', 'fs-ext'], checkout)
  await run('corepack', ['pnpm', 'run', 'build:lib:host'], checkout)
  await run('corepack', ['pnpm', 'run', 'build:lib:client'], checkout)

  const archiveRoot = join(absoluteTempRoot, 'packed')
  const packOutput = await run('pnpm', ['pack', '--pack-destination', archiveRoot], repoRoot)
  const archiveName = packOutput.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)
  assert(typeof archiveName === 'string' && archiveName.endsWith('.tgz'), `pnpm pack did not report a tarball: ${packOutput.stdout}`)
  const archive = resolve(archiveRoot, archiveName)
  await ensureFile(archive, 'packed plugin')

  const home = join(absoluteTempRoot, 'dsh-home')
  const environment = { DSH_HOME: home }
  const cli = resolve(checkout, 'apps', 'cli', 'lib', 'bin.js')
  await ensureFile(cli, 'pinned DSH CLI')
  const versionResult = await run('node', [cli, '--version'], repoRoot, environment)
  const versionOutput = `${versionResult.stdout}\n${versionResult.stderr}`.trim()
  assert(/(?:^|\r?\n)0\.1\.3-alpha\.1(?:\r?\n|$)/u.test(versionOutput), `pinned DSH CLI version is not 0.1.3-alpha.1: ${versionOutput}`)
  const profileArgs = ['plugin', '--profile', 'web']
  const profileRoot = join(home, 'profiles', 'web')
  const profileManifestPath = join(profileRoot, 'package.json')
  const profilePatchPath = join(profileRoot, 'cordis.patch.yml')
  const homePatchPath = join(home, 'cordis.patch.yml')
  const preAddConfig = await dumpConfig(cli, environment)
  assertDumpConfig(preAddConfig, 0, 'pre-add')
  const profilePatchBefore = await readOptional(profilePatchPath)
  const homePatchBefore = await readOptional(homePatchPath)
  await run('node', [cli, ...profileArgs, 'add', archive], repoRoot, environment)

  const installedManifest = await readJson(profileManifestPath)
  assert(installedManifest.dependencies?.['dsh-codex-handoff'] !== undefined, 'pinned plugin add did not persist the package dependency')
  assert(installedManifest.dsh?.profile?.bundles?.includes('dsh-codex-handoff') === true, 'pinned plugin add did not persist the bundle layer')
  assert(Object.keys(installedManifest.dependencies ?? {}).filter(name => name === 'dsh-codex-handoff').length === 1, 'pinned plugin add persisted more than one package dependency')
  assert(countOccurrences(installedManifest.dsh?.profile?.bundles?.join('\n') ?? '', /dsh-codex-handoff/giu) === 1, 'pinned plugin add persisted more than one bundle layer')
  const postAddConfig = await dumpConfig(cli, environment)
  assertDumpConfig(postAddConfig, 1, 'post-add')
  assert(await readOptional(profilePatchPath) === profilePatchBefore, 'plugin add modified the profile patch instead of the bundle manifest')
  assert(await readOptional(homePatchPath) === homePatchBefore, 'plugin add modified the home patch')

  const bootOutput = await bootWebUntilReady(cli, environment)
  assert(/dsh web:\s+https?:\/\//u.test(bootOutput), 'pinned Web profile did not report a listening startup URL')

  const installedRoot = resolve(profileRoot, 'node_modules', 'dsh-codex-handoff')
  const installedClient = resolve(installedRoot, 'dist', 'client.js')
  await ensureFile(installedClient, 'installed plugin Client entry')
  await run('node', [resolve(repoRoot, 'scripts', 'pinned-dsh-client-acceptance.mjs')], repoRoot, {
    DSH_CLIENT_BUNDLE: installedClient,
    DSH_UPSTREAM_ROOT: checkout,
    DSH_REPO_ROOT: repoRoot,
  })

  await run('node', [cli, ...profileArgs, 'remove', 'dsh-codex-handoff'], repoRoot, environment)
  const removedManifest = await readJson(profileManifestPath)
  assert(removedManifest.dependencies?.['dsh-codex-handoff'] === undefined, 'pinned plugin remove left the dependency installed')
  assert(!removedManifest.dsh?.profile?.bundles?.includes('dsh-codex-handoff'), 'pinned plugin remove left the bundle layer active')
  assert(await readOptional(profilePatchPath) === profilePatchBefore, 'plugin remove modified the profile patch')
  assert(await readOptional(homePatchPath) === homePatchBefore, 'plugin remove modified the home patch')
  const postRemoveConfig = await dumpConfig(cli, environment)
  assertDumpConfig(postRemoveConfig, 0, 'post-remove')
  const postRemoveBootOutput = await bootWebUntilReady(cli, environment)
  assert(/dsh web:\s+https?:\/\//u.test(postRemoveBootOutput), 'pinned Web profile did not boot after plugin removal')
  process.stdout.write(`pinned DSH profile/plugin smoke passed at ${PINNED_SHA} (version, add/dump, Web boot, official Client load, remove/dump, Web reboot)\n`)
} catch (error) {
  failure = error
  process.stderr.write(`pinned DSH profile/plugin smoke failed: ${error instanceof Error ? error.message : String(error)}\n`)
} finally {
  if (pinned?.worktreeSource !== undefined && pinned.checkout !== undefined) {
    try {
      assertWithin(pinned.checkout, absoluteTempRoot, 'pinned profile worktree cleanup')
      await run('git', ['-c', 'core.longpaths=true', '-C', pinned.worktreeSource, 'worktree', 'remove', '--force', pinned.checkout], repoRoot)
    } catch (error) {
      try {
        await access(pinned.checkout)
        process.stderr.write(`pinned profile worktree cleanup warning: ${error instanceof Error ? error.message : String(error)}\n`)
      } catch {
        process.stdout.write('pinned profile worktree files already removed after cleanup warning\n')
      }
    }
  }
  try {
    await safeRemoveGenerated(absoluteTempRoot, tmpdir(), 'pinned profile temporary root')
  } catch (error) {
    const message = `pinned profile temporary cleanup failed: ${error instanceof Error ? error.message : String(error)}`
    process.stderr.write(message + '\n')
    failure ??= new Error(message, { cause: error })
  }
}

if (failure !== undefined) throw failure
