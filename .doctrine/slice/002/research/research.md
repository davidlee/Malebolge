# SL-002 research — listing conversations, and attaching from Emacs

## Header

| | |
|---|---|
| Producers | Orchestrating agent alone: this repo defines no research agents (`.doctrine/state/boot.md` has no *Research agents* section), so both threads were run by hand and captured verbatim in `raw/`. |
| Baseline | `research/baseline.toml`, stamped 2026-10-23 against `slice-002.md` (the verb `doctrine slice research 2`). Re-stamped after this artefact was written. |
| Code base | HEAD `574c2bc`; pi-durable 1.3.0 under `node_modules/`. |
| Scope read | `slice-002.md` as written this session. |

## Verification legend

- **✓** — verified by a grep/read of the cited site during this round (the same
  agent wrote this artefact and the design, so ✓ claims are re-checked at their
  point of use in `design.md` rather than trusted twice).
- unmarked — researcher claim from `raw/`, cited, not separately checked.

## Thread 1 — governance applicability

Full text: `raw/thread-1-governance.md`.

Binding, in force:

- **RFC-002 §Wire protocol ✓** sketches `{type:"list", topic?, archived?}` →
  "one reply, then close". This slice ships the sketch **without** `topic` and
  `archived` (both need the topic index RFC-002 defers), so the reply shape and
  the close-after-reply are the RFC's, and the filters are explicitly deferred.
- **RFC-002 §Clients ✓** names both halves of this slice — a client flag and an
  Emacs `completing-read` picker "over `list`" — while asserting no canon, which
  is why OQ-2 (buffers) stays a design decision.
- **SL-030 §Non-Goals ✓** (satan): a listing, if present, returns bare ids. That
  is a hard cap on the reply's payload: ids only.
- **SL-030 §Objective 7 ✓**: the wire id is a JSON number, a safe positive
  integer, unknown and task-owned conversations refused at attach. `list` reuses
  that id discipline.
- **`docs/internals.md` §Protocol ✓** is a shipped surface; a new first-line frame
  is a doc change too.

