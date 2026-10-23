<!-- doctrine:section sec-1 -->
## Purpose and boundary

SL-002 gives a client two things it lacks: a way to learn which conversations the daemon's store holds, and a way to open one from Emacs. Today an id is only ever learned from the banner of the connection that created it (`[attached to conversation N]`, `src/render.ts:246-247`), and `M-x malebolge-attach` hardcodes `--emacs` with no target at all (`emacs/malebolge.el:211-229`). After a restart, root reopens and every other conversation stays in the store, unreachable.

This is RFC-002's step 1, and the boundary is the RFC's: `list` returns bare ids; labels (D4), topics and the index (steps 2), per-conversation project context (step 3), per-conversation Emacs buffers and the nushell wrapper (step 4) are all outside. The first-line-verb split is step 2's deliberation, so this slice adds the second first-line frame and stops there.

```mermaid
sequenceDiagram
    participant C as malebolge-attach --list
    participant S as Daemon socket
    participant E as Emacs (prefix arg)
    C->>S: {"type":"list"}
    S-->>C: {"type":"conversations","conversations":[9,7,3],"truncated":false}
    Note over S,C: then a clean close; nothing binds, nothing is created
    E->>C: run with --list, capture stdout
    E->>S: {"type":"attach","conversation":7}
    S-->>E: {"type":"attached","conversation":7}, snapshot, events
```

Two properties make the boundary honest. Listing creates no durable state: it is a read of conversations that already exist, so it cannot disagree with the store. And the reply is a framed object with a type tag, so a client can tell its reply from unrelated traffic — which matters, because an older daemon answers an unknown first-line frame by binding root and sending root's whole snapshot first (`src/daemon.ts:176-185`).

Decisions: DEC-007 (the frame, its reply, the clean close), DEC-008 (the client flag, one renderer, the skew rule), DEC-009 (the Emacs target), DEC-010 (why bare ids suffice here).
<!-- doctrine:section sec-2 -->
## The `list` frame

`src/protocol.ts` gains a second frame that is valid only as a connection's first line:

- request: `{"type":"list"}` — no fields. Like `attach`, the object is parsed strictly: an unknown key is a refusal that names the frame, so RFC-002 step 2's future `{"type":"list","topic":"name"}` gets `list: unknown key topic` rather than root's transcript.
- reply: `{"type":"conversations","conversations":[N,…],"truncated":bool}` — newest first, then the connection ends.

`truncated` comes from pi-durable's `Page.next` (`dist/types.d.ts:563-566`), and it has two consumers: `malebolge-attach --list` writes ids to stdout and, when the page was cut, one line to **stderr**; the Emacs picker adds a `message` to the same effect. That matters because the trim is not hypothetical: ids ascend in creation order, the scan is descending, so a full page drops the *oldest* conversation — which may be root, the client's default target. Root is never lost, though: a plain `malebolge-attach` with no flag binds it regardless of any listing, and `ROOT_CONVERSATION_ID` (exported, `pi-durable` `index.d.ts:29`) addresses it explicitly.

One refusal vocabulary replaces the attach-shaped one. `AttachRefused` and `attachRefused` prefix every message with `attach: ` and depend on `AttachRefused` being the only error that ends a connection (`src/daemon.ts:176-181`). That does not generalise: a `list` refusal must not pretend to be an attach, and a *malformed* `list` frame must not fall into the "bind root, stay open" path. So a single `FrameRefused` class with `frameRefused(frame, problem)` and message `${frame}: ${problem}` serves both frames, and `firstLine` fails the connection for any `FrameRefused` — error first, then close, binding nothing.

The bound-connection rule stays exactly as shipped, and is stated here so the rename cannot drift it. On a connection that already has a binding, any frame line that is not an actionable command for the bound conversation — a valid or malformed `attach`, a valid or malformed `list` — answers the **unprefixed** `already attached to conversation N` (`src/daemon.ts:51-54`), the connection stays open, and the binding is unchanged. Two branches make that true, and both are named because only the first is obvious: `laterLine` refuses a *well-formed* `list` beside a well-formed `attach`, and it maps any `FrameRefused` to `alreadyAttached(conversation)` (`src/daemon.ts:197-219`). Without the first branch a well-formed `list` reaches `act`'s `input`/`abort`/`compact` switch and silently writes nothing. That behaviour is shipped and tested — a malformed second attach answers `already attached to conversation 1` (`test/daemon.test.ts:624-629`) — and `docs/internals.md:112-114` documents it. The rule is about the connection, not the frame.

The reply is a framed object rather than a bare array for the same reason the refusal names its frame: a type tag is what makes "is this my reply?" answerable on a shared socket vocabulary. New *keys* widen additively; the element type does not, and step 4's labels change it (DEC-007's amendment).
<!-- doctrine:section sec-3 -->
## Daemon: one page, one commit, a clean close

`src/conversations.ts` gains `list()` beside `root`, `open` and `watch`, so the daemon still holds no `Harness` of its own (the DEC-109 seam SL-030 established). One commit, one scan:

