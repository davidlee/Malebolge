# IDE-010: End a bridge pairing from the attach side (Emacs) when pi is gone

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

From SL-011 (inq-8). Once pi pairs with the operator's working conversation
(DEC-099), a pairing outlives the pi session: `bridge_post` queues to the
outbox cap (32) and then refuses `outbox full, pi is not draining`. Today only
pi can send `end`, or a new pair replaces the pairing (DEC-103). An attach-side
verb (e.g. `M-x malebolge-bridge-end`) would let the operator end it from Emacs.
