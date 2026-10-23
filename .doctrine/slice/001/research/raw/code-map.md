# pi run 58d7d8c6b82d1583564d0763872e98b0 · 2293 records


## Result
## Thread 2 — code map

**Stdin → typed line → wire**

- `malebolge.el` starts a comint buffer over `malebolge-attach` via `make-comint-in-buffer`; the only configuration is program+args (`emacs/malebolge.el:22`, `:44-52`). No `comint-process-echoes`, no input filter, no send function override — comint's default `comint-send-input` writes the line plus `comint-input-sender`'s terminator to the subprocess (`emacs/malebolge.el:44-52`; inference, since the file does not touch those vars).
- `attach-main.ts` hands `process.stdin`/`process.stdout` to `attach` (`src/attach-main.ts:69-71`).
- `attach` reads stdin with `readline` in `terminal: false` mode and treats **each line as one command** (`src/attach.ts:243-252`). A line becomes `commandOf(typed)`: trim-empty → ignore, `/quit`, `/abort`, `/compact`, `/compact …`, else `{type:"input", content: typed}` — note `content` is the *untrimmed* line (`src/attach.ts:101-119`).
- Commands are JSON-encoded with `encodeLine` (one JSON object + `\n`) and written to the socket, or held until `attached` (`src/attach.ts:186-205`, `:195-203`, flush at `:161-166`).
- Blank lines are dropped at two independent layers: `commandOf` returns `undefined` for whitespace-only (`src/attach.ts:103-105`) and the splitter drops lines whose `trim()` is empty (`src/ndjson.ts:53-56`).

**Wire → daemon input**

- The daemon installs one `lineSplitter` per connection and enqueues each line onto a serial promise chain (`src/daemon.ts:270-280`, `:262-264`). Ordering is per-connection and strictly sequential.
- First line binds: an `attach` frame's target, else root (`src/daemon.ts:166-188`); later lines act on the binding, and a second `attach` is refused with `already attached` (`src/daemon.ts:162-180`, `:60-63`).
- `input` runs the daemon-wide `beforeInput` gate then `conversation.submit` (`src/daemon.ts:76-89`, `:91-107`).
- Framing is NDJSON with no size cap on these sockets (`src/ndjson.ts:75-77`), so a multi-line payload cannot be sent today: the splitter would cut it into separate lines, and a JSON string containing a raw `\n` is invalid JSON anyway.

**Events → live and history rendering**

- The client parses each incoming line with `JSON.parse` then `toPrintable`, checking only that `type` is a string (`src/attach.ts:225-231`, `src/render.ts:20-34`).
- `createRenderer` is a closure over `blocks`/`shown` per connection (`src/render.ts:146-150`), with `advance` printing only the unseen suffix and, on a rewrite, restarting with a leading newline (`src/render.ts:151-157`).
- History comes from the `snapshot` event: entries are replayed by `transcriptLine`, user turns prefixed `» `, assistant text bare, compactions as `[compacted]` (`src/render.ts:59-70`, `:167-168`). Live text comes from `message_start`/`message_update` deltas and is closed out by `message_end` (`src/render.ts:169-185`); non-answer events are notices or silent (`src/render.ts:91-130`).
- Output is append-only text, no cursor movement, explicitly so one renderer serves terminal and comint (`src/render.ts:1-3`). There is no color at all: the only cues are prefixes (`» `, `· `, `[note]`) and the `[connected]`/`[detached]` banners (`src/attach.ts:266-268`, `:129-130`).

**Ownership seams observed**

- Line-splitting: `attach` (client-side readline) and `daemon.ts` both split; the two are independent (`src/attach.ts:243-252`, `src/daemon.ts:270-274`).
- Command grammar: exclusively `commandOf` (`src/attach.ts:101-119`); the daemon knows nothing of slash commands, only protocol types (`src/protocol.ts:19-22`).
- Input rendering: the daemon never echoes user input; comint's own echo is the only local feedback (`emacs/malebolge.el:47-52`; inference — attachment writes nothing for input, see `src/daemon.ts:76-89`).

## Design-input deltas

