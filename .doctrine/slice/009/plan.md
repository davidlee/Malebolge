# Implementation Plan SL-009: Session bridge: a jailed pi session and a malebolge conversation exchange messages

Prose companion to `plan.toml`. Narrative only — no queried data lives here
(the storage rule); the phase list, criteria, verification, and links are
authored in the TOML. Use this for the plan's rationale and sequencing.
<!-- Reference forms: `lib:reference/glossary.md` § reference forms. -->

## Overview

Ten phases: premises first, then daemon-side extractions on SL-010's seam,
then the bridge built outward from the wire: mode and reach, pairing, the two
message directions, the pi side as a pure table and then its shell, and last
the docs and a real-jail exchange.

## Sequencing & Rationale

```
PHASE-01 probes (real pi, jail) ──► PHASE-02 extractions (needs SL-010 on main)
                                       │
                                       ▼
                                    PHASE-03 pi-bridge/ gate + wire + path rule
                                       │
             ┌─────────────────────────┼──────────────────────────┐
             ▼                         ▼                          ▼
   PHASE-04 bridge mode, reach   PHASE-05 pairing + listener  PHASE-08 state.ts step
             └──────────┬──────────────┘                          │ (only needs wire)
                        ▼                                          │
              PHASE-06 SATAN → pi ──► PHASE-07 pi → SATAN          │
                        └───────────────┬──────────────────────────┘
                                        ▼
                             PHASE-09 extension shell + malebolge-bridge
                                        ▼
                             PHASE-10 docs + real-jail VH
```

- **Probes first.** The pi side rests on five assumptions (ASM-004..008) and
  on pi event ordering that RV-021 routed to probes (F-1, F-6, F-9; F-10
  needs the real extension, so its probe lands in PHASE-10). A failed premise
  reshapes sec-7 of the design; finding that after PHASE-08 would waste its
  table. PHASE-01 writes no product code and does not wait on SL-010.
- **SL-010 before PHASE-02.** `pair` creates through `topicInit` (DEC-092),
  and `answer` moves with SL-010's `ModelsMessage`. PHASE-02 re-greps those
  names before it starts.
- **Extractions apart from behaviour.** PHASE-02 moves code with tests
  unchanged, so later diffs show only bridge behaviour.
- **Wire before both sides.** `pi-bridge/wire.ts` is the one place the frames
  are defined (DEC-073); the daemon and the extension both import it.
- **Pairing before messages.** Every message names a pairing; PHASE-05 also
  builds the fake-pi fixture the later daemon phases share.
- **SATAN → pi before pi → SATAN.** The withdrawal notice (PHASE-07) is an
  outbox note, so it needs PHASE-06's outbox and push.
- **Pure table before shell.** `step` is the design's table; testing it
  alone makes every RV-021 extension finding (F-5, F-9..F-13) a table row.
  It needs only the wire, so it may run beside PHASE-04..07.
- **Real jail last.** PHASE-10's VH needs the deployment contract. CHR-007 is
  another session's; until it lands the operator mounts by hand.

## Notes

- RV-021's routed findings are carried as criteria citing `RV-021 F-n`:
  probe F-1 (PHASE-01 EX-5, PHASE-08 EX-2, PHASE-10 VA-1), F-6 (PHASE-01 EX-4,
  PHASE-09 EX-4, PHASE-10 VH-2), F-9 (PHASE-01 EX-6, PHASE-08 EX-2), F-10
  (PHASE-08 EX-3, PHASE-10 VA-1); demonstrate F-2, F-4 (PHASE-07), F-3
  (PHASE-09), F-5, F-11, F-12, F-13 (PHASE-08).
- PHASE-07 carries inbound, idempotence, the withdrawal notice and the
  budget. If `/phase-plan` finds it oversized, the budget and refill move to
  an appended phase (ids append; PHASE-07 keeps its id).
- PHASE-01 EX-10 is a premise the design left implicit: `malebolge-bridge`
  imports `pi-bridge/wire.ts` and so needs node's type stripping in the jail.
- Posture texts ship as placeholders (DEC-040); tests pin which text renders,
  not its wording.
- SL-008's `src/untrusted-block.ts` has landed, so PHASE-07 uses its wrapper
  where the `<bridge>` envelope fits it (design sec-4).
