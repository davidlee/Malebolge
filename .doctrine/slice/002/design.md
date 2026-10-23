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

`truncated` comes from pi-durable's `Page.next` (`dist/types.d.ts:563-566`): it is how a client tells a complete listing from a page that was cut, and it is what lets the docs say "older conversations stay attachable by id" without guessing.

One refusal vocabulary replaces the attach-shaped one. `AttachRefused` and `attachRefused` today prefix every message with `attach: ` and depend on `AttachRefused` being the only error that ends a connection (`src/daemon.ts:176-181`). That does not generalise: a `list` refusal must not pretend to be an attach, and a *malformed* `list` frame must not fall into the "bind root, stay open" path. So a single `FrameRefused` class with `frameRefused(frame, problem)` and message `${frame}: ${problem}` serves both frames, and `firstLine` fails the connection for any `FrameRefused` — error first, then close, binding nothing.

The reply is a framed object rather than a bare array for the same reason: a type tag is what makes "is this my reply?" answerable on a shared socket vocabulary. It is also where the widening happens that *is* additive — new keys — as opposed to the element type, which is not (DEC-007's amendment).
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

- `finish(state)` — write, mark ended, `socket.end()`, drop the lines queued behind. `fail` is today the only daemon-side close (`src/daemon.ts:96-110`) and always writes an error; a listing must close without one.
- a failed listing routes through `fail`. `actOn` writes a turn's error and continues the chain (`src/daemon.ts:242-249`), and an unbound connection thereafter receives nothing, so a rejected `list()` would leave `--list` waiting forever.

On a connection that is already bound, a `list` frame is refused — `list: already attached to conversation N` — and the binding is unchanged, exactly as a well-formed `attach` frame is refused today (`src/daemon.ts:198-219`). One connection still means one conversation.
<!-- doctrine:section sec-4 -->
## Client: `--list` as its own mode

`malebolge-attach --list` is a fourth invocation shape, alongside attach-to-root, attach-to-existing and attach-to-new (`src/attach.ts:150-175`). The exclusivity is structural: `--list` combined with `--conversation`, `--new`, `--cwd` or `--emacs` is a `UsageError`, printed as one line plus the usage with exit 2 before any connect — the parse yields a *list* invocation, so the combinations are unrepresentable rather than checked twice.

Listing is its own reader, not a mode of `attach()`. `attach()` prints `[connected]` (`src/attach.ts:401`) and `[detached]` (`:409`), rejects on a close before `attached` (`:328-339`) and hands every frame to the renderer; a listing must print ids and nothing else. So `listConversations(socketPath, output, wait)`:

- connects through `connectOrExplain` (`src/attach.ts:280-300`), so a connect failure is told in the same voice as an attach;
- sends one `{"type":"list"}` frame and reads lines with `lineSplitter`;
- accepts exactly two frames — `conversations` and `error` — and **ignores every other frame**, because an older daemon sends root's whole snapshot before its error (`test/daemon.test.ts:563-574`, `test/attach.test.ts:195-205`);
- prints ids one per line through the renderer's new `conversations` case (one output path, `src/render.ts:15`), then resolves; a close before a reply, or an `error`, exits 1 with one message.

Its wait is short — about a second, one retry — not attach's ten-second `DEFAULT_WAIT`: a listing runs against a daemon that is already up, and Emacs calls it synchronously.

The skew rule generalises from a literal to a predicate. An error whose message is `unknown message type "<frame>"` is a version skew; the client says the daemon predates that frame and prompts a restart with the existing wording, naming the frame it did not know. `attach`'s current single case (`SKEW`, `src/attach.ts:220-232`) becomes the first instance of the rule, and the next first-line frame costs nothing.
<!-- doctrine:section sec-5 -->
## Emacs: a target under a prefix argument

`M-x malebolge-attach` keeps its behaviour with no argument: root, or the live client if one is attached. With a prefix argument it prompts, and the prompt is the one place numeric ids are paid:

1. Run `malebolge-attach-command` with `--list` synchronously, via `call-process` into a temporary buffer with stderr merged, announced first with a `message` and a `redisplay` so a stopped daemon does not freeze the editor silently. Non-zero exit — daemon down, daemon predating `list` — raises `user-error` carrying that output; the attach is abandoned, never silently redirected to root.
2. `completing-read` over those ids, newest first, plus a final `new` candidate. Candidates are bare numbers: RFC-002 D4 puts labels at step 4.
3. Assemble argv for the chosen target — `--conversation N` or `--new`, then `--emacs` — instead of the fixed `--emacs` append (`emacs/malebolge.el:225-227`).

Switching is where the one-buffer-pair design must be defended. With a live client and a named target the old client is detached first (`malebolge-quit`'s `quit` frame, then a bounded wait for the process, then `delete-process` if it survives), and the attach proceeds into the same two buffers. **If the draft holds non-whitespace text the switch is refused**, with a message to submit or clear it: the draft is shared, so a switch would otherwise post one conversation's text into another. There is no buffer-local target record — `malebolge--live-process` (`emacs/malebolge.el:176-179`) answers liveness, and the transcript's `attached to conversation N` is the only authority on what is bound.

Following must be restored across the switch. Attaching erases the transcript (`emacs/malebolge.el:218-222`), which clips point to `point-min`, and `comint-scroll-to-bottom-on-output` is nil (`:163`); left alone, the new snapshot would be inserted below point and the window would never follow. After the erase: `goto-char (point-max)`, and set the point of windows already showing the buffer.

Buffer names stay `*malebolge*` and `*malebolge-draft*`. Per-conversation buffers, `*malebolge:TOPIC/TITLE*`, and labelled candidates are RFC-002 step 4's.
<!-- doctrine:section sec-6 -->
## Verification and documentation

Each decision is proven by a criterion in the scope, and the plan turns them into tests rather than assertions:

- **The frame** (`DEC-007`): one `list` first-line line answers with `[N,…]` newest first and closes; a bound connection refuses with `list: already attached …` and the binding survives a control input; `{"type":"list","topic":"x"}` answers `list: unknown key topic` and closes, binding nothing; a rejecting `list()` answers one error and closes.
- **The page and the filter** (`DEC-007`): with `LIST_PAGE + 1` ownerless conversations, exactly `LIST_PAGE` come back with `truncated: true`; a task-owned conversation — the existing fixture at `test/daemon.test.ts:507-525` — is absent while the store's ownerless ones are present.
- **The client** (`DEC-008`): `--list` prints ids and no notices, and ignores a snapshot that precedes an error (the skew fake sends one, as an old daemon does); every flag combination is exit 2 with usage; a pre-`list` daemon produces the restart hint naming `list`.
- **Emacs** (`DEC-009`): a targeted attach passes the right argv; a switch with a non-empty draft is refused and the draft survives; after a switch point is at `point-max` and output follows; a failing `--list` aborts with the client's message rather than attaching to root.
- **The gate**: `just check` (biome, eslint, tsc, vitest with coverage) and `just ert` green; `test/structure.test.ts` unchanged unless a seam genuinely moves, and moved in the same commit if it does.

Documentation is part of the deliverable, not a courtesy: `docs/internals.md` §Protocol gains the `list` frame, its reply, its `truncated` key and its first-line rules; `README.md` §"Which conversation" gains `--list`, the `C-u M-x malebolge-attach` prompt, the 50-conversation page and the fact that an id names a conversation only inside one profile's store and socket, with older conversations still attachable by id.
