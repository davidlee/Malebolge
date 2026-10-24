# Topics and the conversation index

## Context

All paths are in this repo unless stated.

RFC-002 (resolved 2026-10-23) settles how the daemon's conversations are
organised. This slice implements three of its decisions. Each is carried into
this slice's design, checked against the code there, and recorded as a
decision at design lock (RFC-002 Outcome, "Where each decision lands"):

- **D1.** A topic is a unique name with an optional working directory. The
  directory is a creation-time default: it is copied into a conversation when
  the conversation is created, and changing a topic never rewrites existing
  conversations. This is the rule satan DEC-104 applies to the model.
- **D3.** A topic carries only that directory: no model or extension defaults.
- **D7.** The index lists every ownerless conversation, whoever created it,
  and adds each one in the commit that creates it. A fork joins its parent's
  topic and records the parent. Conversations from before the index (root,
  and those made by SL-030's topic-less `attach new`) are backfilled into the
  `default` topic.

The index is a session-scoped pi-durable document (RFC-002 I-1). Session scope
means the whole store shares it and forks do not copy it.

Starting point, after SL-030 (satan) and SL-002:

- `src/conversations.ts` resolves or creates the conversation an `attach`
  frame names. A new conversation gets the daemon's model and `cwd`, or the
  client's `cwd` (DEC-104, DEC-107).
- `src/protocol.ts` has two frames that are valid only as a connection's
  first line: `attach` and SL-002's `list`.
- `list` scans the store with `tx.scanConversations` and returns bare ids.

## Scope & Objectives

1. **Index.** A session-scoped document records each ownerless conversation:
   its topic, and its parent if it is a fork. Every way a conversation is
   created (`createConversation`, `fork`) adds it through one seam, in the
   creating commit.
2. **Backfill.** At daemon start, any ownerless conversation that is not in
   the index joins the `default` topic, root first. Run again, it adds
   nothing.
3. **Topics.** A first-line `topic` frame creates a topic or sets its
   directory, then answers and closes. Names are validated. Changing a
   topic's directory leaves its existing conversations unchanged (D1).
4. **Attach by topic.** `{type:"attach", topic, new?, cwd?}` binds the
   topic's latest conversation, or creates one in that topic. A new
   conversation's directory comes from the client's `cwd` if given, else the
   topic's directory, else the daemon's.
5. **Listing reads the index.** `list` takes an optional topic filter and
   can list the topics themselves. Without a filter it returns what SL-002's
   `list` returns today.
6. **First-line verbs.** Split the commands that are valid only as a
   connection's first line (`attach`, `list`, `topic`) from the commands on
   an attached connection, so `firstLine` stops growing a branch per verb.
   SL-002 flagged this risk.
7. **Line client.** `malebolge-attach` gains `--topic NAME`, `--topics`,
   `--set-topic NAME [--dir PATH | --no-dir]`, and `--here` (find the topic
   whose directory is this git root). `--here` works only against a daemon
   that reports the `host` profile, and refuses against a `room` one
   (DEC-014, DEC-017).

## Non-Goals

- Per-conversation project context (D2): its own slice. Until it lands, a
  conversation in a topic with its own directory runs its tools there but
  gets the daemon's project context (SL-030 research X-6).
- Titles, labels derived from a conversation, and archiving (D4): the clients
  slice. The index's shape must leave room for them.
- Emacs topic support, the nushell wrapper: the clients slice.
- Fork as a client verb (D5). The index still has to handle forks, which
  tests create through the harness.
- Agent defaults on a topic beyond the directory (D3).
- Concurrency and cost ceilings: satan IMP-053.
- Task-created conversations and wakeups: satan IDE-017.

## Summary

Done when:

- A conversation created through `createConversation` or `fork` is in the
  index from its creating commit onward. A fork's entry names its parent's
  topic and its parent.
- Start a daemon on a store holding root plus conversations that predate the
  index: afterwards each is in `default`. Start it again: nothing changes.
- A topic created with a directory gives new conversations that directory.
  After the topic's directory changes, existing conversations keep their old
  one and new ones get the new one.
- `attach` by topic binds the topic's latest conversation, or creates one
  with `new`. The directory order is: client, then topic, then daemon.
- `list` with no filter matches SL-002's output on the same store. With a
  topic filter it returns only that topic's conversations.
- `malebolge-attach --topic` and `--here` work against a live daemon, and
  attaching or listing with `--here` outside any topic's directory, or in a
  directory several topics share, says so without creating anything;
  `--set-topic NAME --here` sets the git root as the directory either way.
  Against a daemon reporting the `room` profile, `--here` refuses and names
  the path-space mismatch, whatever socket override the client uses
  (DEC-014).
- Version skew: an older daemon answers the new frames, and the new keys on
  `attach` and `list`, with SL-002's restart hint, not with a bogus list or a
  bound root.
- `just check` and `just ert` are green. README's "Which conversation" and
  `docs/internals.md` §Protocol describe topics and the index.

Risks:

- ~~Concurrent writes to the index.~~ Retired at design: pi-durable runs
  every commit on one mutation line and has no document conflicts (research
  F-6, X-5).
- **Index and store diverge.** Closed by DEC-012: the `conversationCreated`
  hook runs in every creating commit, root, forks and raw creation included.
  The backfill remains only for conversations that predate the index.
- **pi 1.4.0 is a prerequisite** (DEC-011, CHR-002). SQLite stores migrate
  one way, and the pi-env room daemon must not churn between a pinned runner
  and the live-tree daemon.
- **Inconsistent prompt.** Until D2's slice, a topic with its own directory
  gives its conversations the daemon's project context (see Non-Goals).
  Consider running D2's slice soon after, or before, this one.

Assumptions (both held in research, 2026-10-24):

- `fork`'s `init`, like `createConversation`'s, can write a session-scoped
  document in the same commit (RFC-002 D7 rests on this).
- `tx.scanConversations` is cheap enough at personal scale to run once per
  startup.

Open questions, answered at design (2026-10-24):

- **OQ-1.** Who resolves `--here`: the client, from the topic list with
  directories, or the daemon, given a path? RFC-002 says the client.
- **OQ-2.** What is a topic's "latest" conversation: the highest id, the most
  recent activity, or the most recently attached? Only the first needs no
  extra state.
- **OQ-3.** Does the index have one document, or one document per topic plus
  a key list? This affects how far concurrent commits contend.
- **OQ-4.** Is the `default` topic an ordinary topic (it can be given a
  directory, and could in principle be renamed) or reserved?

Answers: OQ-1 → DEC-014 (the client, host profile only). OQ-2 and OQ-4 →
DEC-015 (highest id; `default` is reserved). OQ-3 → DEC-013 (one document).

## Follow-Ups

- Research round run 2026-10-24 (`research/research.md`).
- CHR-002 (pi 1.4.0) lands first. IMP-009: `--here` under the `room`
  profile.
- The slices that follow, in RFC-002's order: per-conversation project context
  (D2), then clients (D4).
- Governed by satan ADR-017 and ADR-018. They are cross-repo, so they are
  cited here rather than linked.
