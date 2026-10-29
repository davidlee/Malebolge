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
