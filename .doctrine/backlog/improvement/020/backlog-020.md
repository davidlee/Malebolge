# IMP-020: Crash-safe call-keyed receipts for thread tools

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

SL-006's thread tools (`thread_start`, `thread_fork`, `thread_post`) keep
`replay: unsafe`. If the daemon crashes after the tool's creating commit but
before pi-durable records the tool result (`dist/harness/tool.js:99-122` vs
`:526-550`), the caller sees "interrupted and may have partially run" while
the child thread or post exists. A model retry then creates a second child or
a second post.

**Accepted as a residual for SL-006** (operator, 2026-10-29, SL-006 inq-14;
Sol review r1 F-3): the window is narrow, a child's first reply names it via
`from`, and `--list` marks threads.

**Improvement:** store a receipt keyed by the tool call in the creating
commit, and make the tools `replay: safe` so recovery returns the stored
`{conversation, topic}` / `{post, to}` instead of reporting an interruption.
Test both sides of the commit boundary.
