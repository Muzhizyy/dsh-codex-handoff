import { build } from 'esbuild'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const distRoot = resolve(repoRoot, 'dist')
const declarationRoot = resolve(distRoot, '.client-types')
const bodyFile = resolve(distRoot, '.client-body.js')
const bodyMapFile = resolve(distRoot, '.client-body.js.map')

// Keep this list in lock-step with the pinned DSH client-web PLATFORM_MODULES
// table.  These imports are shell singletons; bundling a second React copy
// would make hooks fail at runtime even when the bundle otherwise loads.
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
await execFileAsync(executable, ['exec', 'tsc', '-p', 'tsconfig.client.build.json'], {
  cwd: repoRoot,
  windowsHide: true,
  shell: process.platform === 'win32',
})

await build({
  absWorkingDir: repoRoot,
  entryPoints: [resolve(repoRoot, 'src/client/index.ts')],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  outfile: bodyFile,
  sourcemap: true,
  sourcesContent: true,
  jsx: 'automatic',
  legalComments: 'none',
  external: PLATFORM_MODULES,
})

const body = await readFile(bodyFile, 'utf8')
const bundleId = 'dsh-threadbridge'
const wrapped = [
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(bundleId)}, factory: (require) => {`,
  'var module = { exports: {} }; var exports = module.exports;',
  body.replace(/\n?\/\/#[^\n]*sourceMappingURL=[^\n]*\n?$/, '\n'),
  'return module.exports; } });',
  '//# sourceMappingURL=client.js.map',
  '',
].join('\n')
await writeFile(resolve(distRoot, 'client.js'), wrapped, 'utf8')
const sourceMap = JSON.parse(await readFile(bodyMapFile, 'utf8'))
sourceMap.file = 'client.js'
await writeFile(resolve(distRoot, 'client.js.map'), JSON.stringify(sourceMap) + '\n', 'utf8')

const declarationClientRoot = resolve(declarationRoot, 'client')
await mkdir(resolve(distRoot, 'client'), { recursive: true })
await cp(declarationClientRoot, resolve(distRoot, 'client'), { recursive: true })
await writeFile(resolve(distRoot, 'client.d.ts'), "export * from './client/index.js'\n", 'utf8')

await rm(bodyFile, { force: true })
await rm(bodyMapFile, { force: true })
await rm(declarationRoot, { recursive: true, force: true })
