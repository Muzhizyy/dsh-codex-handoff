import { access, readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const packageJson = JSON.parse(await readFile(resolve(repoRoot, 'package.json'), 'utf8'))
const expectedRemoteEndpoints = ['compatibility', 'discover', 'preview', 'analyze', 'create', 'returnPreview', 'returnSync']

async function requireFile(relativePath) {
  const path = resolve(repoRoot, relativePath)
  try {
    await access(path)
  } catch {
    throw new Error(`required package artifact is missing: ${relativePath}`)
  }
}

for (const relativePath of [
  'dist/index.js',
  'dist/index.d.ts',
  'dist/client.js',
  'dist/client.d.ts',
  'dist/client.js.map',
  'dist/remote.js',
  'dist/remote.d.ts',
  'dist/typert.remote-client.d.ts.map',
  'dist/typert.js',
  'dist/typert.d.ts',
  'cordis.patch.yml',
]) await requireFile(relativePath)

for (const relativePath of ['dist/remote.js', 'dist/remote.d.ts', 'dist/typert.js', 'dist/typert.d.ts']) {
  const descriptor = await readFile(resolve(repoRoot, relativePath), 'utf8')
  if (descriptor.trim().length === 0 || descriptor.trim() === 'export {}' || descriptor.trim() === 'export {};') {
    throw new Error(`${relativePath} is empty`)
  }
  // The official Typert host declaration intentionally exports TYPERT as
  // `unknown`; its endpoint reflection lives in the executable host artifact
  // and in the generated Client Remote declaration. Do not replace that
  // official safety boundary with a hand-written declaration.
  if (relativePath !== 'dist/typert.d.ts') {
    for (const method of expectedRemoteEndpoints) {
      if (!descriptor.includes(method)) throw new Error(`${relativePath} is missing remote endpoint ${method}`)
    }
  }
}

const remoteDeclaration = await readFile(resolve(repoRoot, 'dist/remote.d.ts'), 'utf8')
const sourceMapMatch = /\/\/# sourceMappingURL=([^\s]+)/u.exec(remoteDeclaration)
if (sourceMapMatch === null) throw new Error('dist/remote.d.ts is missing its official source map reference')
await requireFile(`dist/${sourceMapMatch[1]}`)

const clientText = await readFile(resolve(repoRoot, 'dist/client.js'), 'utf8')
const clientSize = (await stat(resolve(repoRoot, 'dist/client.js'))).size
if (clientSize > 1_500_000) throw new Error(`dist/client.js exceeds the singleton-bundle size cap: ${clientSize} bytes`)
if (!clientText.includes('window.__ModuleLoader__.load')) {
  throw new Error('dist/client.js is not a DSH lazy-CJS client registration')
}
if (/^\s*(?:import|export)\s/m.test(clientText)) {
  throw new Error('dist/client.js contains a top-level ESM import/export')
}
if (/\bnode:(?:fs|path|crypto|module|child_process|os|net|http|url)\b/.test(clientText)) {
  throw new Error('dist/client.js contains a Node builtin import')
}
for (const specifier of ['react', 'react/jsx-runtime']) {
  if (!clientText.includes(`require(${JSON.stringify(specifier)})`)) {
    throw new Error(`dist/client.js did not preserve the platform singleton external: ${specifier}`)
  }
}
if (clientText.includes('react.development.js') || clientText.includes('react.production.min.js')) {
  throw new Error('dist/client.js appears to inline a React runtime')
}

const expectedInject = [
  '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-sidebar',
]
const inject = packageJson.dsh?.client?.inject
if (JSON.stringify(inject) !== JSON.stringify(expectedInject)) {
  throw new Error(`dsh.client.inject must be the official six-package list: ${JSON.stringify(expectedInject)}`)
}

function collectExportTargets(value, prefix = '') {
  if (typeof value === 'string') return [{ prefix, value }]
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, child]) => collectExportTargets(child, `${prefix}/${key}`))
}

for (const target of collectExportTargets(packageJson.exports)) await requireFile(target.value)
process.stdout.write('package artifact gate passed\n')
