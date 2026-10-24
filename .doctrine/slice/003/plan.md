# Implementation Plan SL-003: Topics and the conversation index

Prose companion to `plan.toml`. Narrative only — no queried data lives here
(the storage rule); the phase list, criteria, verification, and links are
authored in the TOML. Use this for the plan's rationale and sequencing.
<!-- Reference forms: `lib:reference/glossary.md` § reference forms. -->

## Overview

SL-003 adds one piece of durable state, the conversation index, and then
exposes it outward in layers: store, daemon dispatch, wire, client, docs.
Each phase ends green on its own and leaves the system shippable: until
PHASE-03 nothing on the wire changes, and until PHASE-04 no client flag does.

| Phase | Layer | Proves |
|---|---|---|
| PHASE-01 | store | every creating commit indexes; root by the hook alone; backfill is idempotent |
| PHASE-02 | daemon | first-line dispatch by table, with no behaviour change |
| PHASE-03 | wire | the topic frame, attach by topic, filtered and topic listings, D1, the daemon's `profile` |
| PHASE-04 | client | one request path, the topic flags, the skew rule |
| PHASE-05 | client | `--here`, checked against the daemon's own profile |
| PHASE-06 | docs | README, internals, and one live session |

## Sequencing & Rationale

**pi 1.4.0 first, outside the slice.** DEC-011 put the upgrade in CHR-002
because a SQLite store migrates one way and the room's pi-env binary churns
while two versions share it. PHASE-01's first entrance criterion is that chore,
done. The design is written against 1.4.0 (`checkpointWhen` is mandatory
there), so no phase starts on 1.3.0.

**The index before anything reads it.** PHASE-01 is pure state: a document, a
hook, a backfill, and the reads. It changes no reply, so it can land and run in
the live daemon before a client knows topics exist. That is also the only
moment the backfill meets a real pre-index store with nothing else moving.

**Refactor before feature (PHASE-02).** Splitting first-line frames into their
own parser and a dispatch table is behaviour-preserving, and doing it alone
means the shipped daemon tests are the whole proof. Adding the `topic` verb in
the same phase would mix a refactor's "nothing changed" claim with a feature's
"this changed", and neither would be checkable. PHASE-02 does not depend on
PHASE-01's code; it may run in parallel.

**Wire before client.** PHASE-03 is where the protocol widens, and where the
D1 rule (directory copied at creation) is proved over a real harness. The
client phases then build against shapes that exist.

**The client splits before it grows (PHASE-04).** `src/attach.ts` already
holds three concerns: command-line parsing, the interactive connection, and the
listing lifecycle. The design moves the first and third to
`src/attach-invocation.ts` and `src/request.ts`. The move lands first, with
only files and imports changing, so the shipped attach tests are its whole
proof; the topic flags and `--here` are then added to the module that owns
each concern.

**`--here` on its own (PHASE-05).** It carries most of RV-008's findings
(F-1, F-2, F-3, F-6) and the newest mechanism, the daemon-reported profile.
Separating it from PHASE-04 keeps the request-path refactor reviewable on its
own and gives `--here`'s refusal matrix its own exit.

**Docs last, with the live check.** PHASE-06 writes what shipped, sweeps
`.doctrine/` for claims the slice falsified, and runs the one VH session that
needs both daemons on 1.4.0 with matching pi-env. The DEC-007, DEC-008 and
DEC-010 amendments are reconcile's, not a phase's.

## Notes

- RV-008 routed no finding to an instrument route (`demonstrate`, `probe`,
  `control`), so nothing is transcribed from the ledger; F-1..F-6 are repaired
  in the design and land as ordinary criteria (PHASE-01 EX-2, EX-3, EX-5;
  PHASE-03 EX-4; PHASE-05).
- A planning-time architectural review (Codex, 2026-10-24) produced the
  sec-3/sec-6 amendment (validator in `src/protocol.ts`; the client split),
  checked on RV-009, plus three plan-only points: `Conversations` returns
  values and the daemon builds replies (PHASE-03 EX-8); index writes merge
  rather than replace (PHASE-01 EX-7); the table is dispatch plumbing, not a
  verb's whole cost (PHASE-02 VA-1). Its RFC-001 refresh is a follow-up.
- Baseline: the `test/runner/*` red set recorded in
  `mem.fact.malebolge.runner-suite-red-in-agent-container` was counted on
  1.3.0. Re-count it after CHR-002 before treating it as the baseline.
