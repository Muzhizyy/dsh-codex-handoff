# DSH 0.2 round-trip independent verification

Verification: 2026-10-02–03. Baseline: `dff7d29`. Contract: `docs/2026-10-roundtrip-spec.md` and `docs/2026-10-roundtrip-plan.md`.

This report separates source review, automated checks, and empirical Desktop/Codex behavior. A source review is not a pass for an end-to-end gate. Synthetic and isolated homes only are in scope for destructive or write-bearing probes; the user's default Codex and DSH homes are out of scope.

## 2026-10-03 subsequent runtime retest — not fully passed

The user requested another actual runtime test after the original release acceptance. This run does **not** supersede the historical successful run below with another pass: the current installed Codex binary has changed.

- Installed DSH Desktop CLI fresh-profile initialization and final-archive add/list/remove **passed**, exit 0, using the isolated `D:\Project\DSHP\.desktop-test\runtime-acceptance-ruJn0t` home. The plugin was removed from that test profile at the end; personal profiles were not used.
- The real installed DSH `DomainFacility` fresh prepare, state claim, close/reopen and new-facility reload proof **passed**.
- `scripts/verify-roundtrip.mjs --full`, using the same isolated synthetic Codex home/source documented below, **failed** with `CODEX_PROTOCOL_MISMATCH` during the Codex version probe, before the fork/injection dispatch. Real DSH creation/query and preview were reached, but this run did not complete the return path.
- `resolveCodexBinary()` now resolves `C:\Program Files\WindowsApps\OpenAI.Codex_26.930.2377.0_x64__2p2nqsd0c76g0\app\resources\codex.exe`. Direct `--version` exited 0 and returned `codex-cli 0.159.0-alpha.12.1`. The product version guard requires at least `0.159.2` and parses this prerelease as numeric `0.159.0`, so it rejects the currently installed Desktop CLI.
- A read-only capability diagnostic generated that executable's official stable JSON schema into an owned temporary directory. It exited 0 and included both `thread/fork` and `thread/inject_items`. Their presence alone does not prove request/response or persistence compatibility; the guard was not bypassed or modified.
- Actual Electron window clicking remains **not run**: the available tool list did not expose the `node_repl` required by the installed computer-use skill. No alternative Windows UI automation or personal Desktop launch was performed.

The final package SHA-256 remains `8d4047b2a570ee9f6b4462951072b2ab7e16959b187dbec866fda6cbcc2d2d98`. The next required implementation work is to validate the current prerelease protocol and make an evidence-backed compatibility decision, then rerun the complete return path. This testing request did not authorize silently weakening that check.

## Release risks found during source review

The table retains historical failures so the review trail is clear. Each current status names the evidence that closed the finding; earlier red checks remain in the chronology below.

| ID | Status | Historical failure / current evidence | Remaining proof |
| --- | --- | --- | --- |
| R1 | Fixed; scoped race passed | State-only claim let two coordinators issue two forks. Current attempt token and shared Host store yielded one fork/injection, one `created`, one `unknown`, then `existing`. | Cross-process CAS is not promised. |
| R2 | Fixed; real runtime passed | `get → put` could erase a receipt; absent-key `KvTable.update` fails with `missing-key`. The default-initialized global singleton and awaited `global.set` survived close/reopen and new-`DomainFacility` reload in installed DSH 0.2.0-rc.2. | None for the supported single-Host storage contract. |
| R3 | Fixed; fault test passed | A pre-send connection failure previously left `dispatching`. The scoped test verifies rollback to `prepared` and safe retry; ambiguous post-send outcomes remain terminal `unknown`. | None for this fault path. |
| R4 | Fixed; regression passed | Bounded source search previously accepted a match with another cursor. The scoped test rejects incomplete pagination. | None for this case. |
| R5 | Fixed; regression passed | Sensitive dirty files previously contributed only size/mtime. The scoped test verifies fail-closed without content reads. | None for this case. |
| R6 | Fixed; regressions passed | Alternate `CODEX_HOME` could diverge from the import source. Tests reject a conflicting Host home before opening storage and a mismatched app-server home before dispatch. | None for these paths. |
| R7 | Fixed; regression passed | Non-Git workspaces had no reliable freshness fingerprint. The scoped test verifies fail-closed. | None for this case. |
| R8 | Fixed; regression passed | v4 tool failure uses `message.isError`; per-event clipping was undisclosed. The scoped test verifies failure labeling, a single truncation warning, and redaction. | None for these cases. |
| R9 | Fixed; independent test passed | Full v4 seed producer notice was mislabeled as `## Original goal`. The focused verifier test now finds the first human request in that section and excludes the plugin notice. | None for this case. |

## Verification matrix

