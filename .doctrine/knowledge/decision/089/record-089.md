# DEC-089: Emacs: one bounded listing call; new asks for a topic; malebolge-set-topic-model sets or clears a topic's model

<!-- Knowledge record body — context, detail, links. The structured, queried
     fields live in the sister `record-NNN.toml`; this prose is free-form and is
     never structurally parsed (the storage rule). -->


Refined 2026-10-29 by DEC-091 (SL-010 review round 1, operator assent to OQ-2: "recommended on all"): the one bounded call takes any client argv, so the --set-topic model write is bounded too; a write timeout reports an unknown outcome and does not retry.
