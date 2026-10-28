# DEC-015: A topic's latest conversation is its highest id; `default` is reserved and holds root first

<!-- Knowledge record body — context, detail, links. The structured, queried
     fields live in the sister `record-NNN.toml`; this prose is free-form and is
     never structurally parsed (the storage rule). -->

Refined 2026-10-29 by DEC-037 (SL-006, operator assent): latest is the highest id among entries no tool created; forks (parent) and started threads (startedBy) are skipped. The default-topic and root rules here stand.