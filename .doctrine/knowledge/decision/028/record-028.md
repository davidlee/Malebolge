# DEC-028: Screwtape client: configured absolute paths, shared bounded exec, fail-closed envelope validation

<!-- Knowledge record body — context, detail, links. The structured, queried
     fields live in the sister `record-NNN.toml`; this prose is free-form and is
     never structurally parsed (the storage rule). -->



Narrowed by DEC-051, DEC-059, DEC-081 (SL-007 lock): a stdin-capable spawner behind boundedExec's env seam; classify's own env {HOME, CREDENTIALS_DIRECTORY, ERL_CRASH_DUMP_SECONDS=0}, 30 s timeout and failure mapping.