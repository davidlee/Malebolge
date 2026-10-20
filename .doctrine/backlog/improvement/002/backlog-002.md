# IMP-002: Structure: name the shared kernel, separate the interactive program, record the runner's mechanism

Raised 2026-10-19 from the structural review in RV-001 (findings F-1..F-7).

Motivating case (2026-10-19): satan:SL-027 in the SATAN repo (`malebolge daemon vm
mode: coding tools in the room`) must move room mechanism *out of*
`src/runner/` into shared use — the reverse direction from the one this item
assumes. RFC-001 answers that slice's `inq-2` with the tier described below and
re-weights F-4 onto its critical path; read it before starting step 1.

## Context

`src/` is 10.4k lines over three executables (`malebolge`, `malebolge-attach`,
`satan-runner`) and two programs. The dependency arrow is clean and one-way —
no root module imports `src/runner/*` except the `runner-main.ts` entry point —
but the tree does not *say* so. Twelve of the twenty-six root modules are the
runner's contract (`json`, `fields`, `message-of`, `truncate`, `ndjson`,
`unix-socket`, `context`, `models`, `config`'s `parseModel`, `grep`,
`project-context`, `session`'s `registryOf`); the other fourteen are the
interactive daemon and its client. Nothing in the tree, and no test, tells an
author which is which, so a future move can break the seam invisibly.

Meanwhile the runner — 8.2k of the 10.4k source lines, 45 files — has no
in-repo account of its mechanism. `docs/internals.md` (118 lines) covers the
daemon only. Its invariants are cited by label (`I13`, `EX-8`, `AS-4`, `R1`,
`EVD-008`, `satan:DEC-055`, `PHASE-09`, …: ~150 citations of ~35 labels) against
satan:SL-023..satan:SL-026 and satan:SPEC-004 in the SATAN repo, which the README names. A reader
here cannot check what a change preserves without leaving the repo.

Two modules already show the shape the kernel should take:

- `src/project-context.ts` — the policy (file names, cap, rendering) with an
  injected `SourceReader`, so the daemon reads it with node fs and the runner
  with a room shell. The same pipeline, two acquisitions.
- `test/runner/room.test.ts` "door knowledge (EX-10)" — a structural test
  asserting which files may name the door. The boundary is enforced, not
  merely intended.

## Proposed shape

Ordered; each step is shippable alone.

1. **Name the seam.** Move the runner's twelve shared modules under one
   directory (`src/shared/`, or `src/lib/`), leave the daemon's own under
   `src/daemon/`. Split `src/config.ts`: `parseModel`/`ModelRef`/`DEFAULT_MODEL`
   are contract; `Config`/`resolveConfig` are the daemon's. Split
   `src/session.ts`: `registryOf` is contract. Then add the structural test
   that mirrors EX-10: only `runner-main.ts` imports `runner/*`, and `runner/`
   imports no root module outside the shared allowlist.
2. **A third directory for the pi extension surface** — `persona`, `skills`,
   `cwd`, `project-context`, `grep`, `satan-tools`. These are not utilities:
   they are the sections and tools both hosts install, and they are shared for
   that reason. `runner/tools.ts` and `runner/guard.ts` are the runner's own.
3. **Record the runner's mechanism** in-repo (`docs/runner.md`, or a technical
   spec once the SATAN design stabilises): the state machine and its legal
   moves, the phase A/B recovery split and why it is split, the one-warning and
   ceiling rules, the port/adapter seam (room vs slot), and the seat/tenancy
   invariant. Carry the labels it needs rather than citing a foreign corpus by
   number alone.
4. **Only then** consider splitting `run.ts` (660 lines, 24 imports) along the
   units its own section comments already mark: admission, settlement,
   segment loop. The split is mechanical; deciding *where* admission belongs
   needs step 3's record.

## Acceptance

- `src/` root holds entry points only; every other module sits in a directory
  whose name states what it is.
- A structural test refuses a `runner/` import of a non-shared root module, and
  a root import of `runner/*`.
- A reader can learn the runner's state machine and recovery rules from this
  repo, without the SATAN corpus.

## Progress (satan:SL-027, 2026-10-20)

satan:SL-027 delivered part of this item (RFC-001 §3; RV-001 F-4, half):

- `src/room/` (connection, shell, source reader, door table), shared by the
  runner and the daemon;
- `test/structure.test.ts`: a three-sided import allowlist (runner, room,
  daemon) plus `ROOM_DOOR_READERS`;
- `parseModel`, `ModelRef`, `DEFAULT_MODEL` moved to `src/models.ts`;
  `registryOf` moved to `src/registry.ts`. `src/config.ts` and
  `src/session.ts` are now daemon-only.

Still open here: `src/lib/`, the rest of the two-`config.ts` split (the
names, one `Env` type), and the `run.ts` re-cut (RFC-001 §5: not bundled
with SL-027).
