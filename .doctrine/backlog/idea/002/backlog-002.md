# IDE-002: Task-owned conversations: owner conversation, task id and inherited topic in the SATAN_* environment

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

Raised in SL-004 design (user question, 2026-10-24): when a task is running,
should the SATAN_* environment carry something for it?

Facts (checked 2026-10-24, pi-durable 1.4.0):

- Every tool exec runs inside a `ToolTask`, but `HarnessOptions.env` is told
  only `EnvTarget {conversationId, cwd, read}` — no task id.
- A task-owned conversation's record carries `owner {conversationId, taskId}`
  (`pi-durable/dist/types.d.ts:372`). DEC-012 keeps it out of the index, so
  SL-004 gives it no `SATAN_TOPIC` / `SATAN_PARENT_CONVERSATION`.
- Malebolge creates none today (`src/conversations.ts:115`, ownerless only).

Shape when it lands: e.g. `SATAN_OWNER_CONVERSATION`, `SATAN_TASK`, topic
inherited from the owner chain. Needs a record read (`Storage.conversation`),
not the document reader, and new `mem.origin` columns in the room's `~/db/q`.
Pick up with the first feature that creates task-owned conversations (e.g. a
subagent tool).
