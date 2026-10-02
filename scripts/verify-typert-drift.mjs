/*
 * Re-run the pinned official WorkspaceTypertGenerator against a clean
 * contributor copy and compare it with the checked-in generated contribution.
 * This is intentionally a pinned/release gate; ordinary builds consume the
 * checked-in files and never require a network checkout.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateOfficialArtifacts, names, PINNED_SHA } from './generate-typert.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const generatedRoot = resolve(repoRoot, 'packages', 'codex-handoff', 'generated')
const checkoutValue = process.env.DSH_PINNED_CHECKOUT?.trim()

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertInside(child, parent, label) {
  const childPath = resolve(child)
  const parentPath = resolve(parent)
  const rest = relative(parentPath, childPath)
  assert(rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !/^[A-Za-z]:/u.test(rest)), `${label} escaped its temporary root: ${childPath}`)
}

async function main() {
  assert(checkoutValue !== undefined && checkoutValue !== '', `DSH_PINNED_CHECKOUT is required for Typert drift verification at ${PINNED_SHA}`)
  const checkout = resolve(checkoutValue)
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'dsh-typert-drift-'))
  assertInside(temporaryRoot, tmpdir(), 'Typert drift temporary root')
  const temporaryArtifacts = resolve(temporaryRoot, 'generated-a')
  const secondArtifacts = resolve(temporaryRoot, 'generated-b')
  assertInside(temporaryArtifacts, temporaryRoot, 'Typert drift artifacts')
  assertInside(secondArtifacts, temporaryRoot, 'Typert drift artifacts')
  try {
    await generateOfficialArtifacts(checkout, temporaryArtifacts)
    await generateOfficialArtifacts(checkout, secondArtifacts)
    for (const name of names) {
      const expectedPath = resolve(generatedRoot, name)
      const actualPath = resolve(temporaryArtifacts, name)
      const secondPath = resolve(secondArtifacts, name)
      const expected = await readFile(expectedPath)
      const actual = await readFile(actualPath)
      const second = await readFile(secondPath)
      for (const [label, bytes] of [['checked-in', expected], ['generated-a', actual], ['generated-b', second]]) {
        const text = bytes.toString('utf8')
        assert(!/[A-Za-z]:[\\/]|\\\\[^\r\n]+/u.test(text), `Typert artifact contains an absolute path (${label}): ${name}`)
        assert(!text.includes(temporaryRoot) && !text.includes(checkout), `Typert artifact leaks a temporary/upstream root (${label}): ${name}`)
      }
      const expectedBytes = expected
      const actualBytes = actual
      const secondBytes = second
      assert(actualBytes.equals(secondBytes), `Typert generator is nondeterministic: ${name}`)
      assert(expectedBytes.equals(actualBytes), `Typert generated artifact drift: ${name}`)
    }
    process.stdout.write(`Typert drift gate passed at ${PINNED_SHA}; ${names.length} artifacts byte-identical\n`)
  } finally {
    assertInside(temporaryRoot, tmpdir(), 'Typert drift cleanup')
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

await main()
