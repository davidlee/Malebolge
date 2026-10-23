# List conversations and attach to one from Emacs

## Context

All paths are in this repo unless stated.

SL-030 (satan) threaded a conversation through the daemon: `src/conversations.ts`
resolves or creates the one an `attach` frame names, `src/daemon.ts` binds one
conversation per connection, and `malebolge-attach` gains `--conversation N` and
`--new [--cwd DIR]`. The mechanism is live and root remains the default.

What it left out is the ability to *find* a conversation. There is no list verb:
pi-durable's public `Harness` has none, and the only enumeration is
`tx.scanConversations(query, limit)` inside a `harness.commit`. So the id a client
is told once (`[attached to conversation N]`) is the only handle it ever gets.
Two consequences bite immediately:

- After a daemon restart root is reopened and every other conversation is still
  in the store, unreachable unless the number was kept.
- `M-x malebolge-attach` hardcodes `--emacs` and nothing else
  (`emacs/malebolge.el`), so Emacs can only ever reach root.

malebolge RFC-002 governs the *policy* of conversation organisation (topics, an
index, titles, archiving). Its refresh of 2026-10-23 (`9c6a193`) accepts D1-D7 in
principle — pending the user's detailed review — and sequences the work:

1. **SL-002 (this slice):** a `list` frame returning bare ids, `malebolge-attach
   --list`, and a target for `M-x malebolge-attach`.
2. Topics and the index (I-1, D1, D3, D7), including the split between first-line
   verbs and attached-connection verbs, and `--topic`/`--here`.
3. Per-conversation project context (D2).
4. Clients: the nushell wrapper, an Emacs buffer per conversation, and listing
   labels (D4: title if set, else the latest IDE-017 intent entry, else an
   excerpt of the first user message — derived at read time, never stored).

