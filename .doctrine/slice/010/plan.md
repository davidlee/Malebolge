# Implementation Plan SL-010: Per-topic model, and topics in the Emacs attach chooser

Prose companion to `plan.toml`. Narrative only — no queried data lives here
(the storage rule); the phase list, criteria, verification, and links are
authored in the TOML. Use this for the plan's rationale and sequencing.
<!-- Reference forms: `lib:reference/glossary.md` § reference forms. -->

## Overview

Seven phases along the design's data flow (design sec-1 diagram): the catalog
port, then the topic's stored model, then creation, then the client surfaces
(write, list, models), then Emacs. Wire and store land before Emacs; each
phase ends green under `just check`.

```
PHASE-01 catalog port, refOf, UnknownModel, creationModel   ── pi-ai name check
   │
PHASE-02 topic model: store, judge (catalog), frame
   │
   ├─────────────────────────────┐
PHASE-03 creation via topicInit  PHASE-04 CLI --model/--no-model, --topics field
   │  + heartbeat catch          │
   │  ── heartbeat-path check    │
PHASE-05 summaries, --list lines, Emacs line parsing   ── summaries cost check
   │                             │
   └──────────────┬──────────────┘
PHASE-06 models listing (--models)
   │
PHASE-07 Emacs: malebolge--client, topic on new, set-topic-model   ── VH
```

## Sequencing & Rationale

- **Catalog first.** Every later phase judges or renders a model through the
  port. PHASE-01 also lands the shared test fixture (a catalog with a slashed
  model id, and a literal `ModelCatalog` stub) so later phases do not grow
  their own.
- **Store before creation.** Creation reads the topic's stored model, so the
  write and its judgement (PHASE-02) come first. PHASE-04 depends only on
  PHASE-02 and may run before or after PHASE-03.
- **Creation with the heartbeat catch.** The catch exists only because
  creation can now refuse; landing them together keeps the daemon start safe
  in every commit.
- **Emacs line parsing with the `--list` change.** PHASE-05 changes the
  `--list` line shape. The chooser's candidate regex moves with it, so no
  commit leaves Emacs unable to read the listing (the stale-`malebolge.el`
  diagnostic was dropped in review; this ordering is what keeps the repo
  itself consistent).
- **Models listing after both client phases.** It touches the request and
  invocation plumbing PHASE-04 and PHASE-05 have just widened.
- **Emacs last.** PHASE-07 needs `--topics` with models (PHASE-04) and
  `--models` (PHASE-06). It closes with the operator's hand-run check (VH).

## Carried checks

From `notes.md` § Review passes, each on the earliest phase that can hold it:

- pi-ai's chat-model enumeration name → PHASE-01/EN-2 (confirmed at plan
  time: `getModelsOfType`).
- The heartbeat create reaches `topicInit` → PHASE-03/EN-2 (read at plan time;
  PHASE-03/VT-5 proves it end to end).
- Summaries cost on a 50-id page → PHASE-05/EN-2, recorded by PHASE-05/VA-1.

## Design review findings

RV-022, the design's review ledger, holds no findings: round 1 was informal
(pi, GPT and verify passes; `notes.md` § Review passes). No routed
`demonstrate` / `probe` / `control` obligation exists to transcribe.

## Notes

- **thread_start's refusal mapping (PHASE-03/EX-8).** Design sec-4 says a
  stale stored model refuses creation, but not how thread_start returns it. The
  thread tools map only `Refusal` to a tool refusal; anything else is
  rethrown as a bug. The plan makes `UnknownModel` a refusal there, the
  smaller of two local options: DEC-083's "refuses creation" applied to the
  tool path, not a new decision.
- **Docs.** Design sec-7 names no docs. PHASE-04 and PHASE-06 update
  README.md's topic block and docs/internals.md where they already describe
  the `--set-topic` flags.
- **Error identity across the creating commit (PHASE-03/EN-3).** The heartbeat
  catch and the thread_start mapping rely on `UnknownModel` leaving
  `createConversation` with its class intact, as `Refusal` already does
  through `api.commit`. The first red test confirms it.
- **PHASE-07/EX-2 is a gap.** It held the chooser's line parsing, moved to
  PHASE-05/EX-6 so no commit breaks the chooser. Ids are immutable, so EX-2 is
  not reused.
