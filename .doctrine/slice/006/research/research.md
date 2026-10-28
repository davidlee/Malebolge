# Research: SL-006 (threads: start, fork and post among interactive conversations)

## Header

- **Threads 1 and 2**: the orchestrator (Opus 5.5), reading directly,
  2026-10-29. This repo defines no research agents; every row below is
  load-bearing, and reading beat delegating then re-verifying. `raw/` is empty.
- Code base: HEAD `4fc6af1`; pi-durable 1.4.0 as installed
  (`node_modules/@earendil-works/pi-durable/dist`).
- Governance read with `doctrine show` (knowledge records, RFC-002, RFC-003,
  RSK-002, IMP-017). No ADRs, policies, standards or specs exist in this corpus.
- Baseline: `baseline.toml`, stamped by `doctrine slice research 6`.

## Verification legend

- ✓ means the orchestrator read the cited site in this round.
- Unmarked: a claim cited from a record, not re-checked against code.

## Thread 1 — governance applicability

### Binding

| Record | What binds this slice |
|---|---|
| DEC-012 | The `conversationCreated` hook writes every index entry. A fork takes its parent's topic from the index and records `parent`; a task-owned conversation is skipped. |
| DEC-013 | One session-scoped index document, `{topics, conversations}`. |
| DEC-015 | A topic's latest conversation is its highest id. A thread started in topic X becomes X's latest (see X-7). |
| DEC-021 | `SATAN_PARENT_CONVERSATION` is set for a fork and empty otherwise; every variable is always set. |
| DEC-024 | Every create path sets the extension list from a named toolset; a guard test creates by **every** path, across a restart, and asserts the tools are exactly the toolset's. New create paths (start, fork) join that test. |
| DEC-025 | (1) A toolset is fixed at creation; **forks inherit it**. (3) A new conversation's toolset is its topic's, else the profile's default. |
| DEC-029 | The closed catalog; a new extension is named in a toolset's list; startup refuses an uninstalled static name; every daemon toolset includes `conversation`. |
| DEC-030 (3) | Tool-coupled guidance lives in code, in the tool's description or its extension's section: precedent for RFC-003's "capability prose per extension". |
| RFC-002 D7 | Index invariant: every ownerless conversation is indexed in its creating commit; a fork joins its parent's topic and records it. |
| EVD-001 | Input to a busy conversation is queued in `pi.inbox` (`whenBusy`). Rests on API docs, not a live trace. |
| RSK-002 | Mail is in no talk set; a mail fork stays mail. |
| RFC-003 | Taxonomy and talk sets: deliberation, not canon. It binds only where this slice's design adopts it. |

### Checked, not applicable

| Record | Reason |
|---|---|
| DEC-001…006, DEC-009 | Emacs draft and presentation; the slice makes no Emacs change. |
| DEC-007, DEC-008, DEC-010 | The `list` frame and its output: unchanged unless threads need a listing change (open). |
| DEC-011 | The pi 1.4.0 upgrade: done. |
| DEC-014 | `--here`: untouched. |
| DEC-016, DEC-017 | Topic frame and attach flags: no wire change is planned; threads start through a tool, not a frame. |
| DEC-018, DEC-019, DEC-020, DEC-022 | The conversation context section and env: they already carry parent and topic. They apply only if the section changes. |
| DEC-026…028, ASM-001 | Mail tools and the screwtape client: mail is out of the set. |
| RFC-002 D2 | Per-conversation project context: not implemented (X-4). It applies only if the slice takes it on. |
| RFC-002 D6 | Cost ceilings belong to satan IMP-053 (gateway keys with topped-up budgets as the ceiling of record). The slice's caps are count guards, not cost (X-6). |

### Revision candidates

- **DEC-025 (1)** fixes "forks inherit the toolset". A fork that changes mode
  (RFC-003 OQ-3, option B) would revise it. Keeping the parent's mode needs no
  revision.
- **RFC-002 D5** deferred fork as a client verb. This slice adds fork as a
  tool, not a client verb; D5 stands for clients.

## Thread 2 — code map

### Hotspots

| File | Why it changes |
|---|---|
| `src/topics.ts` | The hook writes a fork's toolset (IMP-017); a stored fork is backfilled from its parent. |
| `src/session.ts` | `refuseUnsupported` refuses every fork at startup. |
| `src/conversations.ts` | `toolsetInit`/`create` are the create path to reuse inside a tool's commit. |
| `src/toolsets.ts` | Talk sets; the new extension in the interactive list. |
| `src/wake/task.ts`, `src/wake/tools.ts` | The delivery path a post would share (X-1). |
| `src/daemon-extensions.ts`, `src/daemon-start.ts` | Install and bind the thread extension (the wake binding pattern). |
| new `src/threads/` (name open) | The thread tools and the post task. |

### Cited facts

**Create and fork**

- ✓ F-1. `Harness#create` is one commit: `tx.createConversation` or
  `tx.forkConversation`, then `configure(tx, id, agent)`, then `init(tx, id)`
  (`dist/harness/harness.js:258-276`). The hook runs inside the create or fork
  call, before `agent` and `init` (`dist/harness/types.d.ts:568-569`).
