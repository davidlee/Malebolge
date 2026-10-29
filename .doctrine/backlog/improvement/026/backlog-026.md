# IMP-026: Rough edges from the SL-010 topic-model hand-run

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

Found during SL-010 PHASE-07 VH-1 (2026-10-29); the operator's verdict: "no
failure message, no topic shown, etc". One item, three in-repo edges (ISS-005
folded in as a duplicate).

1. **A failing model turn is silent.** Conversation 2711 on
   `gateway/openai-david/gpt-6.1-terra`: the gateway answered 429 ("no credits
   remaining"); `chatgpt/gpt-6.1-terra` answered 400 ("no healthy
   deployments") before sign-in. Both times the operator saw only their own
   prompt: no `[status]` error, nothing in the `malebolge-room` journal.
   Unverified inference: pi-ai treats 429 as retryable and backs off quietly.
   Expected: a model error (or a long retry) surfaces in the transcript and the
   log. Predates SL-010.
2. **Connect status names only the id.** After `new` in a topic,
   `[status] Connected …` gives the conversation id, not its topic or model.
   The list reply already carries per-id `{topic, model}` (SL-010 PHASE-05).
3. **`Topic:` defaults to `default` on a bare RET** (`malebolge--new-target`,
   SL-010 PHASE-07). The operator's first attempt landed in 2672/default
   unnoticed — compounded by 2.

Outside this repo, noted only: the operator's `dl-satan.el` `:commands`
autoloads only attach/start/stop (so `malebolge-set-topic-model` is undefined
until the package loads, and a running Emacs keeps stale elisp); the daemon's
catalog (`~/flakes/features/satan/runner.nix`) goes stale until a
home-manager switch.
