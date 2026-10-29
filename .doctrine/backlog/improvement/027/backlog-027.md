# IMP-027: Daemon journal logs nothing when a model turn fails

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

Split from IMP-026 #1 (2026-10-29). A failed model turn now prints
`[model error: …]` in the transcript (commit 5540321), but the
`malebolge-room` journal still records nothing: the daemon has no observer
of conversation events, and pi-durable's `run_end` carries no failure — the
failure is the assistant entry's `stopReason: "error"` / `errorMessage`, and
the run's terminal outcome (`reason: "model_error"`) inside pi-durable's
`generation.js`.

Wanted: one journal line per failed turn naming the conversation, model and
error. Open: where to observe it — a harness hook, or a watcher per live
conversation.