Checked, not applicable: ADRs/policies/standards (none exist in this repo),
satan SPEC-002 transports (satan ISS-053's to fix), satan ISS-055 (handshake is
that issue's remedy), satan IDE-010 (Emacs keeps comint here).

Revision candidates: RFC-002 could record that the shipped `list` is topic-free
(not edited here); satan ISS-055 gains a second skew data point when this ships.

## Thread 2 — code map

Full text: `raw/thread-2-code-map.md`.

Hotspots, shortest form:

| Site | Change |
|---|---|
| `src/protocol.ts:22-62` ✓ | `list` frame + its strict parse, beside `attach`'s (`ATTACH_KEYS`, `AttachRefused`). |
| `src/daemon.ts:168-219` ✓ | `firstLine` gains a fourth case; `laterLine` refuses `list` on a bound connection as it already refuses `attach`. |
| `src/daemon.ts:96-110` ✓ | `fail` is the only error-then-close; a successful `list` needs a clean close with no precedent. |
| `src/conversations.ts:43-96` ✓ | `list()` joins `root`/`open`/`watch`, reusing `resolveExisting`'s "one read in a commit" shape. |
| `src/attach.ts:56-120,150-175` ✓ | Flags and refusals in `parseAttachArgs`/`targetFrom` voice; the invocation type gains a list mode. |
| `src/attach.ts:220-232` ✓ | The skew precedent: exact message + `SKEW_HINT`. |
| `emacs/malebolge.el:44-47,69-70,211-229` ✓ | Where a target would come from; fixed buffer names and one process are why OQ-2 matters. |
| `test/fixtures.ts:174-199` ✓ | `lineClient` + `closed()` is the reply-then-close assertion seam. |
| `docs/internals.md` §Protocol ✓, `README.md` §"Which conversation" ✓ | Doc surfaces. |

Load-bearing facts:

1. ✓ **Enumeration is a transaction read only.** No public listing on `Harness`;
   `dist/session/transaction.d.ts:53` gives
   `scanConversations(query, limit, cursor?) → Page<ConversationRecord, Cursor>`,
   the `Tx` form at `dist/types.d.ts:874`. `conversations.ts:43-46` already
   commits a read this way.
2. ✓ **`Page = { items, next? }`**, `next` absent meaning the scan ended
   (`dist/types.d.ts:563-566`); the `Cursor` is opaque backend JSON that must
   round-trip to the same scan (`:567-571`).
3. ✓ **There is no "ownerless only" filter.** `ConversationQuery` is
   `{ownerConversationId?, ownerTaskId?, order?}` (`dist/types.d.ts:575-582`), all
   positive; `ConversationRecord` is `{id, parent?, owner?}` (`:262-273`). So
   ownerless is a code-side `record.owner === undefined`.
4. ✓ **The daemon's store is per profile** (`src/config.ts:139-148`) and nothing
   in `src/` calls `createTask` (grep: no match); the runner keeps job
   conversations **ownerless** in its own store (`src/runner/conversations.ts:19-25`).
   The ownerless filter is therefore defensive, and `ownerTaskId` would select the
   wrong half.
5. ✓ **A first line that is a command binds root and is acted on**
   (`src/daemon.ts:186-192`; `docs/internals.md:110-111`). **Corrected
   2026-10-23 by the critical pass:** an old daemon's answer to `{"type":"list"}`
   is a **root `snapshot` first, then `unknown message type "list"`** — the
   catch at `src/daemon.ts:176-185` calls `bindRoot`, which writes the snapshot
   (`:115-147`), and only then `writeError`. Asserted at
   `test/daemon.test.ts:563-574` (`snapshot` before `error`) and reproduced by
   the attach skew fake at `test/attach.test.ts:195-205`, which prints
   `» earlier` before the error. So a listing client must ignore every frame
   except its reply and an error, and must never print a snapshot.
6. ✓ **`Printable` (`src/render.ts:15`) is `AgentEvent | ErrorMessage |
   AttachedMessage | ClientNotice`**, and `attached` already renders as
   `attached to conversation N` (`:246-247`), which is what the Emacs transcript
   shows today.
7. ✓ **The Emacs client has no target plumbing**: fixed command list, a
   no-argument `malebolge-attach` that appends only `--emacs`, fixed buffer names,
   a single `malebolge--process`.

## Cross-thread findings

- **The RFC and the shipped code disagree on one point of shape, usefully.**
  RFC-002's list reply carries filters this slice cannot honour (no topic index
  exists), and its "one reply, then close" is exactly the shape the code needs —
  so the slice can ship the RFC's *transport* without deciding its *policy*. That
  is the same split SL-030 made for `attach`. Worth recording so a later reader
  does not think `list` shipped unfiltered by oversight.
- **The skew lesson is cumulative, not solved.** Thread 2 fact 5 shows `list`
  arriving at an old daemon behaves exactly like `attach` did (`unknown message
  type`); each new first-line frame re-opens satan ISS-055. The slice should
  generalise the skew *detection* (identify the unknown-type error, name the
  frame) rather than hardcode a second literal — otherwise the next frame adds a
  third.
- **"Clean close" is a genuine gap.** Every daemon-side close today is `fail`
  (error + end). `list` must answer then end without an error. That is a small
  but real addition to `daemon.ts`'s state machine, and it is where the phase's
  tests must be adversarial: a `list` on a *bound* connection must not end the
  connection, and a `list` whose reply is written must not race the socket end.
- **Emacs is the expensive half.** The mechanism (thread 2 facts 1-5) is a thin
  server change; the Emacs objective collides with a single-buffer, single-draft,
  single-process client (`malebolge.el:69-70,177-181`). Per-conversation buffers
  are the destination RFC-002 names, but the draft submit path is global, so the
  cheap, honest step is an explicit target at attach time and see OQ-2 answered
  in design rather than assumed here.

## Design-input deltas

Against `slice-002.md` as written:

1. **Objective 1 tightens.** `list()` = one commit,
   `scanConversations({order:"descending"}, PAGE)` (**corrected 2026-10-23:**
   descending, so a page limit trims the oldest rather than the newest), then
   `items.filter(record => record.owner === undefined).map(record => record.id)`,
   plus `truncated: page.next !== undefined`. No cursor persistence, no paging
   beyond one page: the slice lists at most a page. The page size is a named
   constant, and the doc must say what a conversation outside the page does (it
   exists and is attachable by id, just not listed).
