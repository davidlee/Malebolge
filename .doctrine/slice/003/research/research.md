# SL-003 research — topics and the conversation index

## Header

- **Round:** pre-design, 2026-10-24. Baseline: `baseline.toml` (stamped by
  `doctrine slice research SL-003`).
- **Thread 1 (governance):** `scripts/pi-research` (satan repo) on
  `llm-gateway/deepseek-flash`, `thinking: low`, jailed with this repo as
  `/workspace/malebolge`. Verbatim: `raw/governance.md`.
- **Thread 2 (code map):** `scripts/pi-scout --think low`, same model and jail.
  Verbatim: `raw/code-map.md`.
- **Orchestrator (Claude, from `~/dev/satan`):** verification of the ✓ rows,
  the cross-repo satan records (the jail could not see `~/dev/satan`), the
  pi-durable 1.4.0 delta, and synthesis.
- **Restamped 2026-10-24** after the scope was amended at design to record
  DEC-011..DEC-017. The research findings were unchanged by the amendment.
- The quotient `pi_agent` MCP route was refused (`policy-invalid`: the running
  server reads `quotient-policy/1`, the policy file is `/2`), so the shell
  route was used. Restarting the session should clear it.

## Verification legend

- ✓ = the orchestrator read or grepped the cited site.
- Unmarked = a thread's claim: cited, not checked. Design and plan may only lean
  on ✓ rows, or verify a row at the point of use.

## Thread 1 — governance applicability

Full text: `raw/governance.md`. The rows that bind:

### Binding constraints

- **RFC-002 D1, D3, D7, I-1** bind only because SL-003's scope adopts them
  (`slice-003.md:9-31`). I-1 allows "a single document (or a document family
  plus a key list)" and does not choose between them (`rfc-002.md:154-160`) ✓.
- **DEC-007 (list frame, bare ids):** keys widen additively; an element type
  does not (`record-007.md:61-62,92-95`). Every first-line frame refuses with
  one frame-named `FrameRefused`, then closes (`record-007.md:76-84`;
  `src/protocol.ts:66-79`). A new `topic` frame joins that vocabulary.
- **DEC-008 (`--list` flag):** `--list` is exclusive with `--conversation`,
  `--new`, `--cwd` and `--emacs` (`record-008.md:16-19`). `--topic` and
  `--here` must join that closed set deliberately.
- **DEC-010 (bare ids suffice):** refuses `--here` and attach-by-directory
  because "under the `room` profile a conversation's `cwd` is a room path and a
  shell's is a host path, so the lookup would silently miss", and hands it to
  this work (`record-010.md:29-33`) ✓. SL-003 inherits the hazard along with
  the feature.
- **SL-002's shipped guarantee:** `{"type":"list","topic":"x"}` is refused
  with `list: unknown key topic` (`test/daemon.test.ts:702-712`) ✓. Objective 5
  breaks this on purpose: amend DEC-007 and rewrite that test. Do not edit
  SL-002's locked design.
- **Satan DEC-104:** the model is a creation-time default, and a
  conversation's stored model is authoritative. Root is re-configured on every
  open, and no other conversation is ✓ (satan `doctrine show DEC-104`;
  `src/session.ts:41-42` ✓). D1 applies the same rule to cwd.
- **Satan DEC-107:** a client cwd is an opaque string, with no resolution or
  containment check; confinement is the jail's job ✓. A topic's directory is
  that same string.
- **Structure gate:** `test/structure.test.ts` changes in the same commit as
  any seam that moves (SL-002 `design.md:103`). An index module moves it.
- **Carried client defects:** IMP-006 (the listing has no reply timeout) and
  IMP-007 (`attach-main` can truncate piped stdout at larger reply sizes).
  Listing topics makes replies larger.
- **Criterion sweep:** any "no document claims X" criterion sweeps `.doctrine/`
  too (`mem.pattern.malebolge.criterion-sweep-must-include-governance`).

### Checked, not applicable

- **No ADR, POL, STD, SPEC or REQ in this repo**, so DECs are amended as prose,
  not through a REV (`mem.pattern.doctrine.decision-is-not-a-revision-target`).
- **REV-001:** abandoned and empty.
- **DEC-001 to DEC-006, DEC-009:** Emacs. Emacs topic support is the clients
  slice's (`slice-003.md:69`).