1. **Payload seam is clean; framing seam is not.** The protocol already carries arbitrary strings in `content` (`src/protocol.ts:19-20`, `:110-116`) and JSON escaping makes embedded newlines safe on the wire. The only blocker is the client's line-oriented read: `createInterface({terminal:false})` emits one `line` per newline (`src/attach.ts:243-252`). A multiline mode must therefore live *above* readline, not in the daemon.

2. **Cheapest seam: agent-side assembly in the client.** A buffer that accumulates `commandOf` bypasses until a terminator, then emits one `{type:"input"}` with embedded `\n`, leaves protocol, daemon, and renderer untouched (`src/attach.ts:186-205` is the only function to change; `src/protocol.ts:110-116` already accepts it). Inference: `conversation.submit` takes content verbatim (`src/daemon.ts:76-89`), so the agent would receive real newlines.

3. **Terminator choice is constrained by the splitter.** `ndjson.ts` drops whitespace-only lines and strips trailing `\r` (`src/ndjson.ts:46-56`), so a blank line cannot be an *unambiguous* terminator without a client-side mode flag. Sentinel text (e.g. `.` or `/.`) survives splitting intact but collides with legitimate input unless escapable — a classic escaping/framing risk. Inference: the safest form is an explicit toggle command recognized by `commandOf` (`src/attach.ts:101-119`) plus a distinct end marker.

4. **Comint is where multiline usually belongs under Emacs.** Comint already keeps a multi-line input ring and can send a submitted region as one string; a `malebolge-mode` `comint-input-sender` that replaces newlines with a sentinel (or wraps them in a JSON `input` line) keeps the terminal one-line contract intact because `attach` still sees one line, and the *daemon* never learns of the convention if the sender escapes and the client unescapes. Inference: no code for this exists — `emacs/malebolge.el` defines no sender (`emacs/malebolge.el:44-52`).

5. **Input interleaving is already serialized per connection but not per buffer.** The daemon chain guarantees ordering within a connection (`src/daemon.ts:30-40`, `:262-264`), and held lines flush in order after `attached` (`src/attach.ts:161-166`). A client-side accumulator introduces a new ordering hazard: events keep streaming while a draft is open, so prompt/output follow depends on the renderer's append-only discipline (`src/render.ts:1-3`) and would break if a draft were echoed mid-stream.

6. **Prompt/output follow is the real behavioral cost.** With no color and no cursor control, the only signal that a multiline draft is open is textual. Rendering requires a cue the renderer currently has no vocabulary for — `notices` covers only daemon events (`src/render.ts:91-130`), and `attach` writes banners directly to `output` (`src/attach.ts:129-130`, `:266-268`). Inference: a client-local prompt line (like the existing `[connected]` banners) is the least invasive, and does not touch `render.ts` at all.

7. **No-color cues are prefix-based and must not collide.** `» ` marks user turns in history (`src/render.ts:63-64`), `· ` marks tools (`src/render.ts:98-106`), `[…]` marks notices. A continuation marker must avoid all three, and any echoed draft must not be mistaken for a replayed user entry — the snapshot replay path would print embedded newlines verbatim, so a multiline submission will appear as multiple lines on re-attach with only the first carrying `» ` (`src/render.ts:63-70`; inference).

8. **Risk: `trim()` in two places silently mutates drafts.** `commandOf` tests `typed.trim()` for emptiness but sends `typed` raw (`src/attach.ts:103`, `:119`). Any accumulator that relies on `commandOf` to detect a blank line will also inherit whitespace-only-line dropping from `ndjson.ts:53-56` — harmless client-side, but it means a blank line cannot carry meaning across the seam.

9. **Risk: no size ceiling on the daemon socket.** `lineSplitter` is unbounded here (`src/ndjson.ts:75-77`), while `boundedLineSplitter` exists and is used by other transports (`src/ndjson.ts:30-72`). A large multiline paste becomes one large line; the daemon will buffer it whole. If multiline becomes normal, adopting `boundedLineSplitter` for the client connection is the matching hardening, with `onOversize` mapping to an error frame.

10. **Risk: attach skew.** `attach` distinguishes an old daemon by matching the literal skew string (`src/attach.ts:121-123`, `:167-171`). Any new client-side convention that depends on daemon cooperation needs the same treatment; a purely client-side accumulator (options 2/4) avoids the skew problem entirely — this is the strongest argument for keeping multiline ownership in the client/Emacs layer.
