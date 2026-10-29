# Notes SL-010: Per-topic model, and topics in the Emacs attach chooser

Durable per-slice scratchpad — tracked in git. The place to lift anything from a
disposable phase sheet (`.doctrine/state/.../phase-NN.md`) that must survive
`rm -rf` before the slice close-out audit harvests it.

## Review passes (design, 2026-10-29)

Round 1 was informal, with findings outside the RV-022 ledger (it holds none):
a pi first pass, a GPT pass (gpt-6.1-sol), a pi pass over SL-009 overlap, and
a pi verify pass over the revisions. All accepted findings are integrated in
design.md; the SL-009 share is ISS-004.

No further review pass is needed before lock. What one would probe, if
wanted, is left to phase-plan as checks against code, not design questions:
- that the empty wake topic's heartbeat create reaches `topicInit` through
  `conversations.open`, so `UnknownModel` is what `startRoomTasks` sees;
- that `summaries` reads (up to 50 agent documents per page, one commit) stay
  cheap on a full page;
- pi-ai's chat-model enumeration name for `refs`.

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-29 · ready (PHASE-01..07 planned, none started) · cf7049a

### Produced
- SL-010 scoped (slice-010.md, scope re-confirmed at review.scope); research round 1 (research/)
- design run dr-01a18627 locked rev 38 (eddc7d9); informal review: 4 passes, see "Review passes" above; RV-022 waived (no findings)
- minted: DEC-082..DEC-089, DEC-091 (refines DEC-089); DEC-083 + DEC-089 body notes; ISS-004 (SL-009 follow-ups; SL-010 lands first)
- plan.toml + plan.md, 7 phases (cf7049a); phase sheets materialised; status ready
- no code changed; gate not run (nothing to gate)

### Learned
- mem.fact.malebolge.model-ref-provider-is-gateway
- mem.fact.malebolge.root-indexed-in-default

### Open
- DEC-034, DEC-039, DEC-016, DEC-017 — amended by DEC-084/087/086; record at /reconcile
- PHASE-03/EX-8 — thread_start maps UnknownModel to a refusal (DEC-083 on the tool path; arbiter ruling, not in design)
- PHASE-05/EN-2 — summaries cost on a 50-id page, measure before the phase
- ISS-004 — SL-009 (other session) absorbing; DEC-092/093 there call SL-010's topicInit
- IMP-018 — absorbed by SL-010; close with the slice
- research advisory reports drift (scope/design edited since research); not restamped