```
list: harness.commit(tx => tx.scanConversations({ order: "descending" }, LIST_PAGE), context)
      → { ids: items.filter(r => r.owner === undefined).map(r => r.id),
          truncated: page.next !== undefined }
```

`LIST_PAGE` is a named constant of 50. Descending matters: ids ascend in creation order, so an ascending page would trim the *newest* conversations — precisely the ones a returning client wants. `ConversationQuery` offers only positive filters (`ownerConversationId`, `ownerTaskId`; `dist/types.d.ts:575-582`), so ownerless is the code-side test `record.owner === undefined`; the runner keeps job conversations ownerless in its own store, and nothing in `src/` creates a task-owned conversation, which is why the filter is defensive rather than load-bearing — and why it needs a test that proves it rather than a comment that asserts it.

In `src/daemon.ts`, `firstLine` gains the case: on a `list` frame it awaits `conversations.list()`, writes the reply and finishes the connection cleanly. Two new seams carry that:

- `finish(state)` — write, mark ended, `socket.end()`, drop the lines queued behind. `fail` (`src/daemon.ts:67-74`) is today the only daemon-side close and always writes an error; a listing must close without one.
- a failed listing routes through `fail`. `actOn` writes a turn's error and continues the chain (`src/daemon.ts:243-249`), and an unbound connection thereafter receives nothing, so a rejected `list()` would leave `--list` waiting forever.