- **RFC-001:** module placement and the room mechanism; nothing on topics.
- **Satan ADR-017 and ADR-018:** the index and topics are daemon-internal state
  in the daemon's own store. They add no authority item to the ADR-017 §3
  ledger: cwd confinement is the jail's (DEC-107), and ceilings are IMP-053's.
  (Orchestrator judgement, not a ledger read.)
- **Satan IMP-053 and IDE-017:** non-goals (`slice-003.md:73-74`) ✓.

### Revision candidates

- **DEC-007:** amend. `list` gains a topic filter, the
  `unknown key topic` refusal retires, and listing topics gets a new reply or
  frame rather than a changed element type.
- **DEC-008:** amend. Extend the exclusivity set with `--topic`/`--here`.
- **DEC-010:** amend. `--here` moves from refused to SL-003's scope, under
  whatever rule settles the path-space hazard (X-2).

## Thread 2 — code map

Full text: `raw/code-map.md`.

### Hotspots

- `src/conversations.ts`: the only creation seam (`create`, `:69-82` ✓) and
  the only listing read (`list`, `:103-114` ✓). Objectives 1, 2, 4 and 5.
- `src/protocol.ts`: the `AttachTarget` union (`:33-37`), strict key lists
  (`:84,87`), the two-case `parseConnectionMessage` (`:153-163`). Objectives 3,
  4 and 6.
- `src/daemon.ts`: `firstLine` has one branch per verb (`:202-232`), plus
  `answerList` (`:185-199`). Objective 6.
- `src/daemon-start.ts`: defaults (`:69-70`) and the `conversationsReady`
  chain (`:94-97`). Objective 2's backfill goes between open and the first
  client.
- `src/session.ts`: `openSession` builds `HarnessOptions`. A
  `conversationCreated` hook would go here (X-1).
- `src/attach.ts`, `src/attach-main.ts`: client flags, `targetFrom`, the skew
  hint (`attach.ts:260-269`). Objective 7.
- Tests: `test/daemon.test.ts`, `test/conversations.test.ts`,
  `test/protocol.test.ts`, `test/attach.test.ts`, `test/structure.test.ts`.

### Cited facts

- **F-1** ✓ The daemon creates conversations in one place:
  `create()` → `harness.createConversation({ownership, agent})`, with no `init`
  (`src/conversations.ts:69-82`), reached only through `open({kind:"new"})`.
  The runner's `createConversation` uses a different store
  (`src/runner/start.ts:65` `runner.sqlite` vs `src/config.ts:145`
  `session.sqlite` ✓), so it never feeds this index.
- **F-2** ✓ No `fork` anywhere in `src/` or `test/` (0 hits). The API exists:
  `Conversation.fork(at, options)` with `init`, and the fork's record carries
  `parent: {conversationId, at}` (`dist/types.d.ts:262-276` ✓). SL-003 needs
  the first fork test.
- **F-3** First-line dispatch: `parseConnectionMessage` handles `attach` and
  `list`; everything else falls to `parseClientMessage`
  (`src/protocol.ts:153-163`). An error that is not a `FrameRefused` binds root,
  then writes the error and stays open (`src/daemon.ts:210-219`).
- **F-4** Session-scoped documents: `defineDoc({scope:"session"})` gives a
  `SessionDocToken`, read and written through `tx.doc(token)`
  (`dist/documents.d.ts:10-13`, `dist/types.d.ts:756`). Forks copy only
  conversation documents (`dist/session/forks.d.ts:1-11` ✓), so the index is
  fork-free, as I-1 needs.
- **F-5** ✓ `ConversationInit` "runs inside the creating commit… table reads
  here throw `ReadAfterWrite`; document access remains available"
  (`dist/harness/types.d.ts:412-421`). Unchanged in 1.4.0 source
  (`src/harness/types.ts:471`).
- **F-5b** ✓ `HarnessOptions.conversationCreated(tx, record)` "runs in every
  commit that creates or forks a conversation, raw `tx.createConversation()`
  included… before the conveniences apply `agent` and run `init`"
  (`dist/harness/types.d.ts:526-531`; 1.4.0 `src/harness/types.ts:631`).
