# ISS-002: Attach snapshot omits tool calls: [tool] lines appear only live, never on resume

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

Observed 2026-10-29 during SL-006 VH-1: resuming an old conversation shows its
`[thread]` input lines but none of its tool calls.

Cause: `transcriptLine` (src/render.ts) renders a snapshot entry as user text,
assistant text, a post/wake input, or a compaction notice. An assistant
message's `toolCall` parts are dropped; `[tool] name {args}` lines come only
from the live event path (`tool: (text) => line(`[tool] ...`)`). Present since
SL-001 (4ef3751); not an SL-006 regression.

Fix sketch: render an assistant entry's tool calls in the snapshot the way the
live path does (`[tool] <name> <toolArgs(args)>`), shared by both paths.