- ✓ F-2. Raw `tx.createConversation({ownership})` and
  `tx.forkConversation(parent, at, {ownership})` are on `Tx`
  (`dist/types.d.ts:847-853`). A tool's `api.commit(tx => …)` gets that `Tx`
  (`dist/harness/types.d.ts:192`). A tool can therefore reproduce `#create`
  inside its own commit: create, configure, index entry and toolset together.
- ✓ F-3. `api.conversation(id)` returns an invocation-bound handle "of an
  existing conversation, such as one this tool created in `commit()`", with
  `submit`, `abort` and `waitForIdle`. It rejects after the invocation ends
  (`dist/harness/types.d.ts:203-204`, `79-89`).
- ✓ F-4. A fork's `at` must be an entry visible from the parent, or it throws
  (`dist/session/forks.js:5-7`). Conversation-scoped documents copy by their
  fork policy: `asOf` at the entry's commit, `current` from now (`forks.js:8-11`).
  `Conversation.context({at})` previews what `fork(at)` would start with
  (`dist/harness/types.d.ts:696-701`).
- ✓ F-5. A tool's `replay` defaults to `unsafe`: an interrupted execution never
  reruns (`dist/harness/types.d.ts:243-244`). `grep` and the mail tools are
  `safe` (`src/grep.ts:373`, `src/mail/tools.ts:281`); the SATAN tools keep
  `unsafe` (`src/satan-tools.ts:4`).
- ✓ F-6. The daemon's create path: `toolsetInit(profile, topic)` writes the entry
  via `writeCreated` and configures the selection in the creating commit;
  `create` calls `harness.createConversation` with `{ownership: ownerless,
  agent: {...defaults, cwd}, init}` (`src/conversations.ts:120-145`).
  `openTopic` resolves cwd as client, then topic, then daemon
  (`src/conversations.ts:156-182`).

**Index and startup**

- ✓ F-7. The hook writes `{topic, parent?}` and **no toolset**; a fork takes its
  parent entry's topic (`src/topics.ts:89-106`). `StoredEntry` allows a missing
  toolset until the reconcile backfills it (`src/topics.ts:36-42`).
- ✓ F-8. The reconcile backfills a missing entry toolset with the profile's
  **default**, not the parent's (`entryToolsets`, `src/topics.ts:283-305`).
- ✓ F-9. `refuseUnsupported` throws on any record with a `parent`, or an
  `owner`, before any write (`src/session.ts:92-105`, called at `:143`).

**Wake: the existing cross-conversation turn**

- ✓ F-10. `wake_schedule {topic}` targets another conversation: the topic's
  latest (`targetOf`, `src/wake/tools.ts:44-62`). It records
  `scheduledBy: api.conversationId` and creates the wake task inside
  `api.commit` (`src/wake/tools.ts:98-117`).
- ✓ F-11. A wake task is owned by its **target** conversation, in the background
  (`createWakeTask`, `src/wake/task.ts:136-145`).
- ✓ F-12. Delivery: `runtime.conversation(target).submit({type: "input",
  whenBusy: "followUp", requestId, entry: {kind: "satan.wake", data}, content})`,
  then a bounded wait that withdraws a still-queued input at the ceiling
  (`placed`, `boundedWait`; `src/wake/task.ts:405-470`). The request id
  `wake:<task>:<n>` is deduped per conversation (`:131-134`).
- ✓ F-13. The rendered envelope: `<wake fired_at … class … scheduled_by …>`,
  then `wake.md`, `<intent>`, `<payload>`, `<percept>`; fields are interpolated
  raw (`contentOf`, `src/wake/task.ts:187-201`).
- ✓ F-14. Wakes are room only (W10): the `tasks` extension is never installed
  on host (`src/toolsets.ts:40-41`, `src/daemon-extensions.ts:22`,
  `src/config.ts:244`).
- ✓ F-15. The heartbeat suppresses itself by counting live wakes through
  `harness.inspect` (`suppressed`, `src/wake/task.ts:318-334`;
  `liveWakes`, `:101-120`).
- ✓ F-16. Wake tools reach the harness through late-bound deps
  (`WakeBinding`: `bindEarly`, then `bindLate` in `beforeResume`;
  `src/wake/extension.ts:17-62`). `WakeDeps.conversations` already exposes
  `open` (`:28`).

**Prompt and context**

- ✓ F-17. Project context, persona and skills are built once per profile, not
  per conversation. A conversation with another cwd states that directory, but
  its project context was read from the daemon's directory: an accepted
  inconsistency (research X-6, DEC-080, cited in
  `src/daemon-extensions.ts:55-60`).
- ✓ F-18. Prompt sections today: `persona`, `skills`, `project_context`, `cwd`,
  `conversation`, `mail` (`src/persona.ts:63`, `src/skills.ts:161`,
  `src/project-context.ts:191`, `src/cwd.ts:8`,
  `src/conversation-context.ts:96`, `src/mail/extension.ts:16`).

**Tests**