- **F-6** ✓ The Session has one mutation line, and every commit runs while it
  is held. No document-conflict or retry error exists ("Nothing retries")
  (`dist/session/session.d.ts:20-34`). The per-profile instance lock rules out
  a second process (`src/instance-lock.ts`, `src/daemon-start.ts:78-83`).
- **F-7** ✓ `scanConversations` is one indexed SQL scan,
  `SELECT record … ORDER BY id … LIMIT n+1` (`dist/storage/sqlite/storage.js:138-156`).
  The record is only `{id, parent?, owner?}`: no entries, documents, cwd or
  model. The query has no topic filter, so topic listing reads the index.
- **F-8** cwd and model live in the per-conversation `pi.agent` document,
  written in the creating commit (`src/conversations.ts:78` ✓,
  `src/daemon-start.ts:69-70`).
- **F-9** The skew hint is
  regex `^unknown message type "([^"]+)"$` → "the daemon predates X: restart
  it" (`src/attach.ts:260-269`), applied to attach and to listing.
- **F-10** Test helpers: `lineClient`/`recorder` (`test/fixtures.ts:119-208`),
  `serveSession`/`listClient` (`test/daemon.test.ts:194-252`),
  `openTestHarness`/`openFauxHarness` (`test/harness-fixture.ts:53-100`), and the
  first-line parse table (`test/protocol.test.ts:37-96`).

### Assumption checks

- **A1** (fork's `init` can write a session-scoped document in the creating
  commit): **holds** ✓ (F-5). `init` cannot read the parent's record (a table
  read), so for a fork the parent id comes from the call site, or from the
  hook's `record.parent` (X-1).
- **A2** (`scanConversations` is cheap at startup): **holds per page** ✓ (F-7).
  Backfill must loop over pages; the precedent is the cursor loop in
  `src/runner/durable-ids.ts:27-32` ✓.

### Naming precedents

- Message types are lower-case nouns with a reply noun: `attach`/`attached`,
  `list`/`conversations` (`src/protocol.ts:39-57`).
- Refusals read `"<frame>: <problem>"`; unknown keys read `unknown key X`
  (`src/protocol.ts:66-92`).
- A domain API is a factory over `Session` that returns a small interface:
  `conversations(session, defaults)` (`src/conversations.ts:84`). Mirror it
  for topics and the index.
- Client invocations are a tagged union with `UsageError` refusals
  (`src/attach.ts:113-146`).
- Test names carry decision ids: `it("… (DEC-00N)")`
  (`test/daemon.test.ts:670,687`).

## Cross-thread findings

- **X-1. One seam: the `conversationCreated` hook, not `init` alone.** The
  scope's "the seam must be the only way to create a conversation" risk can be
  closed structurally. The hook fires for every creation and fork, raw
  `tx.createConversation` included, and it receives the record with `parent`
  and `owner` (F-5b ✓, F-2 ✓). It can therefore:
  - skip task-owned conversations;
  - give a fork its parent's topic by reading the index document;
  - default anything else to `default`.

  `init` then sets the topic the caller chose. It runs after the hook, in the
  same commit. Satan DEC-104 rejected this hook for *agent defaults*, a
  different question, so it does not bind here. To verify in design: does the
  hook fire when `harness.root()` creates root on a fresh store?

```
create / fork / raw tx.createConversation
        │  (one commit)
        ├─ conversationCreated(tx, record)   ← every path; writes entry
        │     fork → parent's topic; owned → skip; else → default
        ├─ agent change (cwd, model)
        └─ init(tx, id)                      ← caller's topic, when given
```

- **X-2. OQ-1 (who resolves `--here`) is really about path space.** The client
  defaults to the `room` profile (`src/config.ts:86-89` ✓), whose tools' cwd is
  a room path (`src/config.ts:25-29` ✓). A shell's git root is a host path.
  DEC-010 already names this (✓). Readings:
  - (a) client-side match on host paths. The matched string is not the
    directory the conversation gets.
  - (b) the daemon resolves a path. It knows the mapping only partly.
  - (c) store a second, host-side key. That breaks D3.
  - (d) `--here` only under `host`. Dead by default.
  - (e) drop `--here` from this slice.

  Each departs from Objective 7 in some way. User decision.
