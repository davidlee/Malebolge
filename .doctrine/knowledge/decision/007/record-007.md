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
