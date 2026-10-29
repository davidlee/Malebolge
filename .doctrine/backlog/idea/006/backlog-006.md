# IDE-006: Mail digests held in quarantine, reachable by other agents only through a lexical search

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

Operator direction, 2026-10-29. One of the mail agent's outputs.

## Intent

A mail conversation writes digests of mail. Other agents (SATAN's ordinary
contexts) can find something worth recommending to the operator, without
reading quarantined text in bulk.

## Constraints (from RSK-002)

- A digest is a Q2 derivative: quarantined until the operator reads it and
  promotes or disposes of it. By default it sits outside every SATAN read
  tool.
- Accepted exception: a lexical search over quarantined digests returning a
  couple of lines per hit, so an agent can point the operator at it in time.
- Promotion is an operator act; a promoted digest becomes trusted material.

## Open

- Where digests live, and their retention.
- Digest granularity: per message, per thread, per period.
- Whether a classifier judges digests for infection before the lexical
  exception exposes them (RSK-002: "it is just a classifier").

Builds on IMP-022.

## Note from SL-007 (2026-10-29)

SL-007 classifies read-through only (DEC-058): a tool classifies the items it
returns. A digest wants background prefill instead: classify new arrivals
after a stored cursor, ahead of any tool call, into the same cache (DEC-057).
