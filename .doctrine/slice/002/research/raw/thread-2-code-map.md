# Thread 2 — code map (SL-002)

Run 2026-10-23 by the orchestrating agent. Citations are `file:line` at HEAD
`574c2bc`, plus the pi-durable 1.3.0 type files under `node_modules/`.

## Hotspots

| Site | Why it changes |
|---|---|
| `src/protocol.ts:22-52` | `ClientMessage`, `AttachTarget`, `AttachMessage`, `AttachedMessage`, `AttachRefused` live here; the `list` frame joins them. `ATTACH_KEYS` (`:60`) shows the existing strict-key precedent. |
| `src/protocol.ts` `parseConnectionMessage` | The one parser both `firstLine` and `laterLine` call; a `list` frame must be distinguishable from a command and from `attach`. |
| `src/daemon.ts:168-196` `firstLine` | The first-line dispatch: `AttachRefused` → fail; other parse errors → bind root, error, stay open; non-attach command → bind root and act; `attach` → `bindTarget`. A `list` branch is a fourth case. |
| `src/daemon.ts:198-219` `laterLine` | Bound connections refuse a well-formed `attach` with `alreadyAttached` (`:203-211`); `list` needs the same treatment. |
| `src/daemon.ts:96-110` `fail` / `write` | The one place a connection ends with an error; a `list` reply ends the connection *without* an error. |
| `src/conversations.ts:74-96` `conversations()` | The seam over `Session`: `root`, `open`, `watch`. `list` joins it, so the daemon still holds no `Harness` directly (DEC-109 in satan). |
| `src/conversations.ts:43-56` `resolveExisting` | Precedent for "one read inside a commit, then ownership": the same shape `list` needs. |
| `src/attach.ts:56-89` `parseAttachArgs` / `targetFrom` | Strict `parseArgs`, every throw → `UsageError`; `targetFrom` holds the exclusivity rules (`conversation`+`new`, `cwd` without `new`). `--list`'s refusals belong in the same voice. |
| `src/attach.ts:150-175` `attachInvocationOf` | The single parse → `{target, inputMode, presentation}`. A `list` mode is a fourth field or a sibling function; design decides. |
| `src/attach.ts:220-232` `SKEW` / `failBeforeAttach` | The existing skew path: exact message `unknown message type "attach"`, then `SKEW_HINT`. An old daemon answers a `list` line the same way (`unknown message type "list"`), so the hint generalises. |
| `src/attach.ts:280-300` `connectOrExplain` | Connect-with-wait and the one "cannot connect" notice; a list client reuses it. |
| `src/attach.ts:345-400` `attach()` | The full client loop (held lines, `attached` gate, typing). A list client is much smaller: connect, send, collect one reply, close. |
| `src/attach-main.ts:9` `USAGE` | The usage string that lists the flag surface. |
| `src/render.ts:15` `Printable` | `AgentEvent \| ErrorMessage \| AttachedMessage \| ClientNotice`. A `conversations` reply either joins `Printable` (and `render.ts:246` gains a case) or the list mode prints raw ids and never renders. |
| `emacs/malebolge.el:44-47` `malebolge-attach-command` | The program the Emacs client runs; the target flag has to come from somewhere — a defcustom, a prompt, or a prefix argument. |
| `emacs/malebolge.el:211-229` `malebolge-attach` | No arguments; appends `--emacs` only; `comint-check-proc` guards re-attach. |
| `emacs/malebolge.el:69-70`, `:125-140` | Fixed `*malebolge*` / `*malebolge-draft*`, one font-lock set, one `malebolge--send-frame` over one process (`:177-190`). Per-conversation buffers mean per-conversation state here. |
| `docs/internals.md` §Protocol (`:82-122`) | The shipped protocol description, including the first-line outcome table. |
| `README.md` §"Which conversation" | The user-facing flag documentation. |
| `test/daemon.test.ts`, `test/conversations.test.ts`, `test/attach.test.ts`, `test/protocol.test.ts`, `test/render.test.ts`, `test/fixtures.ts:174-199` | The seams: `lineClient` gives `send`/`next`/`received`/`closed`, which is exactly the "reply then close" assertion this slice needs. |
| `test/structure.test.ts:11-30` | Allowlists by module name (runner/room import fences). Root modules are not fenced, so a new root module needs no allowlist edit — but a new `src/runner`/`src/room` import would. |

## Cited facts

