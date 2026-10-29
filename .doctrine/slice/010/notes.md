# Notes SL-010: Per-topic model, and topics in the Emacs attach chooser

Durable per-slice scratchpad — tracked in git. The place to lift anything from a
disposable phase sheet (`.doctrine/state/.../phase-NN.md`) that must survive
`rm -rf` before the slice close-out audit harvests it.

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-29 · design:reviewing · 0043565

### Produced
- SL-010 scoped (slice-010.md); research round 1 (research/research.md, raw/governance.md, raw/code-map.md)
- design run dr-01a18627 at reviewing rev 20; design.md materialised (8 sections); review pass RV-022
- minted: DEC-082..DEC-089 (shape SL-010); DEC-015 adopted for inq-9; links: SL-010 related IMP-018, references(concerns) DEC-025
- all SL-010 `.doctrine/` changes uncommitted (commit only on the user's ask); worktree also holds other sessions' dirty SL-007/SL-009 records, so stage SL-010 paths only
- no code changed; gate not applicable yet

### Learned
- mem.fact.malebolge.model-ref-provider-is-gateway — refs are gateway/<id>, not the catalog's provider key

### Open
- DEC-082 — refined in design §2 to a two-method ModelCatalog port; body appended, awaits sec-2 review
- DEC-034, DEC-039, DEC-016, DEC-017 — amended by DEC-084/087/086; record the amendments at /reconcile
- phase-plan checks: pi-ai chat-model enumeration name (getModelsOfType("chat")); root's empty topic on a --list line (DEC-021) vs showing `default`
- IMP-018 — absorbed by SL-010; close with the slice
