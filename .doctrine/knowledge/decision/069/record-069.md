# DEC-069: Every bridge message starts a turn on the receiving side, except a note, which waits for the next one

<!-- Knowledge record body — context, detail, links. The structured, queried
     fields live in the sister `record-NNN.toml`; this prose is free-form and is
     never structurally parsed (the storage rule). -->


## Refinements

- Refined by DEC-079 (operator, 2026-10-29): one exception to "turn = triggerTurn true". A bridge turn that pi's abort dropped before it persisted is re-injected with triggerTurn false and joins the operator's next turn. Notes are unaffected.


## Refinements

- Refined by DEC-090 (operator, 2026-10-29): pi is never handed a bridge message while running; deliveries buffer from agent_start and flush at agent_settled (a turn after an abort flushes as a note). Mechanism only; operator-visible behaviour unchanged.
