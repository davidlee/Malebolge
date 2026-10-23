# Implementation Plan SL-001: Improve Malebolge's Emacs session interaction

Prose companion to `plan.toml`. Narrative only — no queried data lives here
(the storage rule); the phase list, criteria, verification, and links are
authored in the TOML. Use this for the plan's rationale and sequencing.
<!-- Reference forms: `lib:reference/glossary.md` § reference forms. -->

## Overview

Five phases, built inside-out along the data path of the design's sequence
diagram: renderer → attach client → Emacs draft/guard → Emacs follow/reattach →
end-to-end smoke.

```
PHASE-01 render.ts ──▶ PHASE-02 attach.ts/attach-main.ts ──▶ PHASE-03 malebolge.el draft
                                                               │
                                     PHASE-05 smoke + docs ◀── PHASE-04 follow + reattach
```

## Sequencing & Rationale

- The renderer is pure and has the most edge cases (lazy headings,
  separators, continuation cues), so it lands first under unit tests.
- The attach client depends on the renderer's presentation option and
  client-local notice event (RV-002 F-3, F-7), so it follows.
- Emacs work needs a working `--emacs` frame consumer. Draft/guard and
  follow/reattach are split because window behaviour is the riskiest part of
  the Emacs code and deserves its own green checkpoint.
- The smoke test needs every layer; it closes the slice's required gate.

## Notes

- ERT and the smoke need an `emacs` binary, so they run from a separate just
  recipe rather than `just check` (keeps `check` runnable without Emacs;
  cf. IMP-001).
- `src/protocol.ts` is expected to stay unchanged; a phase that needs to touch
  it must stop and consult.
