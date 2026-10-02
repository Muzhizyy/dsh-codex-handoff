import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const files = Object.fromEntries(await Promise.all([
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'RESEARCH.md',
  'SPEC.md',
  'IMPLEMENTATION_PLAN.md',
  'VERIFICATION_REPORT.md',
  'docs/2026-10-roundtrip-spec.md',
  'docs/2026-10-roundtrip-plan.md',
].map(async path => [path, await readFile(resolve(root, path), 'utf8')])))
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const tarball = `artifacts/dsh-codex-handoff-${packageJson.version}.tgz`

const requiredReadmeTerms = [
  'dsh-v0.2.0-rc.2',
  '639ed015397290b3745d163aafe02ffee4aa3f84',
  'Session Format v4',
  tarball,
  'dsh plugin --profile desktop add',
  '@deepseek-ai/dsh-app-boot.initProfile()',
  '不启动 Electron GUI',
  '--initialize-profile-only',
  'compatibility',
  'returnPreview',
  'returnSync',
  '七个 typed RPC',
  '原 Codex source thread 不变',
  '不调用 LLM',
  'fork',
  '不会盲目重试',
  '回传只对插件权威索引中可链接',
  '不假装自动打开 fork',
  'docs/2026-10-roundtrip-spec.md',
  'docs/2026-10-roundtrip-plan.md',
  '历史研究报告',
  '不声称该插件已发布到 npm',
  'pnpm test:pinned-dsh',
  'pnpm test:installed-desktop',
  'DSH_TEST_HOME',
  '脚本拒绝默认 `~/.dsh`',
  'resources\\runtime\\cli\\bin\\dsh.cmd',
  'plugin --profile desktop add <absolute-tgz>',
]
for (const term of requiredReadmeTerms) {
  if (!files['README.md'].includes(term)) throw new Error(`README is missing required current-release disclosure/topic: ${term}`)
}

const requiredRpcMethods = ['compatibility', 'discover', 'preview', 'analyze', 'create', 'returnPreview', 'returnSync']
for (const method of requiredRpcMethods) {
  if (!files['README.md'].includes(`\`${method}\``)) throw new Error(`README is missing typed RPC method: ${method}`)
}

if (!files['LICENSE'].startsWith('MIT License')) throw new Error('LICENSE is not the MIT text')
if (!files['CHANGELOG.md'].includes('## 0.2.0-rc.2 — 2026-10-02')) throw new Error('CHANGELOG has no current dated release entry')
if (!files['CHANGELOG.md'].includes('独立 verifier 的后续报告')) throw new Error('CHANGELOG must defer empirical Desktop claims to fresh verifier evidence')
if (!files['RESEARCH.md'].includes('历史基线提示') || !files['RESEARCH.md'].includes('0.1.3-alpha.1')) {
  throw new Error('RESEARCH must retain its dated historical pin while marking it superseded')
}
if (!files['SPEC.md'].includes('历史规格提示') || !files['SPEC.md'].includes('由[增量 SPEC]')) {
  throw new Error('SPEC must identify the superseding incremental return contract')
}
if (!files['IMPLEMENTATION_PLAN.md'].includes('历史实施计划提示')) throw new Error('old implementation plan is not marked historical')
if (!files['VERIFICATION_REPORT.md'].includes('does not verify the DSH `0.2.0-rc.2`')) {
  throw new Error('old verification report must not be presented as evidence for the current release')
}
if (!files['docs/2026-10-roundtrip-spec.md'].includes('639ed015397290b3745d163aafe02ffee4aa3f84')) {
  throw new Error('incremental SPEC does not pin the current upstream commit')
}
if (!files['docs/2026-10-roundtrip-plan.md'].includes('真实 DSH/Codex desktop')) {
  throw new Error('incremental plan must keep real Desktop roundtrip on the release verification gate')
}
if (packageJson.version !== '0.2.0-rc.2') throw new Error(`package version must match this release: ${packageJson.version}`)
for (const name of ['@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-typert-protocol']) {
  if (packageJson.dsh?.compatibility?.peerDependencies?.[name] !== '0.2.0-rc.2') {
    throw new Error(`package compatibility for ${name} is not pinned to the tested DSH release`)
  }
}
if (/guarantee|guaranteed|完全恢复|无条件安全/iu.test(files['README.md'])) throw new Error('README overclaims privacy or recovery guarantees')
process.stdout.write('current-release documentation gate passed\n')
