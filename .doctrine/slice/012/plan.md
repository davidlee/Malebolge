# Implementation Plan SL-012: Mail action plans: the mail agent proposes, the operator executes in Gnus

Prose companion to `plan.toml`. Narrative only — no queried data lives here
(the storage rule); the phase list, criteria, verification, and links are
authored in the TOML. Use this for the plan's rationale and sequencing.
<!-- Reference forms: `lib:reference/glossary.md` § reference forms. -->

## Overview

Eight phases: a live probe, three TypeScript phases inside-out (pure functions,
store and config, the tool), two elisp phases (no-Gnus, then Gnus), the
real-room integration with the operator's end-to-end check, and UI tuning.

```
PHASE-01 probe (VH) ─┬─► 02 plans.ts ─► 03 store+config ─► 04 mail_propose ─┐
                     │        │                                             ├─► 07 jail+docs+live (VH) ─► 08 tuning (VH)
                     │        └─► 05 elisp: reader/render/status ─► 06 Gnus ┘
                     └──────────────────────────────────────────────► 06
```

## Sequencing & Rationale

- **Probe first.** Two of its answers reach early code: the INBOX-child rule
  sits in `imapPathOf` (PHASE-02); the query form, mark capture and the move
  command's group check sit in PHASE-06. Running it first means no phase is
  written against an unconfirmed premise. A non-confirming answer changes the
  named function, not the phase boundaries.
- **TS inside-out.** PHASE-02 is pure and owns the shared text-rules fixture,
  which both suites read; the elisp cannot start its rules without it.
  PHASE-03 is the only I/O the daemon gains (one writer) plus the setting that
  gates it. PHASE-04 composes them and is the largest TS phase because it also
  threads `api` and withheld tracking through the existing read tools.
- **Elisp split at Gnus.** PHASE-05 is everything testable from fixture
  files: the reader, rules, renderer, status, dismiss. PHASE-06 is everything
  that needs Gnus stubbed. The split keeps the security-relevant rendering
  (untrusted text, link control) reviewable apart from Gnus plumbing.
  PHASE-05 depends only on PHASE-02, so it may run alongside 03–04.
- **Integration after both halves.** PHASE-07 touches two other repos
  (`~/dev/satan`, `~/flakes`) and needs the operator's go-ahead before those
  edits; the docs corrections ride with it because they describe the
  deployed shape. The live run is its exit.
- **Tuning last.** The design marks columns, keys and folding as phase-tuned:
  they are decided against real plans, after the first working version.

## Notes

- RV-030 (the design review) carries no ledgered findings, so no routed
  `demonstrate` / `probe` / `control` obligations were transcribed. Its
  residual questions are PHASE-01's probe rows.
- Records amended at reconcile (design sec-9: DEC-062, DEC-026, DEC-049,
  RSK-002, DEC-110, DEC-109) are reconcile work, not a phase.
- The persona sentence in `~/satan-corpus` is the operator's edit; PHASE-07
  only drafts it.
