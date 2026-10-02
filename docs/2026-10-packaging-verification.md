# DSH 0.2 Typert and installed Desktop packaging check

Generation and initial installation checks ran on 2026-10-02 with Windows Node `v24.21.0` from `D:\Project\DSHP`; the final repack and installed CLI acceptance rerun completed on 2026-10-03. This records the independent generation and package installation run plus the main coordinator's final artifact evidence. The full DSH/Codex return roundtrip and an Electron window click are separate verification scopes.

## Official generator provenance

The upstream checkout at `D:\Project\DSHP\.desktop-test\upstream-native-20261002` was verified by native `git.exe rev-parse HEAD` as `639ed015397290b3745d163aafe02ffee4aa3f84`. Its source is `packages/typert/generator/src`; no protocol metadata was written by hand.

The following commands ran from that checkout in WSL Bash. The first filtered install supplied the upstream generator's transitive workspace dependencies, including `@standard-schema/spec`. The TypeScript build then completed with exit 0. Its compiled JavaScript was copied into the `lib/` layout expected by this repository's generator script; this was a build-artifact copy, not a change to upstream source.

```sh
'/mnt/c/Users/DELL/AppData/Local/Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/node/bin/node.exe' 'D:\Project\DSHP\.desktop-test\tools-20261002\node_modules\pnpm\bin\pnpm.cjs' install --filter '@deepseek-ai/dsh-typert-generator...' --ignore-scripts --frozen-lockfile
'/mnt/c/Users/DELL/AppData/Local/Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/node/bin/node.exe' node_modules/typescript/bin/tsc -b packages/typert/generator/tsconfig.json --pretty false
cp packages/typert/generator/lib/types/*.js packages/typert/generator/lib/
```

From `D:\Project\DSHP`, these exact commands invoked the pinned official `WorkspaceTypertGenerator` through `scripts/generate-typert.mjs` and reran it twice for deterministic drift verification. `WSLENV` passes the Windows checkout path into native Node.

```sh
WSLENV='DSH_PINNED_CHECKOUT' DSH_PINNED_CHECKOUT='D:\Project\DSHP\.desktop-test\upstream-native-20261002' '/mnt/c/Users/DELL/AppData/Local/Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/node/bin/node.exe' scripts/generate-typert.mjs
WSLENV='DSH_PINNED_CHECKOUT' DSH_PINNED_CHECKOUT='D:\Project\DSHP\.desktop-test\upstream-native-20261002' '/mnt/c/Users/DELL/AppData/Local/Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/node/bin/node.exe' scripts/verify-typert-drift.mjs
```

The first command reported `Typert artifacts emitted by the pinned official WorkspaceTypertGenerator`. The drift gate reported five artifacts byte-identical across both reruns. `remote.js` contains seven generated methods: `analyze`, `compatibility`, `create`, `discover`, `preview`, `returnPreview`, and `returnSync`. Four generated files changed; `typert.d.ts` remained byte-identical. The upstream checkout had no tracked changes after generation.

## Package and installed Desktop results

The native Windows build passed its package artifact gate. `pnpm pack --pack-destination artifacts` produced `artifacts/dsh-codex-handoff-0.2.0-rc.2.tgz`. The package gate passed an `--ignore-scripts` install and loaded the packed Host, Client, Remote, and Typert exports; its Remote assertion counted all seven methods. This initial archive preceded the final README and CHANGELOG edits; the final archive hash and acceptance rerun are recorded below.

The following command ran against the installed DeepSeek Harness Desktop `0.2.0-rc.2` executable and `app.asar`, using a new isolated `DSH_HOME` under `.desktop-test`:

```sh
WSLENV='DSH_TEST_HOME' DSH_TEST_HOME='D:\Project\DSHP\.desktop-test\installed-desktop-20261002-7rpc' '/mnt/c/Users/DELL/AppData/Local/Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/node/bin/node.exe' scripts/installed-desktop-acceptance.mjs
```

It exited 0 with `installed DeepSeek Harness Desktop CLI/profile acceptance passed at 0.2.0-rc.2; isolated package add/list/remove`. The script initialized the profile through the installed `@deepseek-ai/dsh-app-boot` export, added the tarball, checked the persisted dependency and bundle, confirmed the installed version and CLI list, removed the plugin, and confirmed the final CLI list and manifest were clean. The final manifest contains only `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app`; no profile lock remained. It did not launch an Electron GUI, touch the default personal DSH or Codex homes, call a model, or push to a Git remote. No source commit was made in this verification run.

## Final archive and acceptance rerun — 2026-10-03

After README and CHANGELOG were frozen, the main coordinator repacked `artifacts/dsh-codex-handoff-0.2.0-rc.2.tgz` and verified that its README, CHANGELOG, Client bundle, and Host return code matched the final workspace files byte-for-byte. The final archive SHA-256 is `8d4047b2a570ee9f6b4462951072b2ab7e16959b187dbec866fda6cbcc2d2d98`; this report update independently confirmed the same hash with `sha256sum`.

The coordinator reran `scripts/installed-desktop-acceptance.mjs` with the same native Windows Node runtime, setting `DSH_TEST_HOME` inside the Node wrapper to `D:\Project\DSHP\.desktop-test\installed-desktop-final-oC2Ejn`. Official fresh-profile bootstrap and final-archive add/list/remove passed with exit 0. An earlier attempt to reuse a previously cleaned acceptance home was refused before writes because official plugin removal omits an empty `dependencies` property. This acceptance script therefore needs a fresh isolated profile for each complete run. The final rerun provides installed CLI evidence; no Electron window click was performed.
