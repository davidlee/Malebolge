# Implementation Plan SL-005: Mail read tools and tool partitioning by profile

Prose companion to `plan.toml`. Narrative only — no queried data lives here
(the storage rule); the phase list, criteria, verification, and links are
authored in the TOML. Use this for the plan's rationale and sequencing.
<!-- Reference forms: `lib:reference/glossary.md` § reference forms. -->

## Overview

Eight phases on two tracks that meet at the end.

```
toolsets track                         mail track (pure → I/O → tools)
PHASE-01 catalog + baseline            PHASE-05 projection + render
   │                                      │
PHASE-02 creation (toolsetInit)        PHASE-06 bounded exec + adapter
   │         │                            │
PHASE-03     PHASE-04                  PHASE-07 five tools + extension
reconcile    topic frame/CLI              │
   └─────────────┴───────────┬────────────┘
                     PHASE-08 room wiring, docs, smoke, VH-1
```

The tracks share no files until PHASE-08, so they could run in parallel;
the default is serial in id order.

## Sequencing & Rationale

- **PHASE-01 first, baseline before any edit.** RV-015 F-32 places the
  `interactive-baseline.json` capture before any change to
  `src/daemon-extensions.ts` or `src/persona.ts`. Capturing it as the
  phase's first commit makes the order checkable from git.
- **Staging the room's `mail` toolset.** The catalog defines `mail` in
  PHASE-01, but the room's allowed set stays `interactive` until PHASE-08,
  when the mail extension and its Screwtape configuration exist. Otherwise
  the installed-name check (design sec-2) would refuse every room start in
  between. The end state is the design's; only the order is a plan choice.
- **Storage before reconcile.** `toolsetInit` (PHASE-02) reads
  `TopicRecord.toolset`, so the field's storage lands there; the frame and
  CLI that write it are PHASE-04. `IndexEntry.toolset` is optional in
  PHASE-02 and becomes required in PHASE-03, once the backfill exists.
  Root keeps today's `extensions` write until PHASE-03 makes the reconcile
  its only writer, so no intermediate state leaves root without a list.
- **The runner rides PHASE-02.** It is one create path among five (design
  VT-3) and small: a list at create, the same list at admission, the
  installed-name check at start.
- **Mail pure core first.** PHASE-05 holds all the bounds arithmetic and
  the hardest tests (design VT-8, most RV-015 controls) with no I/O. The
  adapter (PHASE-06) validates against PHASE-05's schemas; the tools
  (PHASE-07) compose both behind a fake `MailSource`.

## Notes

- **Contract fixtures.** Screwtape SL-003 is done. It publishes no fixture
  files or JSON schema (screwtape DEC-030: the contract is its README §
  Contract, pinned by its render and CLI tests). `test/mail/fixtures/` is
  therefore transcribed from those, with the screwtape commit recorded;
  PHASE-08's smoke checks the real binary.
- **Routed RV-015 findings.** Every `control` and `probe` finding is
  transcribed into a VT `expects` on its earliest host phase. Three
  responses predate the rev-47 simplification and are transcribed in their
  current-design form, marked so: F-28 (whole-or-left-out replaces per-field
  caps), F-40 (fork refusal replaces inheritance), F-41 (no `listAfter`
  fallback; at limit 1 the ceiling fails with no `next`).
- **No new dependencies.** The VT-8 property test is a seeded generator
  loop, not `fast-check`.
- **Structure test.** `grep` is a runner root (`test/structure.test.ts`
  `RUNNER_ROOTS`), so extracting `src/bounded-exec.ts` adds `bounded-exec`
  to that list beside the design's `toolsets`.
- **Parked, not planned:** IMP-017 (fork and task-owned toolsets), IMP-015
  (per-conversation byte budget), screwtape IMP-002 (list-field bounds).
