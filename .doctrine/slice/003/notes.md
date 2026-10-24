# Notes SL-003: topics and the conversation index

Durable per-slice scratchpad, tracked in git. Anything from a disposable phase
sheet or the design run's runtime state that must survive `rm -rf` of
`.doctrine/state/` goes here.

## Research

Round run 2026-10-24 from `~/dev/satan`, which holds the quotient and flake
setup. `research/research.md` is the curated artefact; `research/raw/` holds
the verbatim thread output. The quotient `pi_agent` MCP route refused to run
(server read `quotient-policy/1`, policy file is `/2`), so both threads ran
through the shell scripts. A session restart was expected to fix it.

## Design run

Run `dr-01a16bce-…`, started 2026-10-24.

### Triage (explore.triage)

**Constraining governance.** The repo has no ADR, POL, STD or SPEC. These
bind:

- DEC-007 (list frame, bare ids; widening rule; `FrameRefused` on every
  first-line frame);
- DEC-008 (`--list` exclusivity);
- DEC-010 (refuses `--here` for the room/host path mismatch);
- RFC-002 D1, D3, D7 and I-1, adopted through the scope;
- satan DEC-104 (model is a creation-time default; root re-configured on open)
  and DEC-107 (cwd is an opaque string).

Satan ADR-017 and ADR-018 were checked and add no authority-ledger item. Full
rows: `research/research.md` Thread 1.

**Shaping decisions to make** (each is an inquiry node in the run):

1. pi-durable 1.4.0 upgrade, raised by the user 2026-10-24: a phase of this
   slice, or a chore before it.
2. Index seam: `conversationCreated` hook plus `init`, or `init` alone
   (research X-1).
3. Index shape: one document or a family (OQ-3). This is about size and the
   checkpoint policy, not contention (X-5).
4. `--here` path space (OQ-1; X-2). The user decides.
5. "Latest" and `default`/root, coupled (OQ-2, OQ-4; X-3, X-4).
6. Protocol: the `topic` frame, the topics listing reply, and splitting the
   first-line verbs (objectives 3, 5, 6).
7. Version skew: both `unknown message type` and `unknown key topic` (X-7).
8. Backfill: when it runs, paging, and its ordering guarantee (A2).
9. Topic names: what is valid.
10. Client surface: `--topic`, creating and pointing a topic, flag
    exclusivity under DEC-008.

**Risks**

- **Two pi-env daemon binaries in one room** (user note 2026-10-24). If the
  runner, pinned by the flake, and the daemon, built from the live tree, ship
  different pi-env daemon bytes, each start deletes the other's binary. pi-env's
  `deployDaemon` names the binary by sha256 and removes the others, but a
  running daemon stays until it exits
  (`~/.local/src/pi/packages/env/src/ssh.ts:405-435`). The result is churn,
  not breakage. pi-env 1.3.0 to 1.4.0 changed only a test
  (`git log v1.3.0..v1.4.0 -- packages/env`), but the bundled binaries
  still differ: `bin/pi-env-linux-x64` is `145eacb3…` in 1.3.0 and
  `46dde0e2…` in 1.4.0 (sha256, checked 2026-10-24 with `npm pack`). The
  churn is real while the two versions share a room. Mitigation: move the
  runner's flake pin in the same rollout. Satan RSK-020 covers the two
  revisions.
- **SQLite schema v2 migration is one way.** A store opened by 1.4.0 cannot be
  reopened by 1.3.0, so no rollback past the upgrade.
- **Inconsistent prompt until D2** (scope Risks): a topic with its own
  directory still gets the daemon's project context.
- The concurrent-writes risk is retired: commits run on one mutation line
  (research F-6, X-5).

**Assumptions**

- A1 (fork `init` can write a session-scoped document) holds. Verified at
  `dist/harness/types.d.ts:412-421`.
- A2 (scanning at startup is cheap) holds per page; backfill pages through.
- `conversationCreated` fires when `harness.root()` creates root on a fresh
  store. Verified during design: root goes through `#create` →
  `#stageConversation` (pi `src/harness/harness.ts:394-411`).

**Open questions**: OQ-1 to OQ-4 in the scope, mapped to nodes 3 to 5 above.

### Review (RV-008)

Policy adversarial-then-human. Adversarial lane: Codex (gpt-6.1-sol) as
raiser, three rounds. Six findings, all fix-now and verified. The ledger
holds the detail; the design holds the result.

**Further passes.** None needed at design level: the pass covered all seven
sections, re-checked every revised one, and found nothing on the
pi-durable seam, wire compatibility, or three of the four judgement calls.
The fourth (`--here` reading `MALEBOLGE_PROFILE`) became F-2. What remains
is implementation-time risk, which a design pass cannot settle and the
sec-7 criteria own:

- pi 1.4.0 behaviour was checked against the tagged source, and executed
  only against the installed 1.3.0 (F-4's probe). CHR-002 lands 1.4.0 first;
  the `readIndex` and creating-commit tests then run against it.
- The daemon-reported `profile` (F-2) is the newest mechanism, and the
  least examined. Its tests must cover both mismatch directions.

If a later pass is wanted, it should probe the client's `resolveHere` and
`request` code once written, not this prose.

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-24 · design locked (run rev 41; RV-008 done); slice → plan · 5970b67 (all SL-003 work uncommitted)

### Produced
- design locked 2026-10-24 on the user's section review, `conducted` RV-008, and acceptance
- research round: `research/research.md` (cross-repo, shell route)
- design run `dr-01a16bce-…`: 10 inquiries resolved; 7 sections; `design.md` materialised; review policy adversarial-then-human
- RV-008: Codex adversarial pass, F-1..F-6 verified; adversarial lane attested sec-1..sec-7
- minted: DEC-011..DEC-017 — the shaping decisions; CHR-002 — pi 1.4.0 upgrade, SL-003 needs it; IMP-009 — `--here` under `room`
- amended at RV-008: DEC-014 (daemon-reported profile; lookup refusals for attach/list only), DEC-016 (`profile` on the `topics` reply)
- scope `slice-003.md` amended to the decisions; selector `src/daemon-start.ts` → design-target
- no code; no gate run (nothing to gate)

### Learned
- mem.fact.malebolge.pi-env-version-skew-churns-room-daemon — mismatched pi-env versions delete each other's room daemon binary
- mem.fact.deps.pi-durable-conversation-created-covers-root — the hook fires on every creation path, root included

### Open
- DEC-007, DEC-008, DEC-010 — amendments owed at reconcile (design sec-7)
- run rev 38 recorded a `design-accepted` act in error (a top-level `acceptance` on a declare-only submission records one). `review-disposed` did not stale it; the lock at rev 41 invalidated it and recorded the user's acceptance
- quotient `pi_agent` still refuses: server reads quotient-policy/1, policy file is /2 (retested 2026-10-24, after restart)
