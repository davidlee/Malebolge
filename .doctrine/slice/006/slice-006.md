# Threads: start, fork and post among interactive conversations

## Context

The goal is SATAN holding many conversation threads in different contexts,
with different prompts and tools, that start, fork and message each other.
The daemon already holds many conversations under topics (SL-003) and gives
each a fixed toolset (SL-005, DEC-029). No conversation can create, fork or
message another, and the daemon refuses to start with a fork or a task-owned
conversation in its store (`src/session.ts:92-99`).

RFC-003 (conversation domain model) frames the work. The operator's answers
of 2026-10-28, recorded there, set its bounds:

- **Talk sets** (RFC-003 OQ-3). Authority is a closed set of modes whose
  members may start, fork and post into each other. Nothing crosses between
  sets. Inside the daemon the only set is interactive conversations.
- **Mail is in no set** (RSK-002). A mail conversation reads foreign text
  and talks only to the operator.
- **Conversation before delegation.** Task-owned children (IDE-002) are set
  aside.
- **The prompt model changes incrementally** (RFC-003 OQ-6): rename toolset
  to mode, move tool-specific prose into extensions, and split the scaffold,
  each only where this slice touches it.

A first cut, therefore, has threads differing in place (topic and cwd) and
in history, not yet in prompt or tools. Project context is read once per
profile, not per conversation (RFC-002 D2 is unimplemented; research X-4). Talk across harnesses
(the patch runner, gptel batch runs) is RFC-003 OQ-8, decided later.

## Scope & Objectives

Settled in the design run's inquiry and review (2026-10-29); each objective
cites the decisions that shape it. The design (`design.md`) holds the
mechanism.

1. **Start a thread** (DEC-034). `thread_start {intent, context?, topic?}`
   creates a conversation in an existing topic (default: the caller's), with
   the topic's toolset or the profile default, refused outside the caller's
   talk set, and the topic's cwd or the daemon default. One `api.commit`
   creates, configures, indexes (`toolsetInit`) and creates the first post.
   Returns `{conversation, topic}`. The entry records `startedBy`.
2. **Fork a thread** (DEC-031, DEC-033). `thread_fork {intent, context?}`
   forks the caller at its latest entry, keeping its topic and toolset. It is
   refused unless it is the only tool call in its message, and only the model
   may call it. In the same commit it writes the child's result for the fork
   call (naming the parent) and creates the first post. IMP-017's fork
   branch: the index hook copies the parent entry's toolset; the startup
   refusal narrows to a fork whose entry has no toolset.
3. **Post into a thread** (DEC-035). `thread_post {to, intent, context?}`
   creates a `satan.post` task owned by the recipient. Delivery is wake's
   submission idiom without a bound: a post is never withdrawn for waiting.
   Rendered `<post from topic>` with `<intent>` and `<context>`; the reply
   address is `from`. A post that fails sends one terminal `<post-failed>`
   notice to its sender, with outcome `withdrawn` (never read) or
   `delivered-incomplete` (read; its turn did not complete) (DEC-045).
   Daemon-wide, a failed run continues with the inputs queued behind it
   (`afterFailedRun: continue`, DEC-042), so a post behind a failed run
   progresses; this also changes how queued wakes and operator inputs behave.
4. **Talk sets in code** (DEC-032, DEC-038). `TALK_SETS` beside
   `PROFILE_TOOLSETS`: the room's interactive set; mail and host have none.
   One `requireSameTalkSet` serves start, fork and post.
5. **Origins and bounds** (DEC-036, DEC-041, DEC-044, DEC-046). Every post
   carries an inspectable origin (the root human or wake input; a wake origin
   records its episode class). At most 4 active posts per origin and 12
   daemon-wide, counted by `harness.inspect`; the thread tools run
   sequentially, so one turn's calls cannot pass the caps together (DEC-041).
   Crossing either reaps a family (the over-cap one, or the largest, youngest
   on a tie). The reap's first commit writes the origin's tombstone and the
   `<family-reaped>` notice task together; queued posts are then withdrawn,
   placed turns finish and cannot post, and every post task enforces its
   origin's tombstone when it runs (DEC-044). Tombstones are never pruned. A
   wake scheduled from a reaped family opens a new, capped family (DEC-046,
   RSK-003). No chain-depth cap: loops are allowed.
6. **Topic latest skips threads** (DEC-037, refining DEC-015). `latestIn`
   ignores entries with `parent` or `startedBy`, so attach by topic,
   `wake_schedule {topic}` and the heartbeat stay on human-created
   conversations.
7. **Operator visibility** (DEC-039). Origin-tagged journal lines; `--list`
   marks threads; `notify_send` on a reap; transcript renders posts, notices
   (`[thread]`) and wakes (`[wake]`) as their own lines, not as `You:`, with
   their own Emacs faces.
8. **Interrupted calls** (DEC-043). The thread tools stay replay `unsafe`;
   a call interrupted by a crash after its commit is ambiguous to its caller
   and a retry may duplicate it. Accepted; receipts are IMP-020.
9. **Prompt surface** (DEC-040, DEC-045, DEC-046). Tool descriptions and one test-pinned
   `threads` section in code state the framing's facts (a post is from a
   peer thread, not the operator). Conduct between threads is SATAN's corpus
   prose; SL-006 does not change `interactive.txt`.

