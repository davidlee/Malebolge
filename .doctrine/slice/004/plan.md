# Implementation Plan SL-004: Conversation context in the tool environment and system prompt

Prose companion to `plan.toml`. Narrative only — no queried data lives here
(the storage rule); the phase list, criteria, verification, and links are
authored in the TOML. Use this for the plan's rationale and sequencing.
<!-- Reference forms: `lib:reference/glossary.md` § reference forms. -->

## Overview

Three phases, each ending green: the pure context module, then its two
outlets — tool environment and system prompt — in that order.

```
PHASE-01  conversation-context.ts   contextOf · conversationVars · conversationLine   (no consumer)
   │
PHASE-02  tool env                  session.ts · daemon-env.ts · room/connection.ts · harness-fixture.ts
   │
PHASE-03  prompt + docs             conversationExtension · daemon-extensions.ts · README · internals
   └─► VH-1 (user, in the room, after deploy)
```

## Sequencing & Rationale

- **Pure core first.** DEC-018 puts one index read and one mapping behind
  both outlets. Building and testing them alone fixes the contract (all six
  names, empty when absent — DEC-021) before either outlet depends on it.
- **Tool env before prompt.** It carries the slice's only MAJOR risk
  (RV-012 F-1: masking an inherited value in the room) and the one type
  change that ripples (`SessionOptions.env` → `EnvTarget`, through
  `daemon-env.ts`, `daemon-start.ts` and the test fixture). Landing it second
  leaves the last phase a small, additive section.
- **RV-012 F-1 is demonstrated by test on both profiles.** The design placed
  the room half on VT-4 as "shellEnv is passed"; the existing room fixture
  runs pi-env's real local daemon behind a fake `ssh` that inherits the test's
  environment, so PHASE-02 asserts the masking itself (`[]`) in the room too.
  This strengthens, not changes, design VT-4. VH-1 then only confirms the
  deployed room and `q`'s `mem.origin` row.
- **Section in PHASE-03 lives in the same module** (DEC-018), so PHASE-01's
  `conversationLine` is its pure half and PHASE-03 adds only the extension
  wrapper and its registration.

Design VT ids map to phase VTs: design VT-1/VT-2 → PHASE-01/VT-1, VT-2;
design VT-3 → PHASE-02/VT-1; design VT-4 → PHASE-02/VT-2; design VT-5 →
PHASE-03/VT-1; design VH-1 → PHASE-03/VH-1.

## Notes

- `readIndex` takes `Pick<Session, "snapshot">`; pi-durable's
  `DocumentReader` is `Pick<Session, "snapshot" | "snapshotAsOf">`, so
  `EnvTarget.read` and `PromptInput.read` pass straight through (checked
  2026-10-24, `pi-durable/dist/types.d.ts:917`).
- Unit tests of `daemonEnv` need an `EnvTarget.read`; a stub reader whose
  `snapshot` returns `undefined` yields the unindexed context (the index's
  `initial()`), enough for masking cases. Two-conversation cases run over a
  real harness.
- Out of scope, unchanged: `src/runner/`, `src/satan-tools.ts` (RV-012 F-8),
  IDE-002.
