# Implementation Plan SL-008: Bookmark read tools: SATAN finds and relates Firefox bookmarks

Prose companion to `plan.toml`. Narrative only — no queried data lives here
(the storage rule); the phase list, criteria, verification, and links are
authored in the TOML. Use this for the plan's rationale and sequencing.
<!-- Reference forms: `lib:reference/glossary.md` § reference forms. -->

## Overview

Seven phases, bottom-up along the design's data flow (design sec-1 diagram):
shared primitives, then codec, then pure projection, then I/O, then rendering,
then tools, then wiring. Each phase lands a tested, unwired layer, so nothing
reaches a conversation until PHASE-07 adds `"bookmarks"` to the catalog.

```
PHASE-01 shared untrusted-block + ranges (mail re-imports)   ← SL-007 overlap
   │
PHASE-02 mozlz4 decoder (pure)
   │
PHASE-03 schema + projection (pure)
   │
PHASE-04 backupSource: file choice, caps, errors  ── VA: live backup counts
   │
PHASE-05 render: fill, header, cutCount           ── RV-019 F-12 probe
   │
PHASE-06 three tools + extension + section
   │
PHASE-07 config, daemon wiring, catalog, docs     ── VH after rollout
```

## Sequencing & Rationale

- **PHASE-01 first and alone.** It is the only phase that edits existing
  behaviour (mail) and the only one SL-007 overlaps (DEC-054: whichever slice
  executes second rebases). Landing it as a pure refactor with mail's
  assertions untouched keeps that rebase mechanical. Mail tests change only
  in imports and the two renamed identifiers; `fitMailboxes`' cases move to
  the shared module's suite as `fitWhole` cases. The bookmarks→mail structure
  rule lands here too: it is what stops later phases copying primitives back
  into `src/bookmarks/` (RV-019 F-1).
- **Decoder before everything that reads a file.** It is the riskiest unit
  (hand-written LZ4) and has no dependencies; testing it directly against a
  real fixture and an independent decoder's output honours
  `injected-seam-needs-real-test`.
- **Projection before source.** Schema and projection are pure and carry most
  of the semantic rules (folders, caps, tags); the source phase then only adds
  file choice, size caps and error mapping.
- **VA on the live backup at PHASE-04.** The earliest point the real path
  exists end to end; it settles the recipe-level unknowns RV-019's notes left
  to the plan (decoder correctness on the real ~500-bookmark backup, Firefox's guid
  form) before rendering and tools build on them.
- **RV-019 F-12 at PHASE-05.** Its placement constraint needs the real source
  and the renderer together; PHASE-05 is the first phase with both. PHASE-04
  tests the oversized-guid half alone; PHASE-05 asserts the conjunction.
- **Tools and extension together.** The extension is a thin registration of
  the tools plus the section; splitting it out would make a phase with no
  behaviour of its own.
- **Wiring last.** Only PHASE-07 touches shared daemon files
  (`src/toolsets.ts`, `src/daemon-start.ts`, the baseline tests), which the
  other session also works near; deferring it shortens the window of
  overlap.

## Notes

Choices the plan makes where the design is silent (record any revision in
`notes.md`):

- **Declared-size refusal.** Design sec-2 caps the declared size at
  `BACKUP_JSON_MAX_BYTES` without naming its reason. The plan maps it to
  `too_large` (a size limit, as for the file cap), not `corrupt`.
- **Decoder error.** `decodeMozLz4` throws a decoder-local error (kinds
  `corrupt`, `too_large`) so the codec does not depend on the bookmark port;
  `backupSource` maps it to `BookmarkSourceError`.
- **Independent decoder.** No LZ4 tool is installed; the expected output is
  produced once (e.g. `nix shell nixpkgs#python3Packages.lz4`) and committed
  with its provenance in `test/bookmarks/fixtures/SOURCE.md`.
- **Gate.** The suite was fully green at plan time (96 files, 3351 tests), so
  "`just check` green" means no reds at all, not design sec-7's "known
  room-only failures" allowance.
- **Follow-ups at reconcile** are design sec-8's list (DEC-029 amend,
  RSK-002 controls, SL-005 note, IMP-023 note, new ASM); CHR-006 carries the
  operator rollout VH-1 depends on.
