import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-codex-pack-'))
const packRoot = join(tempRoot, 'pack')
const extractRoot = join(tempRoot, 'extract')
const harnessRoot = join(tempRoot, 'harness')
await Promise.all([mkdir(packRoot), mkdir(extractRoot), mkdir(harnessRoot)])

function executable(command) {
  return process.platform === 'win32' && command === 'pnpm' ? 'pnpm.cmd' : command
}

async function run(command, args, cwd) {
  const result = await execFileAsync(executable(command), args, {
    cwd,
    windowsHide: true,
    shell: process.platform === 'win32' && command === 'pnpm',
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.stderr.trim() !== '') {
    // Keep upstream/package-manager diagnostics visible without turning a
    // successful install warning into a product error.
    process.stderr.write(`[pack upstream/install diagnostic] ${result.stderr.trim()}\n`)
  }
  return result.stdout
}

async function filesIn(root, prefix = '') {
  const entries = await readdir(root, { withFileTypes: true })
  const result = []
  for (const entry of entries) {
    const path = join(root, entry.name)
    const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) result.push(...await filesIn(path, name))
    else result.push(name.replaceAll('\\', '/'))
  }
  return result
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertExportFiles(packageJson, packageRoot, files) {
  const targets = []
  const collect = (value) => {
    if (typeof value === 'string') targets.push(value)
    else if (value !== null && typeof value === 'object') {
      for (const child of Object.values(value)) collect(child)
    }
  }
  collect(packageJson.exports)
  for (const target of targets) {
    assert(target.startsWith('./'), `export target is not package-relative: ${target}`)
    const relativeTarget = target.slice(2).replaceAll('\\', '/')
    assert(files.includes(relativeTarget), `packed export target is missing: ${target}`)
    assert(resolve(packageRoot, relativeTarget).startsWith(resolve(packageRoot)), `export escapes extracted package: ${target}`)
  }
}

async function main() {
  await run('pnpm', ['pack', '--pack-destination', packRoot], repoRoot)
  const archives = (await readdir(packRoot)).filter(name => name.endsWith('.tgz'))
  assert(archives.length === 1, `expected exactly one tarball, found ${archives.length}`)
  const archive = join(packRoot, archives[0])
  const listing = (await run('tar', ['-tf', archive], repoRoot)).trim().split(/\r?\n/u).filter(Boolean)

  const required = [
    'package/package.json',
    'package/dist/index.js',
    'package/dist/index.d.ts',
    'package/dist/client.js',
    'package/dist/client.d.ts',
    'package/dist/client.js.map',
    'package/dist/remote.js',
    'package/dist/remote.d.ts',
    'package/dist/typert.remote-client.d.ts.map',
    'package/dist/typert.js',
    'package/dist/typert.d.ts',
    'package/cordis.patch.yml',
    'package/README.md',
    'package/LICENSE',
    'package/CHANGELOG.md',
  ]
  for (const path of required) assert(listing.includes(path), `packed artifact is missing ${path}`)
  const forbiddenEntry = listing.find(path => /(?:^|\/)(?:src|tests|fixtures|scripts|node_modules|coverage)(?:\/|$)/u.test(path))
  assert(forbiddenEntry === undefined, `packed artifact contains forbidden source/test entry: ${forbiddenEntry}`)

  await run('tar', ['-xzf', archive, '-C', extractRoot], repoRoot)
  const packageRoot = join(extractRoot, 'package')
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  assertExportFiles(packageJson, packageRoot, listing.map(path => path.replace(/^package\//u, '')))
  const remoteDeclaration = await readFile(join(packageRoot, 'dist', 'remote.d.ts'), 'utf8')
  const sourceMapMatch = /\/\/# sourceMappingURL=([^\s]+)/u.exec(remoteDeclaration)
  assert(sourceMapMatch !== null, 'packed Remote declaration is missing its official source map reference')
  assert(await filesIn(packageRoot).then(files => files.includes(`dist/${sourceMapMatch[1]}`)), `packed Remote declaration map is missing: ${sourceMapMatch?.[1]}`)
  assert(packageJson.engines?.node === '^22.19.0 || >=24.0.0', 'packed manifest must keep the pinned Node engine range')
  assert(packageJson.version === '0.2.0-rc.2', 'packed manifest has an unexpected plugin version')
  assert(packageJson.dsh?.compatibility?.peerDependencies?.['@deepseek-ai/dsh-api-gateway'] === '0.2.0-rc.2', 'packed manifest is not pinned to the tested DSH Gateway release')
  assert(packageJson.dsh?.compatibility?.peerDependencies?.['@deepseek-ai/dsh-typert-protocol'] === '0.2.0-rc.2', 'packed manifest is not pinned to the tested DSH Typert release')
  assert(packageJson.dsh?.bundle?.patch === './cordis.patch.yml', 'packed manifest lacks nested dsh.bundle.patch')
  assert(Array.isArray(packageJson.dsh?.client?.inject) && packageJson.dsh.client.inject.length > 0, 'packed manifest lacks dsh.client.inject')

  const patchText = await readFile(join(packageRoot, 'cordis.patch.yml'), 'utf8')
  assert(/^- insert:/mu.test(patchText), 'bundle patch is not an insert list')
  assert(/id:\s*codex-handoff\b/u.test(patchText), 'bundle patch does not insert codex-handoff')
  assert(/name:\s*dsh-codex-handoff\b/u.test(patchText), 'bundle patch does not target this package')
  assert(!/\b(?:replace|remove):/u.test(patchText), 'bundle patch replaces/removes a base row')
  for (const service of ['agents', 'agentDefaultModel', 'sessionQuery', 'sessionPersistence', 'workspaceRegistry', 'storageDomain', 'typert']) {
    assert(new RegExp(`-\\s+${service}\\b`, 'u').test(patchText), `bundle patch omits required Host service ${service}`)
  }

  const extractedFiles = await filesIn(packageRoot)
  for (const name of extractedFiles) {
    const bytes = await readFile(join(packageRoot, name))
    if (bytes.includes(0)) continue
    const text = bytes.toString('utf8')
    assert(!text.includes(repoRoot), `packed file leaks local repository path: ${name}`)
    assert(!/[A-Za-z]:\\Users\\[^\s"']+/u.test(text), `packed file leaks a Windows absolute path: ${name}`)
    assert(!/AKIA[0-9A-Z]{16}/u.test(text), `packed file contains an AWS access-key-shaped secret: ${name}`)
    assert(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(text), `packed file contains a private key: ${name}`)
  }

  const relativeArchive = relative(harnessRoot, archive).replaceAll('\\', '/')
  await writeFile(join(harnessRoot, 'package.json'), JSON.stringify({
    name: 'dsh-codex-handoff-pack-harness',
    private: true,
    type: 'module',
    dependencies: { 'dsh-codex-handoff': `file:${relativeArchive}` },
  }, null, 2) + '\n', 'utf8')
  await run('pnpm', ['install', '--ignore-scripts', '--no-frozen-lockfile'], harnessRoot)
  const installedRoot = join(harnessRoot, 'node_modules', 'dsh-codex-handoff')
  const installedPackage = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8'))
  assert(installedPackage.name === 'dsh-codex-handoff', 'ignore-scripts install did not resolve packed package')

  const rootModule = await import(pathToFileURL(join(installedRoot, installedPackage.exports['.'].default.slice(2))).href)
  assert(typeof rootModule.apply === 'function' && typeof rootModule.CodexHandoffHostService === 'function', 'Host export does not load')
  const remoteModule = await import(pathToFileURL(join(installedRoot, installedPackage.exports['./remote'].default.slice(2))).href)
  assert(Array.isArray(remoteModule.default?.descriptors), 'Remote export did not load a generated contribution')
  assert(remoteModule.default.descriptors.length === 7, 'generated Remote contribution must expose all seven RPC methods')
  assert(remoteModule.default.descriptors.some(item => item.method === 'compatibility'), 'generated Remote lacks compatibility')
  for (const method of ['discover', 'preview', 'analyze', 'create', 'returnPreview', 'returnSync']) {
    assert(remoteModule.default.descriptors.some(item => item.method === method), `generated Remote lacks ${method}`)
  }
  const typertModule = await import(pathToFileURL(join(installedRoot, installedPackage.exports['./typert'].default.slice(2))).href)
  assert(typertModule.TYPERT !== undefined, 'Typert Host export did not load')

  let clientModule
  globalThis.window = {
    __ModuleLoader__: {
      load({ factory }) {
        clientModule = factory(specifier => {
          if (specifier === 'react') return { createElement: () => undefined, Fragment: 'fragment' }
          if (specifier === 'react/jsx-runtime') return { jsx: () => undefined, jsxs: () => undefined, Fragment: 'fragment' }
          if (specifier === 'react-dom' || specifier === 'react-dom/client') return {}
          return {}
        })
      },
    },
  }
  await import(pathToFileURL(join(installedRoot, installedPackage.exports['./client'].default.slice(2))).href)
  assert(clientModule !== undefined, 'Client export did not register with the official loader shape')
  assert(clientModule.codexHandoffRemote?.descriptors?.length === 7, 'packed Client lacks the seven official Remote descriptors')

  process.stdout.write(`pack/install gate passed: ${archives[0]} (ignore-scripts; official Host/Client/Remote/Typert loaded)\n`)
}

try {
  await main()
} finally {
  await rm(tempRoot, { recursive: true, force: true })
}