1. **No public listing on `Harness`; enumeration is a transaction read.**
   `node_modules/@earendil-works/pi-durable/dist/harness/harness.d.ts` exposes no
   list; `dist/session/transaction.d.ts:53` has
   `scanConversations(query, limit, cursor?) => Promise<Page<ConversationRecord, Cursor>>`,
   and `dist/types.d.ts:874` is the `Tx` form taking a `Context`. `conversations.ts:43-46`
   already uses that pattern (`harness.commit(tx => tx.conversation(id), context)`).
2. **`Page<T,C> = { items, next? }`** (`dist/types.d.ts:563-566`): `next` absent
   means the scan ended. `Cursor` is opaque backend JSON (`:567-571`) that must be
   round-tripped to the same scan.
3. **No "ownerless only" filter.** `ConversationQuery` (`dist/types.d.ts:575-582`)
   offers `ownerConversationId`, `ownerTaskId` and `order` — all positive filters.
   `ConversationRecord` (`:262-273`) is `{id, parent?, owner?}` with `owner`
   `{conversationId, taskId}` when a task owns it. So "ownerless" is a code-side
   `record.owner === undefined` test, not a query.
4. **The daemon's store is per-profile and holds no task-owned conversations
   today.** `src/config.ts:139-148` gives `<state>/durable/<profile>/session.sqlite`;
   the runner has its own store (`src/runner/`), and `src/runner/conversations.ts:19-25`
   creates job conversations **ownerless** too. Nothing in `src/` calls
   `createTask` (grep: no match), so the ownerless filter is defensive, and
   `ownerTaskId` filtering would be wrong (it selects the owned ones).
5. **A first line that is a command binds root and is acted on**
   (`src/daemon.ts:186-192`, documented at `docs/internals.md:110-111`). So an old
   daemon receiving `{"type":"list"}` binds root, acts on an unknown message, and
   answers `{"type":"error","message":"unknown message type \"list\""}` — the
   client must not treat that as a list, exactly as `failBeforeAttach`
   (`src/attach.ts:280-292`) already treats the `attach` skew.
6. **A connection that sends nothing receives nothing**
   (`docs/internals.md:119-120`), and `fail` is the only error-then-close path
   (`src/daemon.ts:96-110`). A successful `list` needs a *clean* close, which
   today has no precedent: every daemon-side close is `fail`.
7. **`client_notice` is the one notice channel to the client**
   (`src/attach.ts:239-249`); notices go through `render`, so list output that
   bypasses `render` would be the first client output that does. `render.ts:246-247`
   shows the `attached` notice wording (`attached to conversation N`) that the
   Emacs transcript already displays.
8. **`malebolge-attach` parses with Node's `parseArgs` in strict mode and turns
   every throw into `UsageError`** (`src/attach.ts:56-84`), printing one line and
   the usage with exit 2 before connecting (`src/attach-main.ts:11-21`).
9. **The Emacs client has no target plumbing at all**: a fixed command list
   (`emacs/malebolge.el:44-47`), a no-argument `malebolge-attach`
   (`:211-229`) that appends `--emacs`, fixed buffer names (`:69-70`), and one
   `malebolge--process` accessor (`:177-181`). A target prompt therefore needs
   either a per-invocation command argument or a per-conversation buffer pair.
10. **The line client already tolerates a daemon that closes after one line**:
    `lineClient` arms `closed` at connect and `settle()` distinguishes
    "closed before attach" from a detach (`src/attach.ts:325-340`), so a
    reply-then-close verb fits the existing client shape.

## Naming precedents

- Wire frames: `attach` / `attached` (request / reply), `error`. A list request
  and its reply should follow that pairing (`list` → `conversations`?).
- Client flags: kebab, one per mode (`--conversation`, `--new`, `--cwd`,
  `--emacs`), refusals by exclusion.
- Module naming: one concern per file, noun-named (`conversations.ts`,
  `protocol.ts`, `attach.ts`, `render.ts`).

## Unverified / open for design

- Whether a clean (non-error) close needs a new seam in `daemon.ts`, or whether
  `socket.end()` after the reply is enough given `enqueue`/`actOn`'s chain.
- How the Emacs target prompt should obtain ids (spawn the client with `--list`,
  or attach-then-ask), and its behaviour when the daemon is down.
- Whether `--list` output belongs in `render.ts` (a `conversations` `Printable`)
  or in list mode's own writer.
