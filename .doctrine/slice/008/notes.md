# Notes SL-008: Bookmark read tools: SATAN finds and relates Firefox bookmarks

Durable per-slice scratchpad — tracked in git. The place to lift anything from a
disposable phase sheet (`.doctrine/state/.../phase-NN.md`) that must survive
`rm -rf` before the slice close-out audit harvests it.

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-29 · ready (plan approved by operator: "ah. approve.") · 1384894

### Produced
- Slice scoped, researched (`research/research.md`, round 1), design run
  dr-01a18592… locked (rev 40) after RV-019; `design.md` materialised (8 sections).
- Plan: `plan.toml` / `plan.md`, 7 phases; operator approved it with the
  planner's settled choices (plan.md), 2026-10-29.
- minted: DEC-052 — read the daily jsonlz4 backup; DEC-053 — RSK-002 carve-out
  with field caps; DEC-054 — shared `src/untrusted-block.ts`; DEC-055 — optional
  env, explicit refusal; CHR-006 — operator rollout (env + jail bind); IDE-008,
  IMP-023 — originating backlog items.
- No code yet.

### Learned
- mem.fact.malebolge.firefox-bookmark-data — where tags live, locked DB, backup format.

### Further review
RV-019 concluded (pi + GPT passes, 21 findings answered, operator settled
Q1–Q3). No further design pass needed: the findings narrowed to wording and
module placement, and what remains is recipe-level — the LZ4 decoder's exact
behaviour and Firefox's guid form — which the plan's red/green tests and the
VA check on the live backup settle faster than another review. The next
review belongs to the plan.

### Open
- RV-019 — concluded; design locked on the operator's sign-off.
- Next: `/phase-plan` PHASE-01 (shared-module move; SL-007 overlap — second to
  execute rebases).
- SL-007 overlap on `src/mail/render.ts` (DEC-054) — second to execute rebases.
- New ASM (bookmark dir from configured path, jail-bound) and DEC-029 / RSK-002 /
  SL-005 / IMP-023 notes — due at reconcile (design sec-8).
