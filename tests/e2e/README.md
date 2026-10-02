# E2E acceptance

The real E2E is intentionally an explicit release gate because it checks out
the pinned DSH workspace and installs its dependencies:

```sh
pnpm test:e2e
```

`scripts/pinned-dsh-acceptance.mjs` creates a disposable `CODEX_HOME`-shaped
tree and a real Git repository, then uses the fixed DSH Agent/Session runtime
for discover, preview, deterministic Smart analysis, Full create, same-key
idempotency, persistence, restart/resume, and an explicit post-resume turn.
It snapshots source/repository bytes and installs a poison historical tool to
prove import/resume never replays the old tool. The temporary checkout and all
disposable roots are removed after the run.