- **X-3. OQ-2 (a topic's "latest" conversation) collides with the root
  promise.** RFC-002 says a command first line binds root, "the `default`
  topic's first conversation" (`rfc-002.md:207-209` ✓), and the README promises
  a plain attach reaches root. If "latest" means highest id, `--topic default`
  stops reaching root as soon as backfill adds anything. "Most recently
  attached" needs extra state.
- **X-4. OQ-4 (is `default` ordinary or reserved) is decided by code.** Root is
  re-configured with the daemon's agent on every open (`src/session.ts:41-42`
  ✓). A `default` topic with its own directory would therefore never apply that
  directory to root or to legacy `attach new`, which keeps D1 only halfway.
  Reserving it, with no directory, avoids the problem.
- **X-5. OQ-3 (one index document or one per topic) is not a contention
  question.** Commits are serialised in-process and there are no conflict
  errors (F-6 ✓), so the scope's concurrent-writes risk is retired.
  One-versus-many is about document size and the checkpoint policy. Under
  1.4.0 that policy is an explicit `checkpointWhen` (X-6).
- **X-6. Upgrade to pi-durable 1.4.0 (user proposal, 2026-10-24).**
  Malebolge pins `pi-ai`, `pi-durable`, `pi-env` and `pi-mcp` at 1.3.0.
  Relevant 1.4.0 changes (pi `CHANGELOG.md` §1.4.0, ✓):
  - `defineDoc` and `defineDocFamily` require `checkpointWhen`. The index is
    the first `defineDoc` in malebolge (0 hits today ✓), so building it on 1.4
    avoids writing it twice.
  - Opening a SQLite store migrates it to schema v2, one way: 1.3.0 cannot
    reopen it. Both the daemon (`session.sqlite`) and the runner
    (`runner.sqlite`) use SQLite stores, and they are separate files (✓). Satan
    RSK-020 (a flake-pinned runner beside a live-tree daemon) is the risk: each
    binary migrates only its own store, but rolling back past 1.4.0 is
    impossible.
  - Crash-loop guard (`restartLimit`), a new `sleeping` task status, and
    `TaskRuntime`/`ToolExecutionApi` additions affect hand-built test fakes.
  - The removed APIs (`TaskRuntime.sleep`, `documentState`, `viewState`,
    `taskGraph`) are unused here ✓.
  - The `[Unreleased]` section breaks `Storage.commit` (an `adopt` callback)
    and watches. Pin exactly `1.4.0`.
- **X-7. Version skew applies to `topic` automatically.** An older daemon
  answers an unknown first-line type with `unknown message type "topic"`,
  which the client turns into the restart hint (F-9). A `topic` key on an
  older `attach` or `list` is refused as `unknown key topic`, not as an unknown
  type. The client must map that case too, or the scope's skew criterion fails.
  ✓ The key lists are strict, "so a field this daemon does not know fails
  rather than attaches root" (`src/protocol.ts:83-87`).

## Design-input deltas

1. **Seam:** use `conversationCreated` to guarantee every conversation gets an
   entry, and `init` for the topic the caller picks (X-1). The divergence risk
   goes from "fixed at the next startup" to structurally prevented. The
   startup backfill remains for conversations that predate the index.
2. **Retire the concurrent-writes risk** (X-5). Restate OQ-3 as document size
   and checkpoint policy.
3. **OQ-1:** the user picks one of X-2's readings. Objective 7 may change.
4. **OQ-2 and OQ-4** are coupled through root (X-3, X-4). Settle them
   together. A reserved `default` whose first conversation is root is the
   reading with the fewest new rules.
5. **Listing topics** is a new reply type, or a new frame, under DEC-007's
   widening rule. The `unknown key topic` test is rewritten, and DEC-007,
   DEC-008 and DEC-010 get amendments.
6. **First fork test** is new work (F-2). D7's fork arm is a criterion.
7. **pi-durable 1.4.0** as PHASE-01, or as a chore before the slice (X-6).
   Exit: all four `pi-*` packages at exactly 1.4.0, `just check` green, a
   1.3.0-created `session.sqlite` opens and migrates. Rollout note: deploy the
   daemon and the runner on their own schedules, each migrating only its own
   store.
8. **Skew criterion** covers both `unknown message type` and `unknown key
   topic` (X-7).
