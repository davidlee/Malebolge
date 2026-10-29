# Notes SL-008: Bookmark read tools: SATAN finds and relates Firefox bookmarks

Durable per-slice scratchpad — tracked in git. The place to lift anything from a
disposable phase sheet (`.doctrine/state/.../phase-NN.md`) that must survive
`rm -rf` before the slice close-out audit harvests it.

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-29 · design reviewing (RV-019 open) · 4560aa2 + this session's commit

### Produced
- Slice scoped, researched (`research/research.md`, round 1), design run
  dr-01a18592… at stage reviewing; `design.md` materialised (8 sections).
- minted: DEC-052 — read the daily jsonlz4 backup; DEC-053 — RSK-002 carve-out
  with field caps; DEC-054 — shared `src/untrusted-block.ts`; DEC-055 — optional
  env, explicit refusal; CHR-006 — operator rollout (env + jail bind); IDE-008,
  IMP-023 — originating backlog items.
- No code yet.

### Learned
- mem.fact.malebolge.firefox-bookmark-data — where tags live, locked DB, backup format.

### Open
- RV-019 — design review pass; operator chose /arbiter-review with GPT.
- SL-007 overlap on `src/mail/render.ts` (DEC-054) — second to execute rebases.
- New ASM (bookmark dir from configured path, jail-bound) and DEC-029 / RSK-002 /
  SL-005 / IMP-023 notes — due at reconcile (design sec-8).
