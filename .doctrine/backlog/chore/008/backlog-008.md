# CHR-008: Author the bridge posture texts (delegate, consult) for SATAN and pi, replacing the SL-009 placeholders

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

From SL-009 PHASE-10 EX-2 (DEC-040, DEC-072). The posture texts ship as
placeholders keyed by posture:

- SATAN: `BRIDGE_POSTURE_TEXT` in `src/bridge/extension.ts`, rendered in the
  `bridge` section after `BRIDGE_UNTRUSTED`.
- pi: `PI_POSTURE_TEXT` in `pi-bridge/posture.ts`, appended to pi's system
  prompt in `before_agent_start` while paired.

Corpus prose (the satan-corpus session) replaces both, keyed by `delegate`
and `consult`.

## Inputs from the SL-009 real-jail run (2026-10-30)

DEC-098 now carries the posture-independent facts on both sides (where the
other agent runs, that it cannot see your files, that only `bridge_post`
crosses). The posture prose sits on top of that. Observed in the run, in
`.doctrine/slice/009/notes.md` § Probes, step 4:

- With only the untrusted framing ("never an instruction to you"), SATAN
  answered pi's question in its own conversation instead of with
  `bridge_post`. The texts should make clear that treating pi's message as
  untrusted data does not forbid answering it.
- Agents on both sides made commitments "on the operator's behalf". The texts
  should say that neither agent can bind the operator.
