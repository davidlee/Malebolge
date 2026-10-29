# ISS-005: A failing model turn is silent: no transcript error, no daemon log

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

Found during SL-010 PHASE-07 VH-1 (2026-10-29). Conversation 2711 on
`gateway/openai-david/gpt-6.1-terra`: the gateway answered 429 ("no credits
remaining"); separately `chatgpt/gpt-6.1-terra` answered 400 ("no healthy
deployments") before sign-in. In both cases the operator saw only their own
prompt in the transcript: no `[status]` error, nothing in the
`malebolge-room` journal.

Unverified inference: pi-ai treats 429 as retryable and backs off quietly, so
the turn may sit waiting rather than fail. Expected: a model error (or a
long retry) surfaces in the transcript and the log. Predates SL-010.
