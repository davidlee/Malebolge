# IMP-028: mail_new at its defaults now reports a max_bytes clamp (joint clamp minus JEV_MAX_BYTES is below the 4096 default)

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

Found in SL-007 PHASE-05. SL-007 design § Rendering makes mail_new's joint clamp
`min(asked, floor(NEW_JOINT_BYTES / limit) - JEV_MAX_BYTES)`. At the defaults
(limit 10, max_bytes 4096) that is below 4096, so every default call's header
now says `max_bytes clamped to …`. Before SL-007 the defaults were exactly at the
bound and reported nothing (a test, "reports nothing for mail_new at the defaults",
held that; PHASE-05 moved it to limit 10 at the joint bound).

Behaviour is correct and within bounds; it is header noise the agent may read as
its own mistake. Option: derive `NEW_MAX_BYTES.default` from the joint bound at
`NEW_LIMIT.default`, or not report a clamp of a default value. Either changes a
bound/reporting rule, so it needs the operator.
