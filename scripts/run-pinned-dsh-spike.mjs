/*
 * Run the DSH compatibility spike against one immutable upstream commit.
 *
 * The default mode clones/fetches the exact commit into a generated temporary
 * directory. DSH_PINNED_CHECKOUT is an offline-friendly mode: it is verified
 * first, then a detached worktree is created underneath our generated temp
 * directory. In both modes the caller's checkout is never modified.
 */
import { execFile } from 'node:child_process'
import { access, cp, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const PINNED_SHA = '639ed015397290b3745d163aafe02ffee4aa3f84'
const PINNED_REMOTE = 'https://github.com/deepseek-ai/deepseek-harness.git'
const scriptPath = fileURLToPath(import.meta.url)
const scriptDir = dirname(scriptPath)
const repoRoot = resolve(scriptDir, '..')
const acceptanceSource = resolve(scriptDir, 'pinned-dsh-acceptance.mjs')
const typertAcceptanceSource = resolve(scriptDir, 'pinned-typert-acceptance.mjs')
const contributorSource = resolve(repoRoot, 'packages', 'codex-handoff')
const seedModule = resolve(repoRoot, 'dist', 'dsh', 'seed.js')
const skipRootBuild = process.argv.includes('--skip-root-build')

function executable(command) {
  if (process.platform === 'win32' && (command === 'corepack' || command === 'pnpm')) {
    return `${command}.cmd`
  }
  return command
}

function quoteForLog(value) {
  return /[\s"]/.test(value) ? JSON.stringify(value) : value
}

async function run(command, args, cwd, env = {}) {
  const rendered = [command, ...args].map(quoteForLog).join(' ')
  process.stdout.write(`> ${rendered}\n`)
  const needsWindowsShim = process.platform === 'win32' && (command === 'corepack' || command === 'pnpm')
  try {
    const result = await execFileAsync(executable(command), args, {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      // Windows exposes corepack/pnpm as .cmd shims; Node requires shell
      // dispatch for those shims. Git and node remain direct execFile calls,
      // so a configured checkout path never becomes a shell fragment.
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

function normalizedPath(path) {
  const value = resolve(path).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function assertWithin(child, parent, label) {
  const childPath = normalizedPath(child)
  const parentPath = normalizedPath(parent)
  if (childPath === parentPath || !childPath.startsWith(parentPath + sep)) {
    throw new Error(`${label} is outside the generated temporary root: ${childPath}`)
  }
}

async function verifyHead(checkout, label) {
  const { stdout } = await run('git', ['-C', checkout, 'rev-parse', 'HEAD'], repoRoot)
  const head = stdout.trim().toLowerCase()
  if (head !== PINNED_SHA) throw new Error(`${label} HEAD ${head} does not equal pinned ${PINNED_SHA}`)
  process.stdout.write(`verified ${label} HEAD ${head}\n`)
}

async function ensureFile(path) {
  try {
    await access(path)
  } catch {
    throw new Error(`required file is missing: ${path}`)
  }
}

async function installPinnedContributor(checkout) {
  const target = join(checkout, 'packages', 'api', 'codex-handoff')
  const aggregate = join(checkout, 'tsconfig.host.json')
  const originalAggregate = await readFile(aggregate, 'utf8')
  const reference = '{ "path": "./packages/api/codex-handoff/tsconfig.host.json" }'
  if (originalAggregate.includes(reference)) throw new Error('pinned checkout already contains the codex-handoff contributor')
  await cp(contributorSource, target, { recursive: true, errorOnExist: true })
  const contributorConfig = join(target, 'tsconfig.host.json')
  const contributorConfigText = await readFile(contributorConfig, 'utf8')
  await writeFile(contributorConfig, contributorConfigText.replace('"../../tsconfig.base.json"', '"../../../tsconfig.base.json"'), 'utf8')
  // Workspace install creates package-local dependency links. The temporary
  // contributor is deliberately outside that install graph, so link it only
  // to the already installed official API package dependencies.
  const dependencySource = await realpath(join(checkout, 'packages', 'api', 'gateway', 'node_modules'))
  await symlink(dependencySource, join(target, 'node_modules'), 'junction')
  await writeFile(aggregate, originalAggregate.replace('"references": [', `"references": [\n    ${reference},`), 'utf8')
  await run('corepack', ['pnpm', 'exec', 'tsc', '-b', 'packages/api/codex-handoff/tsconfig.host.json', '--pretty', 'false'], checkout)
  return async () => {
    await writeFile(aggregate, originalAggregate, 'utf8')
    await rm(target, { recursive: true, force: true })
  }
}

async function createPinnedCheckout(tempRoot) {
  const configured = process.env.DSH_PINNED_CHECKOUT
  if (configured !== undefined && configured.trim() !== '') {
    const source = resolve(configured)
    await ensureFile(join(source, '.git'))
    await verifyHead(source, 'DSH_PINNED_CHECKOUT')
    const worktree = join(tempRoot, 'upstream-worktree')
    assertWithin(worktree, tempRoot, 'temporary worktree')
    await run('git', ['-C', source, 'worktree', 'add', '--detach', worktree, PINNED_SHA], repoRoot)
    await verifyHead(worktree, 'detached worktree')
    return { checkout: worktree, worktreeSource: source }
  }

  const clone = join(tempRoot, 'upstream-clone')
  assertWithin(clone, tempRoot, 'temporary clone')
  await run('git', ['clone', '--filter=blob:none', '--no-checkout', '--depth=1', PINNED_REMOTE, clone], repoRoot)
  await run('git', ['-C', clone, 'fetch', '--depth=1', 'origin', PINNED_SHA], repoRoot)
  await run('git', ['-C', clone, 'checkout', '--detach', PINNED_SHA], repoRoot)
  await verifyHead(clone, 'shallow clone')
  return { checkout: clone }
}

async function safeRemoveGenerated(path, tempRoot, label) {
  assertWithin(path, tempRoot, label)
  await rm(path, { recursive: true, force: true })
}

async function main() {
  await ensureFile(acceptanceSource)
  if (!skipRootBuild) {
    // package.json owns the public test:pinned-dsh composition. Keeping this
    // script independent also allows an already-built dist to be exercised by
    // the offline runner during an upstream/runtime spike.
    await ensureFile(seedModule)
  } else {
    await ensureFile(seedModule)
  }

  const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-codex-pinned-'))
  const absoluteTempRoot = resolve(tempRoot)
  let pinned
  let copiedSpec
  let copiedTypertSpec
  let contributorCleanup
  let failure
  try {
    pinned = await createPinnedCheckout(absoluteTempRoot)
    const checkout = pinned.checkout
    assertWithin(checkout, absoluteTempRoot, 'pinned checkout')

    await run('corepack', ['pnpm', 'install', '--frozen-lockfile'], checkout)
    // fs-ext is optional for the host build but is a native dependency in the
    // persistence graph. Rebuild it in the pinned checkout after frozen
    // install; do not execute an arbitrary install script or shell command.
    await run('corepack', ['pnpm', 'rebuild', 'fs-ext'], checkout)
    await run('corepack', ['pnpm', 'run', 'build:lib:host'], checkout)
    await run('corepack', ['pnpm', 'run', 'build:lib:client'], checkout)
    // Regenerate the contributor in a clean temporary output and compare the
    // official generator bytes before installing it into the acceptance graph.
    await run('node', [resolve(repoRoot, 'scripts', 'verify-typert-drift.mjs')], repoRoot, {
      DSH_PINNED_CHECKOUT: checkout,
    })
    contributorCleanup = await installPinnedContributor(checkout)

    // Run from a workspace package whose node_modules contains the DSH core
    // peer links. A root-level script cannot resolve workspace peers because
    // the upstream root intentionally has no @deepseek-ai/* dependency links.
    const acceptanceCwd = join(checkout, 'packages', 'preset', 'agent-presets')
    copiedSpec = join(acceptanceCwd, 'dsh-codex-pinned-acceptance.mjs')
    copiedTypertSpec = join(acceptanceCwd, 'dsh-codex-pinned-typert-acceptance.mjs')
    assertWithin(copiedSpec, absoluteTempRoot, 'copied acceptance spec')
    assertWithin(copiedTypertSpec, absoluteTempRoot, 'copied Typert acceptance spec')
    const sourceText = await readFile(acceptanceSource, 'utf8')
    const typertSourceText = await readFile(typertAcceptanceSource, 'utf8')
    await writeFile(copiedSpec, sourceText, 'utf8')
    await writeFile(copiedTypertSpec, typertSourceText, 'utf8')
    await run('node', [copiedSpec], acceptanceCwd, {
      DSH_REPO_ROOT: repoRoot,
      DSH_SEED_MODULE: seedModule,
      DSH_UPSTREAM_ROOT: checkout,
      DSH_CONTRIBUTOR_ROOT: checkout,
    })
    await run('node', [copiedTypertSpec], acceptanceCwd, {
      DSH_REPO_ROOT: repoRoot,
      DSH_UPSTREAM_ROOT: checkout,
      DSH_CONTRIBUTOR_ROOT: checkout,
    })
    process.stdout.write(`pinned DSH spike passed at ${PINNED_SHA}\n`)
  } catch (error) {
    failure = error
    process.stderr.write(`pinned DSH spike failed: ${error instanceof Error ? error.message : String(error)}\n`)
  } finally {
    if (contributorCleanup !== undefined) {
      try { await contributorCleanup() } catch (error) {
        process.stderr.write(`temporary contributor cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`)
      }
    }
    if (pinned?.worktreeSource !== undefined && pinned.checkout !== undefined) {
      try {
        assertWithin(pinned.checkout, absoluteTempRoot, 'detached worktree cleanup')
        await run('git', ['-C', pinned.worktreeSource, 'worktree', 'remove', '--force', pinned.checkout], repoRoot)
      } catch (error) {
        // Git may have removed the worktree registration but report a path
        // length error while deleting a generated node_modules tree on
        // Windows. The final bounded rm below is authoritative; only retain
        // a cleanup failure when the exact validated target still exists.
        try {
          await access(pinned.checkout)
          const message = `detached worktree cleanup failed: ${error instanceof Error ? error.message : String(error)}`
          process.stderr.write(message + '\n')
        } catch {
          process.stdout.write('detached worktree files already removed after git cleanup warning\n')
        }
      }
    }
    try {
      await safeRemoveGenerated(absoluteTempRoot, resolve(tmpdir()), 'temporary spike root')
    } catch (error) {
      const message = `temporary spike cleanup failed: ${error instanceof Error ? error.message : String(error)}`
      process.stderr.write(message + '\n')
      failure ??= new Error(message, { cause: error })
    }
  }
  if (failure !== undefined) throw failure
}

await main()
