/* Explicit release acceptance: this is intentionally not part of pnpm check. */
import { access, cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PINNED_SHA,
  assertWithin,
  createPinnedCheckout,
  ensureFile,
  repoRoot,
  run,
  safeRemoveGenerated,
  verifyHead,
} from './pinned-checkout.mjs'

const acceptanceSource = resolve(fileURLToPath(new URL('./pinned-dsh-client-acceptance.mjs', import.meta.url)))
const bundlePath = resolve(repoRoot, 'dist', 'client.js')
await ensureFile(acceptanceSource)
await ensureFile(bundlePath)

const tempRoot = await mkdtemp(join(resolve(tmpdir()), 'dsh-codex-pinned-client-'))
const absoluteTempRoot = resolve(tempRoot)
let pinned
let failure
let workspacePackage
try {
  pinned = await createPinnedCheckout(absoluteTempRoot)
  const checkout = pinned.checkout
  assertWithin(checkout, absoluteTempRoot, 'pinned client checkout')
  await verifyHead(checkout, 'pinned client checkout')

  // This package lives inside the official workspace and uses workspace:^ for
  // every DSH client package. It is disposable and never modifies this repo.
  workspacePackage = join(checkout, 'packages', 'client', 'dsh-codex-handoff')
  assertWithin(workspacePackage, absoluteTempRoot, 'temporary client workspace package')
  await mkdir(workspacePackage, { recursive: true })
  const officialClientPackages = [
    '@deepseek-ai/dsh-api-remotes',
    '@deepseek-ai/dsh-api-session-controller',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-sidebar',
    '@deepseek-ai/dsh-client-ui-workspace',
  ]
  const dependencies = Object.fromEntries(officialClientPackages.map(name => [name, 'workspace:^']))
  await writeFile(join(workspacePackage, 'package.json'), JSON.stringify({
    name: 'dsh-codex-handoff-pinned-client-acceptance',
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies,
  }, null, 2) + '\n', 'utf8')
  // The pinned root tsdown host pass applies its conventional
  // lib/types/{index,invariant,startup}.js entry to every workspace package.
  // Seed only this disposable acceptance package with empty host-face entries;
  // no product artifact is copied or treated as a real implementation.
  const temporaryHostEntries = join(workspacePackage, 'lib', 'types')
  await mkdir(temporaryHostEntries, { recursive: true })
  for (const name of ['index.js', 'invariant.js', 'startup.js']) {
    await writeFile(join(temporaryHostEntries, name), '', 'utf8')
  }
  await cp(bundlePath, join(workspacePackage, 'client.js'))
  await cp(acceptanceSource, join(workspacePackage, 'acceptance.mjs'))

  await run('corepack', ['pnpm', 'install', '--no-frozen-lockfile'], checkout)
  await run('corepack', ['pnpm', 'rebuild', 'fs-ext'], checkout)
  // Compile only the official loader's project reference, then invoke the
  // same clientBundle config used by the pinned package. Running the entire
  // 274-package root build is unnecessary for this acceptance and would make
  // the contract gate depend on unrelated product packages.
  await run('corepack', ['pnpm', 'exec', 'tsc', '-b', 'packages/client/modules/tsconfig.json', '--pretty', 'false'], checkout)
  await run('corepack', ['pnpm', '--filter', '@deepseek-ai/dsh-client-modules', 'run', 'bundle', '--env.DSH_BUILD_FACE', 'client'], checkout)

  await run('node', [join(workspacePackage, 'acceptance.mjs')], workspacePackage, {
    DSH_CLIENT_BUNDLE: bundlePath,
    DSH_UPSTREAM_ROOT: checkout,
    DSH_REPO_ROOT: repoRoot,
  })
  process.stdout.write(`pinned DSH client acceptance passed at ${PINNED_SHA}\n`)
} catch (error) {
  failure = error
  process.stderr.write(`pinned DSH client acceptance failed: ${error instanceof Error ? error.message : String(error)}\n`)
} finally {
  if (pinned?.worktreeSource !== undefined && pinned.checkout !== undefined) {
    try {
      assertWithin(pinned.checkout, absoluteTempRoot, 'detached client worktree cleanup')
      // The upstream workspace installs deeply nested package links. Git's
      // Windows long-path switch keeps detached-worktree cleanup deterministic
      // instead of leaving a generated checkout behind after a PASS.
      await run('git', ['-c', 'core.longpaths=true', '-C', pinned.worktreeSource, 'worktree', 'remove', '--force', pinned.checkout], repoRoot)
    } catch (error) {
      try {
        await access(pinned.checkout)
        process.stderr.write(`detached client worktree cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`)
      } catch {
        process.stdout.write('detached client worktree files already removed after git cleanup warning\n')
      }
    }
  }
  try {
    await safeRemoveGenerated(absoluteTempRoot, resolve(tmpdir()), 'temporary client spike root')
  } catch (error) {
    const message = `temporary client cleanup failed: ${error instanceof Error ? error.message : String(error)}`
    process.stderr.write(message + '\n')
    failure ??= new Error(message, { cause: error })
  }
}
if (failure !== undefined) throw failure
