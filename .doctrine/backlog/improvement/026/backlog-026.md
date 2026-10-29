# IMP-026: Transcript connect status names only the id, not the conversation's topic and model

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

Found during SL-010 PHASE-07 VH-1 (2026-10-29). After `new` in a topic, the
transcript's `[status] Connected …` line names the conversation id only, so
the operator cannot tell which topic and model they landed in without
re-opening the chooser or running `--list`. The list reply already carries
per-id summaries `{topic, model}` (SL-010 PHASE-05); the attach/connected
status could say the same.
