import { builtinModules } from 'node:module'
import { readdir, readFile } from 'node:fs/promises'
import { join, sep } from 'node:path'

const root = process.env.FORBIDDEN_IMPORT_ROOT ?? process.cwd()
const packageName = 'dsh-threadbridge'
const productionRoots = ['src/shared', 'src/codex', 'src/repo', 'src/handoff', 'src/dsh', 'src/host', 'src/client']
const builtinNames = new Set(builtinModules.map(name => name.replace(/^node:/, '')))

function isBuiltinModule(specifier) {
  const normalized = specifier.replace(/^node:/, '')
  const rootName = normalized.split('/')[0]
  return builtinNames.has(normalized) || (rootName !== undefined && builtinNames.has(rootName))
}

function importSpecifiers(content) {
  const matches = []
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier !== undefined && !matches.includes(specifier)) matches.push(specifier)
    }
  }
  return matches
}

function isFeatureRelative(specifier, feature) {
  return new RegExp(`^(?:\\.\\.?/)+(?:${feature})(?:/|$)`).test(specifier)
}

function isInternalAlias(specifier) {
  return specifier.startsWith('@/') || specifier.startsWith('~/') || specifier.startsWith('#/') || specifier === packageName || specifier.startsWith(`${packageName}/`)
}

function isDsh(specifier) {
  return specifier.startsWith('@deepseek-ai/')
}

function isAllowedHandoffDshSpecifier(file, specifier) {
  const normalizedFile = file.replaceAll(sep, '/')
  return normalizedFile === 'src/handoff/llm-adapter.ts' && (specifier === '@deepseek-ai/dsh-llm' || specifier.startsWith('@deepseek-ai/dsh-llm/'))
}

function forbiddenSpecifier(layer, file, specifier) {
  if (layer === 'shared') {
    if (isBuiltinModule(specifier)) return 'Node builtin import'
    if (specifier === 'react' || specifier.startsWith('react/')) return 'React import'
    if (isDsh(specifier)) return 'DSH runtime import'
    if (isInternalAlias(specifier) || ['codex', 'repo', 'handoff', 'dsh', 'host', 'client'].some(feature => isFeatureRelative(specifier, feature))) return 'self/alias/feature import'
  }
  if (layer === 'codex') {
    if (isDsh(specifier)) return 'DSH import'
    if (specifier === 'react' || specifier.startsWith('react/')) return 'React import'
    if (isFeatureRelative(specifier, 'repo') || isFeatureRelative(specifier, 'handoff')) return 'cross-layer import'
  }
  if (layer === 'repo') {
    if (isDsh(specifier)) return 'DSH import'
    if (specifier === 'react' || specifier.startsWith('react/')) return 'React import'
    if (isFeatureRelative(specifier, 'codex') || isFeatureRelative(specifier, 'handoff')) return 'cross-layer import'
  }
  if (layer === 'handoff') {
    if (isBuiltinModule(specifier)) return 'Node builtin import'
    if (isDsh(specifier) && !isAllowedHandoffDshSpecifier(file, specifier)) return 'DSH import outside thin LLM adapter'
    if (isInternalAlias(specifier) || isFeatureRelative(specifier, 'codex') || isFeatureRelative(specifier, 'repo') || isFeatureRelative(specifier, 'dsh')) return 'self/alias/feature import'
  }
  if (layer === 'dsh') {
    if (isBuiltinModule(specifier)) return 'Node builtin import (use injected DSH services)'
    if (specifier === 'react' || specifier.startsWith('react/')) return 'React import'
    if (isFeatureRelative(specifier, 'client') || isFeatureRelative(specifier, 'codex') || isFeatureRelative(specifier, 'repo')) return 'cross-layer import'
  }
  if (layer === 'host') {
    if (specifier === 'react' || specifier.startsWith('react/')) return 'React import'
    if (isFeatureRelative(specifier, 'client')) return 'Client implementation import'
  }
  if (layer === 'client') {
    if (isBuiltinModule(specifier)) return 'Node builtin import'
    if (isInternalAlias(specifier) || isFeatureRelative(specifier, 'host') || isFeatureRelative(specifier, 'codex') || isFeatureRelative(specifier, 'repo') || isFeatureRelative(specifier, 'handoff') || isFeatureRelative(specifier, 'dsh')) return 'self/alias/Host implementation import'
    if (['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-persistence', '@deepseek-ai/dsh-workspace', '@deepseek-ai/dsh-llm'].some(prefix => specifier === prefix || specifier.startsWith(`${prefix}/`))) return 'DSH Host package import'
  }
  return undefined
}

function layerFor(file) {
  const normalized = file.replaceAll(sep, '/')
  const match = normalized.match(/^src\/([^/]+)/)
  return match?.[1]
}

async function filesIn(directory) {
  try {
    const entries = await readdir(join(root, directory), { withFileTypes: true })
    const nested = await Promise.all(entries.map(async entry => {
      const child = join(directory, entry.name)
      if (entry.isDirectory()) return filesIn(child)
      return /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name) ? [child] : []
    }))
    return nested.flat()
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
}

const violations = []
for (const productionRoot of productionRoots) {
  const files = await filesIn(productionRoot)
  for (const file of files) {
    const content = await readFile(join(root, file), 'utf8')
    const layer = layerFor(file)
    if (layer === undefined) continue
    for (const specifier of importSpecifiers(content)) {
      const description = forbiddenSpecifier(layer, file, specifier)
      if (description !== undefined) {
        violations.push(`${file.replaceAll(sep, '/')}: forbidden ${description}: ${specifier}`)
      }
    }
    if (layer === 'dsh') {
      if (/\bsessionPersistence\s*\.\s*(?:create|append)\s*\(/.test(content)) {
        violations.push(`${file.replaceAll(sep, '/')}: direct sessionPersistence.create/append is forbidden`)
      }
      if (/@deepseek-ai\/dsh-session-persistence(?:[/'"]|$)/.test(content)) {
        violations.push(`${file.replaceAll(sep, '/')}: direct dsh-session-persistence import is forbidden`)
      }
      if (/\b(?:writeFile|appendFile|writeFileSync|appendFileSync)\s*\(/.test(content)) {
        violations.push(`${file.replaceAll(sep, '/')}: raw filesystem persistence write is forbidden`)
      }
    }
  }
}

if (violations.length > 0) {
  console.error('Forbidden import gate failed:')
  for (const violation of violations) console.error(`- ${violation}`)
  process.exitCode = 1
} else {
  console.log(`Forbidden import gate passed (${productionRoots.length} production boundaries checked).`)
}