## Non-Goals

- Task-owned conversations and IMP-017's task-owned branch (IDE-002).
- Mail in any talk set; quarantine plumbing (RSK-002, RFC-003 OQ-7).
- Threads on the host profile (DEC-038).
- Talk across harnesses: patch runner, gptel-hosted runs spawning
  conversations (RFC-003 OQ-8, IDE-003).
- A second mode in the interactive talk set; a fork that changes mode.
- Renaming toolset to mode (CHR-004).
- Delayed or presence-gated threads; acting on an origin's episode class
  (DEC-036 addendum).
- Reconciling wake's delivery bound, `payload` and failure reporting with
  posts (IMP-019); only wake's transcript rendering changes here.
- Project context per conversation (RFC-002 D2).
- Splitting `system/scaffold.txt` beyond what the slice touches; any change
  to satan's batch harness.
- Emacs per-conversation buffers (IMP-014) and topic choice on `new`
  (IMP-018); a list or live view of threads (IDE-004). Faces for the new
  transcript lines are in scope.
- A per-conversation byte budget (IMP-015); cost ceilings (satan IMP-053).
- Orientation re-injection (IMP-016), beyond keeping the envelope shape open
  for it.
- Crash-safe receipts for thread tool calls (IMP-020, DEC-043).
- `wake_schedule` refusing a reaped origin (RSK-003, DEC-046).

## Affected surface (coarse)

- `src/toolsets.ts`: `TALK_SETS`, `requireSameTalkSet`; the new extension in
  the interactive list.
- `src/session.ts` also: the daemon's harness settings (`afterFailedRun`,
  DEC-042).
- `src/task-sweep.ts` (new): the start sweep of blocked tasks, shared by
  wakes and posts; `src/wake/sweep.ts` shrinks to wake's part.
- `src/late-binding.ts` (new): the two-step dependency binding wake and
  threads share.
- `src/topics.ts`: the hook copies a fork's toolset; `startedBy`; `latestIn`
  skips threads.
- `src/session.ts`: the narrowed fork refusal.
- `src/conversations.ts`: `toolsetInit` reused inside a tool's commit.
- A new threads extension (tools, `satan.post` task, notices, reap,
  tombstone, `threads` prompt section) and `src/daemon-extensions.ts`.
- `src/render.ts`: post, notice and wake lines; `--list` marks.
- `emacs/malebolge.el`: thread and reap faces.

## Risks, assumptions, open questions

- **Runaway cost.** Bounded by DEC-036 against fan-out; a looping
  population at the caps costs tokens, which satan IMP-053 bounds.
- **Unverified (DEC-031), tested first in the fork phase:** a tool may
  append a `ToolResultEntry` to the fork child. Fallback: explain the fork
  in the first post's envelope.
- **Unverified (DEC-036), tested first in the post phase:** follow-ups are
  placed one per run; withdrawing one queued post leaves a sibling input
  queued. No fallback: a failure returns to the operator.
- **Daemon-wide behaviour change (DEC-042):** inputs queued behind a failed
  run are answered in the next run; wake tests pinning the old behaviour
  are rewritten.
- **Accepted residuals:** an interrupted thread call may be duplicated
  (DEC-043, IMP-020); counts can overshoot across concurrently running
  turns (DEC-036, DEC-041); a reaped family can resume through a wake
  (DEC-046, RSK-003); a post placed in the moment of its reap is delivered,
  and a post queued behind a faulted run waits for the recipient's next
  input (DEC-044, DEC-042); a sender looping against a failing recipient is
  a loop like any other (DEC-036, satan IMP-053).
- **Assumption:** EVD-001 (busy conversations queue input) holds for
  task-submitted posts as for wakes.

## Verification intent

- Tests: start creates a conversation in the named topic whose first turn is
  the post, and is refused for an unknown topic or outside the talk set; a
  fork carries its parent's topic and toolset, its child sees the written
  fork result, it survives a restart, and it is refused alongside sibling
  calls; a fork after compaction works; a post starts a turn in the recipient
  with `from`, is queued when the recipient is busy, and its failure reaches
  the sender; mail and host refuse; a family over 4 is reaped and its
  originator told, while a co-resident loop is untouched; the global cap
  reaps the largest family; one message with more thread calls than the cap
  admits only up to it; a crash mid-reap delivers no queued family post and
  the notice once; a post behind a failed run is placed with no further
  input; `<post-failed>` reports withdrawn or delivered-incomplete;
  `latestIn` skips threads; posts and wakes render as their own lines.
- VH (verified by the operator): in the room, SATAN starts a thread in
  another topic, posts to it, and receives a reply; the operator attaches to
  both and sees the post lines coloured.

## Summary

The first slice towards SATAN talking across threads: start, fork and post
within the room's interactive talk set, bounded against fan-out by origin
families, with IMP-017's fork branch, and RFC-003's model applied where
touched.

## Follow-Ups

- A second mode in the interactive talk set, so threads differ in prompt and
  tools.
- IDE-003 (gptel-hosted runs spawning conversations), IDE-004 (live view),
  IMP-019 (wake reconciliation), CHR-004 (rename).
- IMP-020 (thread tool receipts), RSK-003 (reaped-family wake escape).
- IMP-014 and IMP-018 (Emacs client for many live threads).
