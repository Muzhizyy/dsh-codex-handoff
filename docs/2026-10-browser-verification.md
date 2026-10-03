# Real browser verification — failed at post-create navigation

Date: 2026-10-03. Main ran the installed DeepSeek Harness 0.2.0-rc.2 Web profile with its actual packed plugin, real Chrome 154 headless, and real plugin RPCs. No responses were mocked. This is browser UI verification, not native Electron-window verification.

This is historical failure evidence. The subsequent repair and successful real-browser Full/return verification are recorded in [the navigation repair report](./2026-10-full-navigation-fix.md); the archive hash below identifies the older failing build, not the repaired archive at the same filename.

Archive: `artifacts/dsh-codex-handoff-0.2.0-rc.2.tgz`, SHA-256 `631f29fa6cb0707b3d35b2cb802f16a5c6bcc676c211e6d6ef190db8309de479`.

## Observed result

- Plugin loading, first-run notice acknowledgement, source discovery, selection by session ID, Full preview, persistence confirmation, and the create-button click succeeded.
- The real `/api/codexHandoff/create` response was HTTP 200 with `result.ok: true` and value `{state: "created", sessionId: "session-codex-handoff-235f8eef85e91d7c1f550d9dd21f689e", workspaceAttached: true, warnings: []}`.
- The overlay stayed open and displayed `Smart analysis failed unexpectedly. A deterministic retry was also unsuccessful.` despite Full mode and successful creation. The test failed, exit 1. No return-preview/return-sync or clipboard gate was reached; none is marked passed.
- Model requests, external browser requests, browser console errors, page errors, and failed HTTP responses were all zero. These counts do not establish successful UI behavior.
- Another UI defect was visible: the synthesized official Codex thread's list title was its environment-context message, rather than its injected synthetic task description.

## Diagnosis

`src/client/model.ts` calls `this.sessions.open(outcome.sessionId)` after membership refresh. The official DSH source checkout at release SHA `639ed015397290b3745d163aafe02ffee4aa3f84` exposes `ISessions.retain`, `using`, `refresh`, and list state, but **no `ISessions.open`**; navigation belongs to view owners. Its concrete `ClientSessions` also has no `open` method. The plugin's local `ClientSessions` fixture interface still declares it. This is a source-confirmed integration mismatch consistent with the observed successful backend creation followed by a caught frontend exception. The captured browser result does not include the exception stack, so it does not independently rule out an earlier post-create client exception.

The generic `INTERNAL` UI text is also incorrectly specific to Smart analysis. Production code was not changed during this testing-only request.

## Evidence and reproduction

Latest evidence is retained at `C:\Users\DELL\AppData\Local\Temp\dsh-codex-browser-flow-uAymUR\artifacts\evidence.json`, with `failure.png` and three preceding stage screenshots in the same directory. Earlier setup failures involved the test harness's ASAR preflight, first-run overlay timing, workspace-picker assumptions, and title selector; these were corrected before recording this product failure. The same Full post-create error occurred in three consecutive actual runs.

Run from the repository with native Windows Node, after building `dist` and providing the packed archive:

```powershell
$env:DSH_BROWSER_TOOLS_PACKAGE = 'D:/Project/DSHP/.desktop-test/browser-tools-PjBpDF/package.json'
& 'C:/Users/DELL/AppData/Local/Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/node/bin/node.exe' scripts/verify-browser-flow.mjs
```

`DSH_BROWSER_TOOLS_PACKAGE` points at a package manifest whose dependency tree contains `playwright-core` (tested 1.63.0); otherwise the repository manifest is used. Chrome can be selected with `DSH_CHROME_PATH`. Every run creates fresh temporary DSH/Codex homes and a committed synthetic Git workspace; Codex thread creation uses official app-server calls without starting a turn. The final run also isolates the shared agent-skill root. Only owned browser/server children are stopped. Authentication launch URLs are kept private and excluded from evidence.

The regression harness passed native Node syntax checking. Existing API-level round-trip passes in the earlier report remain historical API results, not proof that this real UI flow works.
