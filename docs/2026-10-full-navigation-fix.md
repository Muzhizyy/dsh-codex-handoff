# Full import navigation repair contract

2026-10-03. Scope: repair successful Full import followed by failed client navigation in installed DSH 0.2.0-rc.2. The underlying Smart analyzer and import/fork persistence are outside the change scope.

## Required behavior

The session-controller face supplies list membership and refresh only. Conversation selection is delegated to the official `uiWorkspace.openSession` UI service. Both the exported Cordis service injection and the nested mounted-remote scope must declare `uiWorkspace`. Client package metadata must load `@deepseek-ai/dsh-client-ui-workspace`. No legacy `sessions.open` fallback, private session-manager access, or DOM navigation is allowed.

After a successful create response, the outcome remains authoritative. If membership refresh or navigation fails, display a recoverable, mode-neutral opening error and preserve that outcome. Retry refreshes and opens the same session; it does not send another create request. Cancellation or supersession must prevent stale navigation. Attached results close the import overlay; unattached results retain their existing warnings.

Acknowledged outcomes remain authoritative even if changing UI settings clears an opening error. A successfully opened unattached outcome is a no-op on another create-button call. Cancelling after acknowledgement preserves the outcome and permits open-only recovery; cancelling before acknowledgement retains the previous behavior, with backend deterministic identity protecting a later reattempt.

The generic internal-error message must not claim Smart/model failure for unrelated operations. Tests must separate session-controller and UI-navigation fixtures, so a nonexistent method on the real controller cannot be hidden by the fake.

## Acceptance

- Client tests cover Full import, separate navigation, navigation/refresh failure, open-only retry, and cancellation.
- Run the full automated checks, builds, and package checks.
- Rebuild the local unpublished archive; test that exact archive in the installed DSH Web profile with real Chrome clicks and real RPCs.
- Full import must open the destination conversation, with no model calls. Verify return preview/branch creation if the flow proceeds; report any unverified gates explicitly.
- Keep historical failure evidence and record the new empirical result without presenting API-only checks as GUI verification.

## Final verification — PASS

Main ran `pnpm run check` with installed DSH's native Windows Node v24.21.0 and pnpm 11.7.0 after the final guard change: exit 0; **251 tests across 24 files**, including **60 client tests across 5 files**, both typechecks/builds, lint, seven forbidden-import boundaries, and packed Host/Client/Remote/Typert import/install checks passed. `scripts/check-docs.mjs`, the browser harness's native Node syntax check, and `git diff --check` also passed.

The rebuilt local, unpublished `artifacts/dsh-codex-handoff-0.2.0-rc.2.tgz` keeps the package version and has SHA-256 **`2d5954c33d7f95237833d6f72fbefcc29943e695de534b18b6f0c2e6d1b79864`**. The old archive is retained at `.desktop-test/full-ui-pack-o0EQN6/before-fix.tgz` for comparison; its historical SHA remains documented in the earlier failure report.

Main then ran `scripts/verify-browser-flow.mjs` against that exact archive, the installed DSH 0.2.0-rc.2 Web profile, real Chrome 154 headless, and installed Codex `0.159.0-alpha.12.1`, using fresh temporary DSH/Codex/agent-skill homes and a committed synthetic Git workspace. Exit 0:

```text
REAL BROWSER FLOW PASSED: installed 0.2.0-rc.2 archive loaded in isolated DSH Web profile; UI Full import, return preview/branch creation, copied resume command; 0 model calls, 0 external browser requests, exact derived Codex thread 01a100e5-e295-7f60-b72f-cdc00844b7d9
```

Real clicks covered first-run notice acknowledgement, source selection, Full mode, persistence confirmation, creation, automatic overlay closure and destination-conversation display, return preview, Codex branch creation, and copying the displayed resume command. Main inspected the created-conversation and return-success screenshots. RPC responses were real, not mocked; no `analyze` request was sent. The exact derived rollout contains the fresh receipt marker and synthetic task, and the original source rollout's pre/post SHA is unchanged. Clipboard contents matched the displayed command. Browser console/page errors, failed HTTP responses, rejected-model requests, and external page requests were zero. This fixture has no historical tool-call pair; historical tool-pair behavior is covered by the existing automated tests, not claimed as a new browser replay probe.

Evidence was created at `C:\Users\DELL\AppData\Local\Temp\dsh-codex-browser-flow-tNRvIv\artifacts` and copied to `.desktop-test/full-ui-pack-o0EQN6/browser-evidence/` (six stage screenshots and `evidence.json`). The recorded source thread is `01a100e5-ce23-79e3-985c-40cddf79223d`; the created DSH session is `session-codex-handoff-d08850d0388564298bd8bceae77572b5`.

An earlier repair run already passed Full creation/navigation but stopped because the test harness's nested details locator was incorrect. That test-only selector was corrected before the final pass; it was not a plugin return failure. The original post-create failure remains in `docs/2026-10-browser-verification.md`.

This verifies the installed runtime's **Web browser UI**, not native Electron-window clicks. It does not test live model development, Smart model analysis, or a running personal profile. Updating the same-version package requires installing this exact new archive and restarting DSH.

Main additionally ran the installed Desktop CLI/profile acceptance against the same final archive in fresh isolated `D:/Project/DSHP/.desktop-test/full-ui-install-wAN8n6`: exit 0, `installed DeepSeek Harness Desktop CLI/profile acceptance passed at 0.2.0-rc.2; isolated package add/list/remove`. Only the temporary profile's plugin was removed. Packed `dist/client.js`, README and CHANGELOG were byte-identical to their finalized source/build counterparts; the packed manifest's runtime metadata, exports and dependencies match the source, including the UI-workspace dependency (pnpm omits the development-only `packageManager` field during packing).
