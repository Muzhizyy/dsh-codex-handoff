import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const files = {
  readme: await readFile(resolve(root, 'README.md'), 'utf8') + await readFile(resolve(root, 'README.zh-CN.md'), 'utf8'),
  license: await readFile(resolve(root, 'LICENSE'), 'utf8'),
  changelog: await readFile(resolve(root, 'CHANGELOG.md'), 'utf8'),
}
const requiredReadmeTerms = [
  'd347e703908d0406b7a7ef80e3a0e594d86b2215',
  'Smart',
  'Full',
  'best effort',
  '显式提交 DSH turn',
  'dsh plugin --profile web add',
  'dsh plugin --profile web remove',
  'prepare',
  'allowBuilds',
  'created_unattached',
]
for (const term of requiredReadmeTerms) {
  if (!files.readme.includes(term)) throw new Error(`README is missing required disclosure/topic: ${term}`)
}
if (!files.license.startsWith('MIT License')) throw new Error('LICENSE is not the MIT text')
if (!files.changelog.includes('0.1.0-alpha.1')) throw new Error('CHANGELOG has no current release entry')
if (/guarantee|guaranteed|完全恢复|无条件安全/iu.test(files.readme)) throw new Error('README overclaims privacy or recovery guarantees')
process.stdout.write('documentation gate passed\n')
