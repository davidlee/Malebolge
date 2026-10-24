Observed SL-002 PHASE-04, 2026-10-24.

The plan's VT-2 mandates the keyword `already attached to conversation` in
`docs/internals.md`. The document stated exactly that message, wrapped:

    answers the *unprefixed* `already attached to
    conversation N`

`doctrine slice verify-vt 2` reported `✗ FAIL VT-2 — keyword 'already attached
to conversation' absent from docs/internals.md`. The fact was there; the
substring was not, because the phrase straddled a line break.

The failure arrives late: VT attribution needs the phase's conformance boundary
(`mem.fact.malebolge.verify-vt-needs-phase-close`), so it surfaces only after
`doctrine slice phase … --status completed`. It then reads like a missing fact
and invites the wrong repair — rewording the sentence, when the sentence was
right.

Consequences:

- Keep every VT keyword on one unbroken line. Wrap *around* it, not through it.
- A post-completion doc fix needs the boundary re-pointed:
  `git commit --amend` (or a fixup commit), then
  `doctrine slice record-delta <slice> <PHASE> --commit <S>` — the safe
  single-commit mode, not the raw `--start/--end` range.
- A keyword present is necessary and never sufficient: the gate cannot tell
  `conversation N` in a sentence from `conversation N` in a padded list, so the
  VA prose review stays the load-bearing check.
