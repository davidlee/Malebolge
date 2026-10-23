# Notes SL-001: Improve Malebolge's Emacs session interaction

Durable per-slice scratchpad — tracked in git. The place to lift anything from a
disposable phase sheet (`.doctrine/state/.../phase-NN.md`) that must survive
`rm -rf` before the slice close-out audit harvests it.

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-23 · plan · 1d3b7bb

### Produced
- SL-001 — scoped research and six-section design recorded; design locked at revision 44, with authored work uncommitted.
- RV-003 — final design pass concluded with no new findings; RV-002's seven findings were resolved in the design.
- SL-001 — phase planning is next; no implementation or tests were run, and `doctrine check gate` was not run.

### Learned
- SL-001 — the Emacs composition boundary and attach-client framing are documented in the research and locked design.

### Open
- DEC-001–DEC-005 — locked interaction and protocol choices govern the forthcoming plan.

## Further review after RV-003

If another review pass is useful during implementation, probe the actual Emacs
process boundary: whether the read-only transcript and refusing comint sender
block every non-draft write, whether per-window follow survives streamed chunks,
and whether client-local notices preserve the assistant continuation cue. The
RV-002 closed seven findings and the read-only RV-003 pass found no new design
issue. The remaining checks need implementation behavior and are named in the
design's verification section.
