import { access, readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
for (const name of ['dist/client.js', 'dist/client.d.ts', 'dist/client.js.map']) {
  try {
    await access(resolve(repoRoot, name))
  } catch {
    throw new Error(`required client artifact is missing: ${name}`)
  }
}
const source = await readFile(resolve(repoRoot, 'dist/client.js'), 'utf8')
const size = (await stat(resolve(repoRoot, 'dist/client.js'))).size
if (size > 1_500_000) throw new Error(`client artifact exceeds the singleton-bundle size cap: ${size} bytes`)
if (!source.includes('window.__ModuleLoader__.load')) throw new Error('client artifact has no ModuleLoader registration')
if (/^\s*(?:import|export)\s/m.test(source)) throw new Error('client artifact is not lazy CJS')
if (/\bnode:(?:fs|path|crypto|module|child_process|os|net|http|url)\b/.test(source)) {
  throw new Error('client artifact contains a Node builtin import')
}
for (const specifier of ['react', 'react/jsx-runtime']) {
  if (!source.includes(`require(${JSON.stringify(specifier)})`)) {
    throw new Error(`client artifact did not preserve the platform singleton external: ${specifier}`)
  }
}
if (source.includes('react.development.js') || source.includes('react.production.min.js')) {
  throw new Error('client artifact appears to inline a React runtime')
}
process.stdout.write('client artifact gate passed\n')
