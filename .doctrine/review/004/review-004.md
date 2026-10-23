# Review RV-004 — reconciliation of SL-001

Adversarial-review ledger. Structured findings live in the sister
ledger toml; this prose companion carries the reviewer's framing.

## Brief

<!-- Pre-reading + lines of attack: what this review is probing, the invariants
     it must hold the subject to, and where the bodies are likely buried. Seeded
     at `review new`; the reviewer fills it before raising findings. -->

Conformance audit of SL-001 on the primary tree (`main`, 4ef3751..6c8ca60;
no dispatch, no candidate branch). Lines of attack:

- Delivered behaviour vs design sec-1..sec-6 as amended by DEC-006; the
  scope summary's done-definition (one input per draft, role cues without
  colour, separated answers, labelled notices, conditional follow).
- `slice conformance` cells (undeclared / undelivered).
- Gates: `just check`, `just ert`, `just smoke`, `slice verify-vt`,
  `doctrine check gate`.
- Test fidelity: do the fakes model the real daemon's event order?
- Phase-review residue (per-phase reviews by the reviewer seat; fixes landed
  before this pass) and the orchestrator's carried items.

## Synthesis

SL-001 delivers the scoped Emacs session:
- A companion draft buffer submits a multi-line message as one JSON stdin frame.
- `malebolge-attach --emacs` turns that frame into exactly one daemon `input`; the protocol is unchanged.
- A presentation profile renders role headings, separated answers and labelled notices in plain text.
- A read-only transcript refuses input, EOF and signal keys.
- Output following uses comint's native rule (DEC-006), and reattach clears the old transcript before restarting.

Evidence: `just check` passes 1813 tests with 98% line coverage. `just ert` and
the byte-compile are clean. `just smoke` passed 5 of 5 runs after F-3.
`slice verify-vt` passes every VT. Conformance shows no undelivered selectors
and 8 conformant paths. The per-phase reviews raised and closed 17 defects
before this pass, one of them major (C-c C-c in the transcript sent and erased
the transcript).

Code behaviour holds; the residue is canon drift and test fidelity:
- **Design drift:** design sec-5 (F-1) and sec-4 (F-2) lag DEC-006 and the
  daemon's queued-input order.
- **Smoke fidelity:** the smoke had pinned an unrealistic mid-answer echo
  (F-3, fixed here).
- **Selectors:** README.md and justfile were edited without selectors (F-4).

Standing risks:
- **Real-daemon behaviour is untested end to end.** The queued-input order
  rests on pi-durable's API documentation and is unverified against a live
  daemon. The VH-1 manual try is the remaining check.
- **Batch window tests are limited.** They observe only markers, so visual
  scrolling is not covered.

Accepted tradeoffs:
- **Terminal edge case (F-5):** end-only trailing newlines are dropped in the
  terminal presentation.
- **Following (DEC-006):** a window that shows the end but has point elsewhere
  does not follow.

Follow-ups: IMP-003, IDE-001, CHR-001.

## Reconciliation Brief

### Per-slice (direct edit)
- design.md sec-5 (RV-004 F-1): replace the pre/post-hook model with DEC-006.
  Set `comint-scroll-to-bottom-on-output` nil locally. A transcript window
  follows when its point is at the process mark, and keeps its window-start
  and point otherwise. M-> resumes following. Output never selects a window.
  Keep the reattach paragraph. In the sec-6 table, replace "buffer-local
  conditional follow hooks" in the emacs/malebolge.el row. Cite DEC-006.
  Plan PHASE-04 EX-1 is not edited (immutable); it is satisfied as amended by
  DEC-006.
- design.md sec-4 (RV-004 F-2): add that the daemon queues input to a busy
  conversation (pi-durable `pi.inbox`), so a live user turn normally renders
  after the answer completes. A user turn that does arrive mid-answer is
  rendered like a notice: it starts on a fresh line, and the later answer
  text resumes under `Satan (continued):`.
- Selector registry (RV-004 F-4): `doctrine slice selector add` README.md and
  justfile with intent design-target. This is the load-bearing change. Mirror
  it in the sec-6 table: README.md gets the Emacs session section, and
  justfile gets the `ert` and `smoke` recipes.

### Governance/spec (REV)
- None. SL-001 has no linked specs, ADRs or requirements.

## Reconciliation Outcome

### Direct edits applied
- design.md sec-5 (F-1): pre/post output hooks replaced by DEC-006 — local
  `comint-scroll-to-bottom-on-output` nil, comint's native point-at-mark
  follow, `M->` resumes; the accepted edge case is stated. Reattach paragraph
  kept. sec-6 `emacs/malebolge.el` row amended; the sec-6 ERT window-test
  sentence restated to the same model (same F-1 scope, user-agreed).
  Plan PHASE-04 EX-1 untouched (immutable); satisfied as amended by DEC-006.
- design.md sec-4 (F-2): queued-input boundary order (EVD-001) and the
  mid-answer user-turn cut-in under `Satan (continued):`.
- Selector registry (F-4): `README.md`, `justfile` added as design-target;
  `doctrine slice conformance SL-001` reads 10 conformant, 0 undelivered.
  sec-6 table gains the `README.md` and `justfile` rows.

The design run is locked; per the CLI's refusal ("at reconcile, edit
design.md directly and do not adopt") the edits were made directly, with no
`design adopt`.

### REVs completed
- None. The brief had no governance/spec items.

Reconcile pass complete — handoff to /close.
