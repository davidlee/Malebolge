# CHR-002: Upgrade pi packages to exactly 1.4.0, with the runner pin and room rollout

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## Context

DEC-011: lands before SL-003, which needs it. Raised by the user 2026-10-24.

## Change

- Move `@earendil-works/pi-ai`, `pi-durable`, `pi-env` and `pi-mcp` from 1.3.0
  to **exactly** `1.4.0`, not the `[Unreleased]` line. That line breaks
  `Storage.commit` (an `adopt` callback) and watches again.
- 1.4.0's breaking changes to check against malebolge (pi
  `packages/durable/CHANGELOG.md` §1.4.0):
  - `defineDoc` and `defineDocFamily` now require `checkpointWhen`. No current
    use (0 hits).
  - `TaskRuntime.sleep` was removed. Unused; the `sleep` calls in
    `src/runner/` are local helpers.
  - The new `sleeping` task status, and `restartLimit` (crash-loop guard):
    review the runner's task handling.
  - `TaskRuntime` and `ToolExecutionApi` gained `sleepUntil`, `setTimer` and
    `now`, which affects test fakes built by hand.
  - SQLite stores migrate to schema v2 **one way**. Both
    `session.sqlite` (the daemon's) and `runner.sqlite` (the runner's)
    migrate on first open, and 1.3.0 cannot reopen them.

## Rollout

- The pi-env daemon binary is uploaded to the room by sha256 at every start,
  and the other `pi-env-*` binaries are deleted
  (`pi/packages/env/src/ssh.ts:405-435`).
- 1.3.0 and 1.4.0 ship different bytes: `linux-x64` is `145eacb3…` in 1.3.0
  and `46dde0e2…` in 1.4.0.
- While the flake-pinned runner and the live-tree daemon differ, each start
  deletes the other's binary. That is churn, not breakage.
- So: move satan's flake pin for malebolge (the runner) in the same rollout.
  Satan RSK-020 tracks the two revisions.

## Done when

- All four packages are at exactly 1.4.0. `just check` and `just ert` are
  green.
- A store created by 1.3.0 opens and migrates under 1.4.0. Test it on a copy;
  never on the live store first.
- The runner pin has moved, and one live room start shows a single
  `pi-env-*` binary in the room.