On a connection that is already bound, a `list` frame is refused with the unprefixed `already attached to conversation N` and the binding is unchanged, exactly as a well-formed or malformed `attach` frame is refused today (`src/daemon.ts:197-219`, and sec-2's bound-connection rule). One connection still means one conversation.
<!-- doctrine:section sec-4 -->
## Client: `--list` as its own mode

`malebolge-attach --list` is a fourth invocation shape. `AttachInvocation` (`src/attach.ts:98`) becomes a union: `{ mode: "attach"; target; inputMode; presentation }` for the three attach targets, and `{ mode: "list"; wait }` for listing. That makes the flag's exclusivity structural — `--list` combined with `--conversation`, `--new`, `--cwd` or `--emacs` is a `UsageError`, one line plus the usage with exit 2 before any connect — and it gives `src/attach-main.ts` one dispatch: `invocation.mode === "list" ? listConversations(…) : attach(…)`.

Listing is its own reader in `src/attach.ts`, not a mode of `attach()`. `attach()` prints `[connected]` (`src/attach.ts:401`) and `[detached]` (`:409`), rejects on a close before `attached` (`:328-339`) and hands every frame to the renderer; a listing must print ids and nothing else. So:

```ts
listConversations(socketPath, output, wait, presentation = "terminal"): Promise<void>
```

It connects through `connectOrExplain` (`src/attach.ts:247-262`), which needs the renderer it is given, sends one `{"type":"list"}` frame and reads lines with `lineSplitter`. It accepts exactly two frames — `conversations` and `error` — and **ignores every other frame**, because an older daemon binds root and sends root's whole snapshot *before* its error (`src/daemon.ts:176-185`; `test/daemon.test.ts:563-574`; the attach skew fake at `test/attach.test.ts:195-205` sends exactly that). Ids go to stdout through the renderer's new `conversations` case (one output path, `src/render.ts:15`); a truncation line goes to stderr.

Its failure contract is the same shape as attach's, with its own error: `NotListedError`, `readonly code = "NOT_LISTED"`, mirroring `NotAttachedError` (`src/attach.ts:35`). That is what makes `attach-main` exit 1 with one message instead of rethrowing a stack: it exits 1 only for a coded error and rethrows anything else (`src/attach-main.ts:28-32`). The reader owns its socket: on an error frame, a refusal, or a skew it `end()`s the connection itself — `failBeforeAttach` is the precedent (`src/attach.ts:271-281`) — because the old daemon binds root and leaves the connection open, so waiting for its close would hang.

Its wait is `LIST_WAIT = { intervalMs: 200, timeoutMs: 1_000 }`, not attach's ten-second `DEFAULT_WAIT` (`src/attach.ts:203`): a listing runs against a daemon that is already up, and Emacs calls it synchronously. Where DEC-008's Choice says "the same waiting budget as an attach", its amendment supersedes it.

The skew rule generalises from a literal to a predicate. An error whose message is `unknown message type "<frame>"` is a version skew; the client says the daemon predates that frame and prompts a restart, naming the frame. `attach`'s single case (`SKEW`/`SKEW_HINT`, `src/attach.ts:205-206`) becomes the first instance of the rule, and the next first-line frame costs nothing.
<!-- doctrine:section sec-5 -->
## Emacs: a target under a prefix argument

`M-x malebolge-attach` keeps its behaviour with no argument: root, or the live client if one is attached. With a prefix argument it prompts, in a fixed order — **list, prompt, draft check, detach, attach** — so nothing is torn down before the decisions that could refuse it have been taken.

1. Run `malebolge-attach-command` with `--list` synchronously into a temporary buffer, stderr kept in its own buffer rather than merged, announced first with a `message` and a `redisplay` so a stopped daemon does not freeze the editor silently. Non-zero exit — daemon down, daemon predating `list` — raises `user-error` carrying that output; the attach is abandoned, never silently redirected to root.
2. `completing-read` over the numeric lines of stdout — newest first — plus a final `new` candidate. Candidates are bare numbers: RFC-002 D4 puts labels at step 4. stderr is prose, never a candidate: its presence is the truncation signal, and it is shown as a minibuffer message.
3. If the draft holds any non-whitespace text, refuse now — with the client still attached — and tell the user to submit or clear it. The draft is shared, so a switch would otherwise post one conversation's text into another.
4. Only then detach a live client (`malebolge-quit`'s `quit` frame, then a bounded wait for the process, then `delete-process` if it survives) and attach with argv for the chosen target: `--conversation N` or `--new`, then `--emacs`.
5. If the second attach fails — an id is a snapshot of the store, and `open` rejects `no conversation N` (`src/conversations.ts:40`) — report the failure and leave the transcript empty. Never fall back to root: the user asked for a specific conversation, and a silent substitute is worse than an empty buffer.

There is no buffer-local target record. `malebolge--live-process` (`emacs/malebolge.el:176-179`) answers liveness, and the transcript's `attached to conversation N` is the only authority on what is bound; a stored target would contradict the display after `C-c C-q`.

Following must survive the switch. Comint follows a *window* whose point is at the process mark (`emacs/malebolge.el:161-163`), and `comint-scroll-to-bottom-on-output` is nil (`:163`), so a window left scrolled back stays back while the new snapshot streams in. The remedy is per window: after attaching, put every window showing the transcript at the end (`goto-char (point-max)` in the buffer, and `set-window-point` for each window that shows it).

Buffer names stay `*malebolge*` and `*malebolge-draft*`. Per-conversation buffers, `*malebolge:TOPIC/TITLE*`, and labelled candidates are RFC-002 step 4's. The end-to-end path is covered where it already lives: `test/emacs-attach-smoke.ts` gains a `list` reply in its fake daemon (which today answers only an attach frame, `:129-140`) and asserts that a targeted attach sends the argv the picker chose.
<!-- doctrine:section sec-6 -->
## Verification and documentation

Each decision is proven by a criterion in the scope, and the plan turns them into tests rather than assertions:

- **The frame** (`DEC-007`): one `list` first-line line answers with `[N,…]` newest first and closes; a bound connection refuses with the unprefixed `already attached to conversation N` and the binding survives a control input, as does a malformed second `attach` (`test/daemon.test.ts:624-629`); `{"type":"list","topic":"x"}` answers `list: unknown key topic` and closes, binding nothing; a rejecting `list()` answers one error and closes.
- **The page and the filter** (`DEC-007`): with `LIST_PAGE + 1` ownerless conversations, exactly `LIST_PAGE` come back with `truncated: true` and `--list` writes one truncation line to stderr while stdout stays ids-only; a task-owned conversation — the existing fixture at `test/daemon.test.ts:507-525` — is absent while the store's ownerless ones are present.
- **The client** (`DEC-008`): `--list` prints ids and no notices, and ignores a snapshot that precedes an error (the skew fake sends one, as an old daemon does); every flag combination is exit 2 with usage; a pre-`list` daemon produces the restart hint naming `list` and exits 1 through `NotListedError`, not a stack trace.
- **Emacs** (`DEC-009`): a targeted attach passes the right argv; a switch with a non-empty draft is refused *before* anything is detached, and the draft survives; a failed second attach reports and leaves the transcript empty rather than attaching root; after a switch, a window that was scrolled back is at `point-max` and its output follows; a failing `--list` aborts with the client's message.
- **The gate**: `just check` (biome, eslint, tsc, vitest with coverage), `just ert` and `just smoke` (`justfile:23-25`, the only end-to-end evidence that the picker's argv reaches a daemon) green; `test/structure.test.ts` unchanged unless a seam genuinely moves, and moved in the same commit if it does.

Documentation is part of the deliverable, not a courtesy:

- `docs/internals.md` §Protocol gains the `list` frame, its reply, its `truncated` key and its first-line rules, and its bound-connection paragraph keeps the unprefixed message for both frames.
- `README.md` §"Which conversation" gains `--list`, the `C-u M-x malebolge-attach` prompt, the 50-conversation page with its truncation line, and the fact that an id names a conversation only inside one profile's store and socket.
- Two existing README claims are corrected with it: that "`just attach` and `M-x malebolge-attach` accept none, so both stay on root" (`README.md:123-124`), which the prompt falsifies; and the skew paragraph (`README.md:165-172`), which describes a hint aimed at `attach` alone when the rule now names whichever frame the daemon did not know.
- Nor is root lost when a page fills: the docs say a plain `malebolge-attach` always binds root, and that `ROOT_CONVERSATION_ID` names it explicitly.
