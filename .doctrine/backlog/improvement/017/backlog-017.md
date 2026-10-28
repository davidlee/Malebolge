# IMP-017: Toolset selection for forks and task-owned conversations

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

SL-005 ships a startup refusal for any fork or task-owned conversation: its
toolset selection cannot yet be derived, and pi-durable's fallback would
give it every installed extension. Neither exists in malebolge today (wake
tasks are conversation-owned tasks, `src/wake/task.ts:139`), so the
refusal fires first in whichever slice introduces one: pull this item
then. Candidates: the heartbeat, a mail triage task, a fork verb.

Mechanism designed and reviewed under SL-005 (RV-015 rounds 3-7, design
rev 46, then cut on operator ruling 2026-10-28):

- **Fork.** pi-durable forks through its harness, not malebolge's
  `create`, so `toolsetInit` never runs. The index hook
  (`conversationCreated`) copies the parent entry's `toolset` into the
  fork's entry, as it copies the topic; pi-durable copies the agent
  document as of the fork point (`AgentDoc` is `fork: "asOf"`), so the
  list is inherited. The startup reconcile re-derives the list from the
  inherited name.
- **Backfill of stored forks.** `backfillIndex` writes a stored fork's
  entry with its `parent` (`src/topics.ts:188-196`). An entry without
  `toolset` takes its parent entry's, resolved parent first; only a fork
  whose parent has no entry (a task-owned parent, which the hook skips)
  refuses startup, since defaulting it could widen a `mail` lineage to
  `interactive` (RV-015 F-53, F-55).
- **Task-owned conversation.** Unindexed; takes its owner's entry's
  toolset through `record.owner.conversationId`; refuses only when no
  owner entry exists.
- Tests designed: a harness fork of a `mail` conversation carries `mail`
  in entry and list with no init, also after a restart; a stored
  pre-slice fork is backfilled from its parent; a fork with no parent
  entry refuses; a task-owned conversation takes its owner's toolset, and
  refuses with no owner entry.

Related: IDE-002 (task-owned conversations' environment), DEC-024,
DEC-029 (6).