| Gate | Status | Evidence still needed |
| --- | --- | --- |
| DSH v4 real create/query/persist and Full seed | Pass in installed runtime | `scripts/verify-roundtrip.mjs --full` used official `Agents.create`, `Session.append`, `SessionQuery`, and `sessions.flush` against installed DSH 0.2.0-rc.2. |
| Typed Remote and package generation | Main/packaging run pass | Main reports full `pnpm run check` exit 0 (229 tests), generated seven RPC descriptors, drift gate, and isolated Desktop CLI add/list/remove. These are other-run results, not this verifier's direct GUI test. |
| Durable prepare, TTL, source/DSH/Git freshness | Pass in scoped tests | Host tests cover expiration, stale snapshots, non-Git, source search, and pre/post-send faults. |
| Fresh real DSH return ledger | Pass in installed runtime | Official `DomainFacility` global prepare, dispatch claim, close/reopen, and fresh-facility reload passed. |
| Two coordinators sharing one Host store → one fork/injection | Pass in global-slot fixture | Two-service race passed with one fork/injection and idempotent repeat. Cross-process CAS is out of scope. |
| Fork success ACK, persisted raw context, source unchanged, idle/no inference | Pass in isolated full flow | Official Codex fork/inject succeeded; raw derived rollout contains return marker/progress; source file SHA-256 unchanged; official `thread/read` has zero turns; no new assistant/tool event. |
| `complete → existing`; unchanged snapshot reuse | Pass in isolated full flow | Repeat sync returned the same fork as `existing`; a fresh preview reused the same receipt. |
| Unknown after ambiguous fork/inject transport outcome, no automatic retry | Pass in scoped fault tests | Fault injection covers possibly-sent fork/inject and durable-write failures. Real transport ambiguity was not induced. |
| Official binary discovery/proxy fallback/PowerShell resume quoting | Main native probe plus tests | Main native Windows probe exercised Store discovery, capability probe, proxy fallback, fork/inject; scoped transport tests cover command quoting. |
| Actual Electron window click flow | Not run | Explicit window interaction evidence; Host/CLI probes alone do not prove this. |

## Current proof and GUI boundary

This verifier independently drove the plugin's gateway and return service through installed DSH Desktop's bundled Electron Node runtime, using a synthetic Codex source created through official `thread/start` and `thread/inject_items` in an isolated temporary home and a separate, committed Git fixture. The real DSH session was created, queried, appended through `Session.append`, and flushed. The return service then issued official fork/inject calls. The raw derived rollout contained the injected return marker and progress text; source SHA-256 was unchanged; official `thread/read` returned zero turns. No model adapter request or tool execution occurred. The verifier used the service APIs, not a running Electron window click or installed UI overlay. The GUI click flow remains unverified.

## Executed checks

The sequence below is chronological. Every failed snapshot is historical and superseded by the later evidence shown here; none is an active R1–R9 finding.

- **Historical failure:** Windows Node `v24.21.0` TypeScript `--noEmit` failed on the initial integration snapshot: missing Host Remote methods, an unresolved `AppServerFailure` reference, and strict optional-type errors.
- **Historical test-expectation failure:** the initial scoped return test expected English wording while the context contained equivalent Chinese wording, so it did not reach the race assertion.
- After that assertion was corrected, the scoped test **passed** (1 test): one fork/injection across two coordinators and `existing` on repeat. This old `AtomicMemoryTable` fixture accepted absent-key updates and was subsequently replaced; it never proved the official storage contract.
- After Host wiring, TypeScript `--noEmit` **passed**.
- **Historical full-suite failure:** the integration snapshot had 197 passed and 12 failed tests: seven stale v2 Host fixtures and five client apply failures. This result is superseded by the final main gate below.
- **Historical R9 failure:** the independent Full-import test reproduced the producer notice in `## Original goal` instead of the human request.
- After the global-singleton rewrite, the shared-global scoped fixture **passed** (2 tests), including two coordinators sharing one store. **Historical typecheck failure:** unused imports/variables remained in the owner's in-progress test file; later cleanup resolved them.
- Installed DSH `0.2.0-rc.2` Electron Node `DomainFacility` proof **passed**: fresh global write, dispatch claim, close/reopen, and new-facility reload using a disposable JSON storage root.
- After the R9 compiler fix, the independent Full-import regression **passed** (1 test), selecting the human goal and excluding the producer notice.
- **Historical verifier setup failures:** early full-flow attempts needed the official SessionQuery provider, `surfaceOp: 'append'`, and the correct `codexForkId` response field. A normalized lifecycle assertion also mistook an injected-message boundary for inference. Later assertions use official `thread/read` and assistant/tool evidence. An active repository caused `RETURN_STALE`; a subsequent attempt hit an Electron read-stream `EBADF`. The accepted final runs used a separate committed Git fixture and passed.
- This verifier reran the scoped host and Full-import tests: **19 passed**, 0 failed. TypeScript `--noEmit` and the documentation gate **passed**.
- Main reports full `pnpm run check` exit 0: 54 client tests and 229 full tests, both typechecks/builds, lint, and package imports. The packaging worker reports seven-RPC generation/drift and isolated Desktop CLI add/list/remove **passed**. These are other-run results; this verifier did not rerun that whole gate.
- **Final actual PASS:** the isolated full-flow command below passed real DSH v4 create/query/persist, plugin return preview/sync, official Codex fork/inject, raw derived context persistence, unchanged source SHA, official `thread/read` zero turns, `existing` repeat, and unchanged-preview receipt reuse. The real `DomainFacility` proof, script syntax check, and documentation gate also passed. No GUI click or model/tool run was attempted.

