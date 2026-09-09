import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const distRoot = resolve(repoRoot, 'dist')

await mkdir(distRoot, { recursive: true })
await writeFile(resolve(distRoot, 'index.js'), "export * from './dsh/index.js'\nexport * from './host/index.js'\n", 'utf8')
await writeFile(resolve(distRoot, 'index.d.ts'), "export * from './dsh/index.js'\nexport * from './host/index.js'\n", 'utf8')