- ✓ F-19. Fixtures to reuse: `test/wake-fixture.ts` (a harness over a store
  that outlives a close, a stopped clock, scripted satan-mcp),
  `test/harness-fixture.ts` (`openFauxHarness` has **no** creation hook).
  `test/structure.test.ts` asserts import allowlists for `src/runner/` and
  `src/room/` only.

### Naming precedents

- Task kinds are namespaced `satan.<name>` (`satan.wake`); entry kinds share
  the task kind (`WAKE_KIND`, `src/wake/task.ts:38`).
- Tools are `<area>_<verb>`: `wake_schedule`, `wake_cancel`, `wake_list`,
  `mail_read`. So: `thread_start`, `thread_post`, perhaps `thread_list`.
- Extension names are short nouns: `tasks`, `mail`, `grep`, `conversation`.

## Cross-thread findings

- **X-1. A post is a wake without a gate.** Wake already carries a turn into
  another conversation (F-10): durably, as a task created in the tool's
  commit, with a deduped request id, an entry kind, the sender's id and a
  bounded wait (F-11, F-12). A post needs the same delivery, without the
  schedule, quiet window and presence gate. Design input: share the delivery
  (`placed`/`boundedWait`/withdraw) between `satan.wake` and a new
  `satan.post` task, rather than writing a second path.
- **X-2. Start can be one atomic commit, and the brief durable.** By F-1/F-2,
  a tool can create the conversation, configure it, write its entry and
  toolset, and create the post task delivering the brief, all in one
  `api.commit`. With `replay: unsafe` (F-5), a crash before that commit leaves
  nothing, and after it leaves a thread whose brief the task delivers. Calling
  `harness.createConversation` from the tool, then `submit` through the
  handle (F-3), would leave a window for a thread without its brief.
- **X-3. Where a fork starts is unresolved.** A fork made from inside a tool
  call names an entry visible from the parent (F-4). The calling turn's
  assistant message holds the unresolved tool call. Forking at it would give
  the child a dangling call; forking before the current turn drops the
  turn's context. Not verified: which entries are visible mid-turn, and what
  pi-durable does with a dangling tool call in a fork. This needs a spike or
  a test early in the slice.
- **X-4. Threads do not differ in project context.** Project context is per
  profile (F-17); RFC-002 D2 is unimplemented. Threads in another topic
  differ in cwd and history only. The slice's Context overstates this; correct
  it, or take on D2 (a scope decision).
- **X-5. A runtime fork today bricks the next start.** The hook writes no
  toolset (F-7); the fork's agent document copies its parent's list, so it
  works until a restart, when `refuseUnsupported` throws (F-9). Had the
  refusal let it through, the backfill would give it the profile default
  rather than its parent's toolset (F-8). Fork and IMP-017 must land in the
  same phase.
- **X-6. Bounds: count guards, not cost.** Cost ceilings are satan IMP-053's
  (RFC-002 D6). The slice's caps guard against multiplication and loops. The
  heartbeat's live-wake count (F-15) is the precedent for a cheap live count of
  pending posts. A chain-depth cap needs the origin of the turn the caller is
  in: a post entry could carry a depth, read back from the caller's latest
  input entry. The cost of that read is unverified.
- **X-7. A new thread captures its topic's attach and wake target.** By
  DEC-015 (latest = highest id), a thread started in topic X becomes X's
  latest. Plain `--topic X` attach and `wake_schedule {topic: X}` (F-10) then
  go to it. This is intended for attach, and possibly surprising for wakes.
  Design should decide whether a post addresses a conversation by id only.
- **X-8. Host profile.** Posts are durable tasks like wakes. W10 keeps wakes
  off the host because they wake the room (F-14); a post does not schedule.
  Whether threads run on host is open, but the VH is in the room.
- **X-9. Talk set ≈ one toolset today.** Daemon toolsets are `interactive` and
  `mail` (`src/toolsets.ts`). With mail in no set, the interactive set is
  `{interactive}`. A set declaration beside `PROFILE_TOOLSETS` is a small
  closed type plus one check called by start, fork and post.

## Design-input deltas

1. **Post as a task.** A `satan.post` task, created in the sender's commit and
   owned by the recipient, delivers through the delivery path it shares with
   wake (X-1). Its entry kind carries the sender's id and mode.
2. **Start in one commit** (X-2): create, configure (the daemon defaults with
   the topic's cwd), entry and toolset, and the brief's post task, inside
   `api.commit`. Reuse `toolsetInit`/`writeCreated` rather than parallel code.
3. **Fork with IMP-017 in one phase** (X-5): the hook copies the parent
   entry's toolset; the backfill takes the parent's; the startup refusal
   remains only for a fork without a parent entry, and for task-owned
   conversations.
4. **Fork point: spike first** (X-3).
5. **Correct the slice's context claim** (X-4), or put D2 in scope.
6. **Addressing**: a post names a conversation id; decide whether start's
   topic capture of `latest` is acceptable for wakes (X-7).
7. **Caps**: a live count via `harness.inspect` for pending posts and live
   threads; chain depth carried on the post entry (X-6).
8. **DEC-025 stands** if a fork keeps its parent's mode; a mode-changing fork
   revises it.