2. **Objective 2 is now two changes, not one:** a `list` frame in `protocol.ts`
   and a *clean close* seam in `daemon.ts` (today only `fail` closes).
3. **Objective 4 generalises.** Skew detection should key on the daemon's
   unknown-message-type error and name the frame that was unknown, replacing the
   single `SKEW` literal with a predicate + the existing hint. (`SKEW` at
   `src/attach.ts:220-232` becomes the first instance of a rule.)
4. **Objective 5 gains a constraint from fact 7:** the Emacs target must be
   acquired *before* `make-comint-in-buffer` runs (the command list is built
   there), so a picker that shells out to `--list` must complete first, and its
   failure mode (daemon down, daemon too old) has to be a message, not an empty
   prompt.
5. **OQ-1 gains a default:** the reply is one frame
   (`{type:"conversations", conversations:[N,…]}`) then close — one frame matches
   `attached`'s precedent and a streaming reply would need `Printable` to grow a
   partial-field vocabulary for no gain at this size.
6. **Non-goals gain a line:** paging. The store is personal-scale and a listed id
   is still attachable when it falls off the page; a cursor is deferred to RFC-002's
   index work.

## Refresh round (2026-10-23)

RFC-002 gained a refresh commit `9c6a193` while this slice was in scoping:
D1–D7 accepted in principle (pending the user's detailed review), OQ-4
answered, OQ-3 handed to satan IMP-053, and a sequencing section. Detail in
`raw/thread-1-governance.md` §"Refresh round".

What it changes here:

- **The RFC names SL-002 as step 1 and fixes its payload**: "a `list` frame
  returning bare ids, `malebolge-attach --list`, and a target for
  `M-x malebolge-attach`". OQ-2 is answered by RFC-002 §Clients: a target prompt
  over bare ids now, a buffer per conversation with the topics work.
- **Labels are decided (D4) and deferred to step 4**: title if set, else the
  latest IDE-017 intent entry, else an excerpt of the first user message,
  derived at read time and never stored. So the label idea raised in
  conversation is withdrawn from this slice: it would implement a subset of D4
  ahead of the index D4 needs, and neither of D4's first two sources exists yet.
- **The first-line-verb split is RFC step 2's**, so SL-002 adds the second
  first-line frame and does not generalise the prelude.
- Reply shape is settled as a **framed object** (`conversations: [N,…]`), so
  step 4's widening to topics and labels is additive.

## Plan-time restamp (2026-10-23)

Re-baselined before `/plan`: the advisory flagged `design.md` as changed, which is
RV-005's own amendments landing after the first stamp, not a research drift. Every
Thread 2 site cited above was re-read against the tree at plan time (the protocol's
attach parse and its keys, `fail`/`alreadyAttached`/`firstLine`/`laterLine`, the
one-commit read in `conversations.ts`, `SKEW`/`SKEW_HINT`/`connectOrExplain`/
`failBeforeAttach` and `DEFAULT_WAIT`, `attach-main`'s coded-error exit, `Printable`
and the `attached` render, the Emacs target plumbing and `comint-scroll-to-bottom-on-output`,
the smoke's attach-only fake, the skew fake, the task-owned and
malformed-second-attach fixtures, the `just` gate, and pi-durable's
`scanConversations`/`Page`/`ROOT_CONVERSATION_ID`). All hold; no fact changed.

## Phase-planning restamp (2026-10-23, before PHASE-01)

The advisory flagged `plan.md` and `plan.toml` as added — the plan artefacts
themselves, not a source the research cites. Every Thread 2 fact was re-read at
the `/phase-plan` step against `7a63e64` (the protocol's strict-parse tables and
`AttachRefused`, `fail`/`alreadyAttached`/`firstLine`/`laterLine`, the one-commit
read and the `Conversations` object literal, `lineClient`/`closed()`, the
task-owned and snapshot-before-error and malformed-second-attach fixtures, and
pi-durable's `transaction.d.ts:53` Tx-form `scanConversations`,
`Page`/`Cursor`, `ConversationRecord.owner?`, `ConversationQuery`). All hold; no
thread needed refreshing. Restamped on that basis.