## Reproduction of the accepted runtime proof

Versions: installed DSH Desktop `0.2.0-rc.2`, official Codex CLI `0.159.2`, Windows Node `v24.21.0` launching Desktop's bundled Electron Node `v24.18.1`. These commands were run from WSL Bash. `WSLENV` passes the named variables to Windows Node. The verifier then loads the installed ASAR packages with `ELECTRON_RUN_AS_NODE=1` and `--expose-internals`; no GUI window is launched.

Exact real `DomainFacility` invocation:

```bash
cd /mnt/d/Project/DSHP
WSLENV=DSH_DESKTOP_ROOT \
DSH_DESKTOP_ROOT='C:/Users/DELL/AppData/Local/Programs/DeepSeek Harness' \
'/mnt/c/Users/DELL/AppData/Local/Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/node/bin/node.exe' \
  scripts/verify-roundtrip.mjs
```

Exact accepted full-flow invocation, using the verifier-owned synthetic temporary home and source:

```bash
cd /mnt/d/Project/DSHP
WSLENV=DSH_DESKTOP_ROOT:DSH_VERIFY_CODEX_HOME:DSH_VERIFY_SOURCE_ID \
DSH_DESKTOP_ROOT='C:/Users/DELL/AppData/Local/Programs/DeepSeek Harness' \
DSH_VERIFY_CODEX_HOME='C:/Users/DELL/AppData/Local/Temp/dsh-self-source-22pEsu/codex' \
DSH_VERIFY_SOURCE_ID='01a0fd55-a3d8-7711-bb87-fba2b24ddd70' \
'/mnt/c/Users/DELL/AppData/Local/Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/node/bin/node.exe' \
  scripts/verify-roundtrip.mjs --full
```

For a fresh synthetic source, the following setup creates a new owned temporary root, commits a Git fixture, and uses official `thread/start` plus `thread/inject_items` without starting a turn. Run from the repository after `dist` is built, then substitute the printed environment values into the full-flow invocation. This is a reproduction procedure; the documentation cleanup did not execute another setup or test.

```bash
'/mnt/c/Users/DELL/AppData/Local/Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/node/bin/node.exe' --input-type=module <<'NODE'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCodexAppServer } from './dist/codex/app-server.js'

const root = await mkdtemp(join(tmpdir(), 'dsh-self-source-'))
const codexHome = join(root, 'codex')
const workspace = join(root, 'work')
await mkdir(codexHome)
await mkdir(workspace)
await writeFile(join(workspace, 'README.txt'), 'synthetic fixture\n')
const git = args => execFileSync('git', ['-C', workspace, ...args], { stdio: 'ignore' })
git(['init', '-q'])
git(['add', 'README.txt'])
git(['-c', 'user.name=Verifier', '-c', 'user.email=verifier@example.invalid', 'commit', '-qm', 'initial'])
const server = await createCodexAppServer({ codexHome })
try {
  const started = await server.transport.request('thread/start', { cwd: workspace, ephemeral: false })
  await server.injectUserContext(started.thread.id, 'Synthetic human original goal: verify the round trip.')
  console.log(JSON.stringify({ DSH_VERIFY_CODEX_HOME: codexHome, DSH_VERIFY_SOURCE_ID: started.thread.id }))
} finally { await server.close() }
NODE
```

The user's default Codex and DSH homes are never used. The full verifier removes only its own disposable DSH storage/session root; the supplied synthetic Codex home remains available for read-only inspection of source and derived rollout files.

## Boundaries

`thread/inject_items` returning `{}` is the success acknowledgement. The official visible `thread/read`, turns, and items views do not expose the injected raw item in the observed 0.159.2 behavior; empty visible history cannot establish failure or reconcile `unknown`. No result in this report should be interpreted as permission to repeat a possibly sent fork or injection.
