import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Script, createContext } from 'node:vm'

const bundlePath = resolve(process.env.DSH_CLIENT_BUNDLE ?? '')
const upstreamRoot = resolve(process.env.DSH_UPSTREAM_ROOT ?? '')
const repoRoot = resolve(process.env.DSH_REPO_ROOT ?? '')
if (!process.env.DSH_CLIENT_BUNDLE || !process.env.DSH_UPSTREAM_ROOT || !process.env.DSH_REPO_ROOT) {
  throw new Error('DSH_CLIENT_BUNDLE, DSH_UPSTREAM_ROOT, and DSH_REPO_ROOT are required')
}

const source = await readFile(bundlePath, 'utf8')
if (!source.includes('window.__ModuleLoader__.load')) throw new Error('client bundle has no ModuleLoader registration')
if (/^\s*(?:import|export)\s/m.test(source)) throw new Error('client bundle is ordinary ESM, not lazy CJS')
if (!source.includes('factory: (require) =>')) throw new Error('client bundle has no CJS factory wrapper')

const registrations = []
const sandbox = {
  window: { __ModuleLoader__: { load(registration) { registrations.push(registration) } } },
  console,
}
const context = createContext(sandbox)
new Script(source, { filename: basename(bundlePath) }).runInContext(context)
if (registrations.length !== 1) throw new Error(`expected one client registration, got ${registrations.length}`)
const registration = registrations[0]
if (registration.id !== 'dsh-threadbridge') throw new Error(`unexpected client registration id: ${registration.id}`)
if (typeof registration.factory !== 'function') throw new Error('client registration factory is not callable')

// This is the pinned DSH platform table, not a second copy of React.  The
// browser shell owns these instances and every dynamic bundle resolves them
// synchronously through its factory require.
const hostRequire = createRequire(resolve(repoRoot, 'package.json'))
const staticModules = {
  // The pinned repository deliberately has no React dependency. The host
  // application supplies these singletons, so acceptance resolves them from
  // this plugin's host dependency tree and injects the resulting table.
  react: hostRequire('react'),
  'react/jsx-runtime': hostRequire('react/jsx-runtime'),
  'react-dom': hostRequire('react-dom'),
  'react-dom/client': hostRequire('react-dom/client'),
}
const platformModules = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']
for (const specifier of platformModules) {
  if (staticModules[specifier] === undefined) throw new Error(`official platform static module is missing: ${specifier}`)
}
const exports = registration.factory((specifier) => {
  if (specifier in staticModules) return staticModules[specifier]
  throw new Error(`unexpected external require: ${specifier}`)
})
if (typeof exports !== 'object' || exports === null || typeof exports.apply !== 'function') {
  throw new Error('client bundle did not return the expected module exports')
}

// The generated `lib/client.js` is intentionally a browser classic script and
// therefore cannot be Node-imported (`window` is its required global). The
// same official loader implementation is emitted as the typed host-side
// module below; use it to exercise the captured browser registration.
const modulesPath = resolve(upstreamRoot, 'packages', 'client', 'modules', 'lib', 'types', 'client', 'index.js')
const modules = await import(pathToFileURL(modulesPath).href)
if (typeof modules.createClientModuleSystem !== 'function') {
  throw new Error('pinned official client loader is missing createClientModuleSystem')
}

const pendingQueue = []
const target = {
  mode: 'queue',
  pendingQueue,
  load(value) { pendingQueue.push(value) },
  create(options) {
    return modules.createClientModuleSystem(target, { id: registration.id, exports }, options)
  },
}
const loader = target.create({
  boot: { rev: 'acceptance', entries: [], batches: [] },
  staticModules,
  loadBundle: async () => {},
})
if (target.mode !== 'live') throw new Error('official loader did not switch the ModuleLoader facade to live mode')
if (loader.version !== 'client') throw new Error(`unexpected official loader version: ${loader.version}`)
if (loader.loadCache.get('dsh-threadbridge')?.exports !== exports) {
  throw new Error('official loader did not retain the lazy-CJS bootstrap exports')
}

// Render the real hook-based overlay through ReactDOM against a real DOM. This
// catches duplicate-React bundles and proves the static table is used by the
// CJS factory; a loader-only check would miss both failures.
const { JSDOM } = hostRequire('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
// React 18's legacy input-event probe is still selected by jsdom's feature
// detection. Provide the browser-compatible no-op pair so the acceptance
// output remains warning-free while focus is moved into the overlay.
const elementPrototype = dom.window.HTMLElement.prototype
if (typeof elementPrototype.attachEvent !== 'function') elementPrototype.attachEvent = () => {}
if (typeof elementPrototype.detachEvent !== 'function') elementPrototype.detachEvent = () => {}
const previousGlobals = new Map()
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'MutationObserver', 'getComputedStyle']) {
  previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: dom.window[name],
  })
}
// The bundle factory was evaluated in a VM context. Point that same global
// object at jsdom as well; otherwise hook effects resolve the VM's undefined
// `document` even though Node's global has been prepared.
sandbox.window = dom.window
for (const name of ['document', 'navigator', 'HTMLElement', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'MutationObserver', 'getComputedStyle']) {
  sandbox[name] = dom.window[name]
}
previousGlobals.set('IS_REACT_ACT_ENVIRONMENT', Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT'))
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const React = staticModules.react
const ReactDomClient = staticModules['react-dom/client']
const act = React.act
if (typeof act !== 'function') throw new Error('host React does not expose React.act for warning-free acceptance')
const Overlay = exports.HandoffOverlay ?? exports.HandoffOverlayComponent
if (typeof Overlay !== 'function') throw new Error('client bundle does not export HandoffOverlay')
const model = {
  getState: () => ({
    phase: 'browsing', query: { search: '', archived: 'all' }, page: { items: [] },
    degraded: false, searchPending: false, cwd: '', cwdStatus: 'unknown', mode: 'smart',
    useModel: true, targetTokens: 1000, fullConfirmed: false, focus: 'search',
  }),
  subscribe: () => () => {},
  getBudgetEstimate: () => ({ estimatedTokens: 0, estimatedBytes: 0, warning: false, hardLimit: false, requiresConfirmation: false }),
}
const container = dom.window.document.createElement('div')
dom.window.document.body.append(container)
const root = ReactDomClient.createRoot(container)
try {
  await act(async () => {
    root.render(React.createElement(Overlay, { model, titleKey: 'title', onKey: () => {} }))
    await new Promise(resolve => setTimeout(resolve, 20))
  })
  if (container.querySelector('[role="dialog"]') === null) throw new Error('ReactDOM did not render the hook overlay dialog')
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (/invalid hook call/i.test(message)) throw new Error(`React singleton mismatch: ${message}`)
  throw error
} finally {
  await act(async () => { root.unmount() })
  dom.window.close()
  for (const [name, descriptor] of previousGlobals) {
    if (descriptor === undefined) delete globalThis[name]
    else Object.defineProperty(globalThis, name, descriptor)
  }
}
process.stdout.write('pinned DSH client bundle accepted by official loader\n')