So this slice ships unadorned ids, as SL-030 allowed ("Listing, if present at
all, returns bare ids"), and the readable-label surface is step 4's, not an
omission here: SL-002 has neither a title (no index yet) nor an intent entry
(IDE-017 is unbuilt) to derive one from.

## Scope & Objectives

1. **Store enumeration.** `src/conversations.ts` gains `list()`: one
   `harness.commit` reading `tx.scanConversations` once, keeping ownerless
   conversations only (a task-owned conversation is refused at attach, so listing
   one is noise), **newest first** (id descending, so a page limit trims the
   oldest), bounded by an explicit page size, and reporting whether the page was
   cut (DEC-007).
2. **Wire verb.** `src/protocol.ts` gains a first-line `list` frame — the second
   frame that is valid only as a connection's first line — answered with the ids
   and then the connection closes. It neither binds nor creates. On a bound
   connection `list` is refused with an error and the binding is unchanged, as a
   well-formed `attach` already is.
3. **Client flag.** `malebolge-attach --list` sends that frame, prints one id per
   line, and exits 0 without attaching; `--list` combined with `--conversation`,
   `--new`, `--cwd` or `--emacs` is a usage error, exit 2, before connecting.
4. **Skew.** A daemon older than this client answers the `list` line as an
   unknown command (it binds root and replies `error`); the client must not print
   that as a list and must say the daemon predates it and needs a restart, the way
   the `attach` skew path already does.
5. **Emacs target.** `M-x malebolge-attach` can name the conversation it opens:
   a target prompt over the daemon's own ids (plus "new"), and the transcript
   says which conversation it is showing. With no target chosen the behaviour is
   today's: root. Whether that is one buffer per conversation or an explicit
   switch of the existing buffers is a design decision (see OQ-2).

## Non-Goals

- Topics, an index document, titles, archiving and deletion: RFC-002's steps 2
  and 4 (D1, D3, D7, D4).
- **Listing labels** (RFC-002 D4) and the Emacs buffer-per-conversation shape:
  step 4. The reply is a framed object precisely so that widening it there is
  additive rather than a protocol break.
- The split between first-line verbs and attached-connection verbs: RFC-002 step
  2's deliberation. This slice adds the second first-line frame and leaves that
  question where it is scheduled.
- Fork as a client verb; changing a non-root conversation's model or `cwd`;
  per-conversation persona, skills or project context.
- Listing task-owned conversations (the runner's), or listing anything about
  them.
- Any cap or ceiling on concurrent runs (RFC-002 OQ-3).
- The native Emacs client over the event stream (satan IDE-010): Emacs keeps its
  comint client here.
- A version handshake (satan ISS-055); this slice only makes the `list` skew
  legible.

## Summary

Done when:

- `malebolge-attach --list` against a daemon holding root plus two created
  conversations prints exactly those three ids, newest first, one per line, with
  no transcript or other output, and exits 0 — and the same command against a
  daemon with root only prints one id.
- A task-owned conversation is absent from the listing, while the same store's
  ownerless conversations are present (the fixture that creates one exists at
  `test/daemon.test.ts:507-525`; `conversationIds()` is the oracle).
- With `LIST_PAGE + 1` ownerless conversations, exactly `LIST_PAGE` ids come back,
  newest first, and the reply says the page was cut.
- A listing that fails answers one error and the connection closes (tested with a
  `list()` that rejects) — not an error on a connection left open and silent.
- A malformed `list` frame — `{"type":"list","topic":"x"}`, the shape RFC-002
  step 2 will send — answers one error naming the frame, closes, and binds
  nothing.
- `--list` with any other flag is one usage line plus the usage, exit 2, and no
  connection is made.
- A `list` frame sent on a bound connection is answered with an error, the
  connection stays open, and the binding is unchanged (proven with a control:
  the same connection still accepts an input for its bound conversation).
- A daemon that predates `list` produces the restart hint, not a printed error
  line or a silent empty list.
- `M-x malebolge-attach` with a target attaches to that conversation and the
  transcript names it; `M-x malebolge-attach` without one still attaches to root;
  `C-c C-q` still detaches with the conversation left running.
- `just check` (format, lint, typecheck, vitest with coverage) and `just ert` are
  green; `test/structure.test.ts` is unchanged unless a seam genuinely moves, and
  a moved seam updates it in the same commit.
- README's "Which conversation" section and `docs/internals.md` §Protocol name
  the `list` frame and the `--list` flag, state the page limit and that older
  conversations stay attachable by id, and state that an id names a conversation
  only inside one profile's store and socket.

Risks:

- `list` as a first-line frame is the second such exception in the protocol; a
  third would argue for a general prelude/verb split rather than another branch
  in `firstLine`.
- Bare ids are weak UX — no titles, no cwd, no recency. Accepted deliberately as
  the interim step; RFC-002 is where it improves.
- The listing reads a commit on the same `Harness` that runs live conversations;
  a large `scanConversations` page would make a listing stall the daemon's turn
  chain. The page size must be small and explicit.
- The working tree carries uncommitted work that is not this slice
  (`AGENTS.md`, `emacs/malebolge.el` speaker faces, `flake.lock`, `flake.nix`,
  `.codex/config.toml`). The Emacs objective touches the same file as that
  in-flight edit: the slice's base commit must include it, or the phase collides.

Assumptions:

- `scanConversations` is callable from the daemon's existing `Session` without
  opening a second storage handle, and a `Cursor` is usable for a first page
  without storing one. (Verified in design/research, not assumed there.)
- Conversation ids are stable and meaningful only inside one profile's store and
  socket; the client prints what the daemon gives it and persists nothing.

Open questions:

- **OQ-1.** *Answered by RFC-002's sketch ("one reply, then close") and settled
  here:* one frame, `{type:"conversations", conversations:[N,…]}`, then a clean
  close. A framed object, not a bare array, so step 4 can widen it to topics and
  labels additively; one frame, not a stream, matching `attached`'s precedent.
- **OQ-2.** Emacs: one buffer per conversation (`*malebolge:7*`, draft per
  conversation) or an explicit switch of the one existing pair? RFC-002 §Clients
  answers this for now — "SL-002 adds a target prompt over bare ids. With topics:
  one buffer per conversation, `*malebolge:TOPIC/TITLE*`" — so the switch shape
  is this slice's and buffers are step 4's. The observation stands: the
  draft/submit plumbing is single-buffered today (`malebolge.el:177-181`), which
  is exactly why buffers belong with the topics work.
- **OQ-3.** *Answered by DEC-009:* a fresh `--list` each time, on its own short
  wait (not the attach wait), and a failure aborts the attach with the client's
  own message rather than falling back to root.

## Follow-Ups

- malebolge RFC-002: topics, index, titles, clients, concurrency cap. This slice
  is a mechanism it consumes, not a decision it makes.
- satan ISS-055: a protocol version handshake, which would retire the skew path
  this slice extends.
