Observed 2026-10-23 (SL-002 plan, base f13caae — a commit that touches only
`.doctrine/`, so this is the base's state, not a slice regression).

`npx vitest run` on this agent host: 1813 tests, **11 failed**, all under
`test/runner/`:

- `collect.test.ts` (3): "resets tracked edits and removes untracked files and
  nested repos; ignored files are kept", "is idempotent: a clean clone cleaned
  again is unchanged", "leaves collecting with the residue; collecting again
  (restart row 12) cleans, collected once"
- `recovery.test.ts` (1): "row 12 (VT-8): crashed between collect and clean…"
- `project-context-probe.test.ts` (7): P13 ×1, P14 ×2, P16 ×4

**Cause 1 — `git` is a guard shim.** `command -v git` is
`/home/david/.pi/agent/bin/git` (the pi agent's git-guard); the real one is the
`git-guarded` store path. The room's cleanup runs `git reset --hard`, and the
guard refuses it:

    git-guard: refused `git reset` -- would move the working tree, not just the
    index … re-run with GIT_GUARD=off if it is deliberate

`GIT_GUARD=off npx vitest run` takes the suite from 11 failures to **7** —
`collect` and `recovery` go green.

**Cause 2 — no room.** The remaining 7 are `project-context-probe`'s
"hostile binaries, time-scaled" probes. They run "over a real room clone and a
local pi-env daemon", and their fake binaries are placed first on the *daemon's*
PATH. Without a room, that contract does not hold: the probes record
`['git','status']` where they expect `['git','rev-parse']`, or `channel_failed`
where they expect `dirty_clone` / `timeout` / `overflow`.

**What this means for a slice.** Tests in `src/{protocol,daemon,conversations,
attach,render}.ts` and the Emacs suites are green here (`just ert` 24/24,
`just smoke` 3/3). The correct reading of a red `just check` is "no new failure
beyond this known 11", not "the base is broken" — and the fix belongs to a
room-capable environment, not to the slice.