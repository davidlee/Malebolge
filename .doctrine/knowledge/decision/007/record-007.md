## Context

A client can only learn a conversation's id from the banner of the connection that
created or opened it (`[attached to conversation N]`). pi-durable exposes no public
listing: enumeration is `tx.scanConversations(query, limit, cursor?)` inside a
`harness.commit` (pi-durable 1.3.0 `dist/session/transaction.d.ts:53`,
`dist/types.d.ts:874`). After a daemon restart root reopens and every other
conversation stays in the store, unreachable.

## Choice

A connection's first line may be the frame `{"type":"list"}`. The daemon answers
`{"type":"conversations","conversations":[N,…]}` and then ends the connection
cleanly. It never binds a conversation, never creates one, and creates no durable
state.

- **Read.** One commit: `tx.scanConversations({order:"descending"}, LIST_PAGE)`.
  `LIST_PAGE` is a named constant (50). The items are filtered to
  `record.owner === undefined` — `ConversationQuery` has positive filters only
  (`ownerConversationId`, `ownerTaskId`), so ownerless is a code-side test — and
  mapped to `record.id`. No cursor is kept: one page, not a pager.
- **Order: descending, newest first**, printed as sent. Ids ascend in creation
  order, so a page limit with `ascending` would truncate the newest conversations
  — exactly the ones a returning client wants; descending trims the oldest, and a
  conversation beyond the page is still attachable by id.
- **Clean close.** Today `fail` (`src/daemon.ts:96-110`) is the only way a
  connection ends from the daemon's side, and it always writes an error first. A
  `list` reply needs the same drop-the-rest-of-the-queue semantics without the
  error: write the frame, mark the connection ended, `socket.end()`.
- **Bound connections.** A `list` frame on a connection that is already bound is
  refused with the existing `already attached to conversation N` error, binding
  unchanged — the same treatment a well-formed `attach` frame gets
  (`src/daemon.ts:198-219`).
- **Skew.** A daemon older than this client treats `list` as an unknown command,
  binds root and answers `{"type":"error","message":"unknown message type
  \"list\""}` (`src/daemon.ts:186-192`, `docs/internals.md:110-111`). The client
  must recognise that shape and say the daemon predates the verb.

## Alternatives

- One `{"type":"conversation","id":N}` line per id, then close — needs a
  streaming vocabulary in `Printable` for no gain at this size.
- An attached-connection verb (`list` after binding root) — breaks "one
  connection, one conversation" (SL-030 DEC-108) and invites a list to race its
  own attachment.
- Ascending order, as first scoped — a page limit would trim the newest.
- A separate `malebolge-ls` program reading the store — a second reader of a
  store the daemon owns.

## Rationale

One frame matches `attached`'s precedent. Descending order makes the failure mode
of a page limit drop the oldest. Refusing on a bound connection keeps one
connection meaning one conversation.

## Consequences

- `src/daemon.ts` needs a clean-close path beside `fail`.
- `src/protocol.ts` grows a second first-line frame; RFC-002 step 2 deliberates
  the general split, so this slice adds the frame and stops there.
- The reply is a framed object, not a bare array, so RFC-002 step 4 can widen it
  to topics and labels additively.
- Listing is one page of 50; older conversations remain attachable by id, and the
  docs must say so.
- `docs/internals.md` §Protocol documents the frame and its reply.

## Amendments (2026-10-23, after the informal critical pass)

Findings accepted on evidence; each cites the site that decided it.

- **The skew is a snapshot *then* an error.** A daemon older than the client binds
  root for the unknown `list` line, which writes root's `snapshot`
  (`src/daemon.ts:115-147`) before `writeError` (`:176-185`); asserted at
  `test/daemon.test.ts:563-574`, and reproduced by the attach skew fake at
  `test/attach.test.ts:195-205`. So any client that lists must ignore every frame
  except its reply and an error, and must never print a snapshot.
- **A refused `list` frame needs its own refusal.** `AttachRefused` is
  attach-shaped — `attachRefused` prefixes every message with `attach: `
  (`src/protocol.ts`), and only `AttachRefused` ends a connection
  (`src/daemon.ts:176-181`); any other throw binds root and stays open. RFC-002
  step 2 will send `{"type":"list","topic":"name"}`, which must be answered
  `list: unknown key topic`, error-then-close, binding nothing. Replace both with
  one frame-named refusal (`FrameRefused`, `frameRefused(frame, problem)`).
- **A failed listing closes the connection.** `actOn` writes a turn's error and
  keeps the chain (`src/daemon.ts:242-249`), and an unbound connection thereafter
  receives nothing, so a rejected `list()` would strand `--list` forever: route it
  through `fail`.
- **Truncation is reported.** The reply carries `truncated: boolean`, from
  `Page.next !== undefined` (pi-durable `dist/types.d.ts:563-566`), so a caller can
  tell a complete listing from a cut page. This is what lets the docs say "older
  conversations stay attachable by id" without guessing.
- **The element type is not additively widenable.** New *keys* widen additively; a
  new *element type* does not. Step 4's per-conversation labels make elements
  objects, which an older `--list` would print as `[object Object]`. Recorded, not
  papered over: the element type changes at step 4, and client and daemon ship
  together until satan ISS-055's handshake exists.

## Amendments (2026-10-24, reconciliation of SL-003, RV-011 F-1)

SL-003 (topics and the conversation index) widened this frame, as RFC-002 step 2
planned. The widening rule held: new keys and a new reply type, no changed element
type (DEC-016).

- **`list` takes `topic` and `topics`.** `{"type":"list","topic":T}` answers
  `conversations` with that topic's ids from the index, newest first, cut at
  `LIST_PAGE` with `truncated`. `{"type":"list","topics":true}` answers the new
  `{"type":"topics","profile","topics":[{name,cwd?}]}` reply. Bare `list` is
  unchanged: still one `scanConversations` page.
- **The `list: unknown key topic` refusal is retired.** The amendment above
  prescribed it as the answer to step 2's frame. That frame now ships. Any other
  unknown key, such as `{"type":"list","page":2}`, keeps the shipped
  `FrameRefused` shape.
- **A third first-line frame, `topic`**, writes one topic record and answers
  `topics` with it, then closes. The three first-line frames dispatch through
  one table (`FIRST_LINE`, `src/daemon.ts`). A bound connection still answers
  any of them with the unprefixed `already attached to conversation N`.
