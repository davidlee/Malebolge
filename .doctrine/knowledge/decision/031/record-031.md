# DEC-031: A thread fork starts at the caller's latest entry and carries a written result for its call

<!-- Knowledge record body — context, detail, links. The structured, queried
     fields live in the sister `record-NNN.toml`; this prose is free-form and is
     never structurally parsed (the storage rule). -->


## Premise outcome (SL-006 PHASE-07, 2026-10-29)
Premise (a) HOLDS on pi-durable 1.4.0, pinned by test/threads-fork.test.ts ("a fork's child sees the written fork result, not 'Tool result unavailable'"): a tool, in one api.commit (scanEntries descending 1, forkConversation at that entry, appendEntry(ToolResultEntry) to the child for api.callId), writes the child's result; the child's next model request carries it (isError false, text with fork_of) and no synthetic "Tool result unavailable"; the child's submit settles done. The written-result path is taken; the design fallback (fork_of post + note) is not needed.
