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

## Second failure mode: the identifier is reached, not written (SL-003, 2026-10-24)

RV-011 F-5: four VT FAILs over behaviour that was tested. The test files reached
the mandated identifier only indirectly: `Harness.open` through the
`openFauxHarness` fixture; `checkAlone` through the flags it guards;
`TopicMessage` as a TS type the parse table never names; and
`topic must match` through a shared constant (`NAME_RULE`) in
`test/harness-fixture.ts`. The match is a literal substring of the
`test_file` alone. Helpers, imports and types do not count.

- At planning time, choose keywords that the test *text* will contain: a
  test title or a literal it asserts. Do not pick the symbols it exercises.
- Repair after the fact by putting the identifier in the test title, which
  is honest when the test does exercise it. Plan criteria are immutable.
