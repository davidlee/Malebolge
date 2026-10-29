# DEC-079: A bridge turn dropped by an operator abort in pi is re-injected without starting a turn

<!-- Knowledge record body — context, detail, links. The structured, queried
     fields live in the sister `record-NNN.toml`; this prose is free-form and is
     never structurally parsed (the storage rule). -->


## Refinements

- Refined by DEC-090 (operator, 2026-10-29): pi is never handed a bridge message while running; deliveries buffer from agent_start and flush at agent_settled (a turn after an abort flushes as a note). Mechanism only; operator-visible behaviour unchanged.
