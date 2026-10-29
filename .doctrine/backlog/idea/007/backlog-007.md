# IDE-007: Mail-local memory of operator signals: decisions, corrections, importance, feedback on assessments

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

Operator direction, 2026-10-29.

## Intent

The mail agent keeps a local memory of what the operator signals: decisions
on proposed actions (IDE-005), corrections to its assessments and to Jev's
classifications (IMP-022), and what the operator has deemed important. It
reads that memory to improve later assessments.

## Constraints

- "Local": scoped to the mail quarantine (RSK-002 Q1/Q2). It is not SATAN's
  memory, and SATAN does not read it.
- Signals are written by the operator's acts, not by the agent's own
  judgement, so the store's content is operator-sourced even though it lives
  inside the quarantine. Keep that provenance explicit per record.
- Overlaps screwtape IMP-003 (evaluating Jev's dimensions on real mail):
  corrections to classifications are evidence for that evaluation.

## Open

- Storage, schema, and how signals are captured from the review surface.
- Whether corrections feed back to Jev, or only to the mail agent's prompt.
