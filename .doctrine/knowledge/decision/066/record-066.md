# DEC-066: SATAN's messages to pi wait in a durable outbox in the bridged conversation's own document, pushed and acked by sequence

<!-- Knowledge record body — context, detail, links. The structured, queried
     fields live in the sister `record-NNN.toml`; this prose is free-form and is
     never structurally parsed (the storage rule). -->

## Refinements

- Refined by DEC-080 (operator, 2026-10-29): outbox entries are {seq, kind, text} and deliver carries the kind (turn | note); the withdrawal notice is a note.
- Refined by DEC-079 (operator, 2026-10-29): the extension's handed set is pending state, not a receipt; a turn dropped by an operator abort in pi is re-injected without starting a turn.
- Refined by DEC-090 (operator, 2026-10-29): pi is never handed a bridge message while running; deliveries buffer from agent_start and flush at agent_settled (a turn after an abort flushes as a note). Mechanism only; operator-visible behaviour unchanged.
