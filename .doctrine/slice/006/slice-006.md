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

A first cut, therefore, has threads differing in place (topic, cwd, project
context) and in history, not yet in prompt or tools. Talk across harnesses
(the patch runner, gptel batch runs) is RFC-003 OQ-8, decided later.

## Scope & Objectives

1. **Start a thread.** A tool an interactive conversation calls to create a
   new conversation in a named topic of its talk set, seeded with a brief. It
   returns the new id.
2. **Fork a thread.** The same verb, or an argument of it, forks the calling
   conversation's history into a new conversation (pi-durable
   `forkConversation`). It brings IMP-017's fork branch: the index hook copies
   the parent entry's toolset; stored forks are backfilled from their parent,
   and a fork whose parent has no entry refuses startup. The startup refusal
   of forks in `src/session.ts` is lifted for this case only. Whether a fork
   may change mode within its set is a design question (RFC-003 OQ-3);
   keeping the parent's mode is the default.
3. **Post into a thread.** A tool that delivers a message to another
   conversation in the caller's talk set. It starts a turn in the recipient
   (queued if the recipient is busy, EVD-001), rendered as a turn envelope
   that carries the sender's id and mode, like `<wake>`. The sender's id is
   the reply address.
4. **Talk sets in code.** A closed declaration beside `PROFILE_TOOLSETS`
   that start, fork and post all consult. Mail belongs to no set, and a guard
   test asserts it.
5. **Bounds.** A cap on live threads and a cap on turns triggered by posts
   (by chain depth or rate), so threads cannot multiply or trigger each other
   without end. Refusals are stated in the tool result.
6. **Domain model, incrementally** (RFC-003). Whatever the slice touches
   moves towards the RFC-003 taxonomy rather than away from it. Candidates:
   naming (toolset → mode, OQ-1), the post envelope as the first member of a
   turn-origin family, and capability prose for any new extension carried by
   the extension itself.

## Non-Goals

- Task-owned conversations and IMP-017's task-owned branch (IDE-002).
- Mail in any talk set; quarantine plumbing (RSK-002, RFC-003 OQ-7).
- Talk across harnesses: patch runner, gptel batch runs (RFC-003 OQ-8).
- A second mode in the interactive talk set.
- Splitting `system/scaffold.txt` beyond what the slice touches; any change
  to satan's batch harness.
- Emacs client changes: per-conversation buffers (IMP-014) and topic choice on
  `new` (IMP-018). Threads are attachable through the existing `--list`.
- A per-conversation byte budget (IMP-015).
- Orientation re-injection (IMP-016), beyond keeping the envelope shape open
  for it.

## Affected surface (coarse)

- `src/topics.ts`: index entries for forks; backfill from the parent.
- `src/session.ts`: the startup refusal of forks.
- `src/conversations.ts`: creation, and a fork path.
- `src/toolsets.ts`: talk sets; the new extension in the interactive list.
- A new extension for the thread tools (location set in design), and
  `src/daemon-extensions.ts` to install it.
- `src/daemon.ts`, `src/protocol.ts`: delivering a post as a turn, if the
  daemon's input path is the route.
- satan-corpus `prompts/interactive.txt`: only if the slice touches it.

## Risks, assumptions, open questions

- **Runaway cost.** Threads that post to each other spend model turns
  unattended. Bounds (objective 5) are mandatory, not polish.
- **History coherence on fork** (RFC-003 problem 6). A fork into another mode
  inherits calls to tools it lacks. Moot while the set holds one mode.
- **Assumption:** pi-durable 1.4.0's `forkConversation` and the
  `conversationCreated` hook behave as IMP-017 and memory
  `pi-durable-conversation-created-covers-root` describe. Research confirms.
- **Assumption:** a post can enter a recipient through the harness without a
  client attached, as wakes do (`src/wake/task.ts`). Research confirms.
- **OQ:** Post rendering and how the reply address is presented.
- **OQ:** Whether start and fork are one tool or two.
- **OQ:** Caps: values, scope (per daemon, per thread lineage), and where the
  counters live given replay safety.
- **OQ:** Do posts and starts need operator visibility (a notification, a
  listing line) beyond attaching to the thread?
- RFC-003 OQ-1 (naming) and OQ-2 (whether a topic proposes a default mode).

## Verification intent

- Tests: start creates a conversation in the named topic with the brief as
  its first turn; a fork carries its parent's topic and toolset with no init,
  and after a restart; a stored fork is backfilled from its parent; a fork
  without a parent entry refuses startup; a post starts a turn in the
  recipient with sender provenance, and is queued when the recipient is busy;
  start and post refuse outside the talk set and refuse mail; both caps
  refuse with a stated reason.
- VH (verified by the operator): in the room, SATAN starts a thread in another
  topic, posts to it, and receives a reply; the operator attaches to both.

## Summary

The first slice towards SATAN talking across threads: start, fork and post
within the interactive talk set, bounded, with IMP-017's fork branch and
RFC-003's model applied where touched.

## Follow-Ups

- A second mode in the interactive talk set, so threads differ in prompt and
  tools.
- RFC-003 OQ-8: talk with the patch runner and gptel batch runs.
- IMP-014 and IMP-018 (Emacs client for many live threads).
