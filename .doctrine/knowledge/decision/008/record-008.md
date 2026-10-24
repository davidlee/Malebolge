## Context

`malebolge-attach` parses with Node's `parseArgs` in strict mode and turns every
throw into a `UsageError`, printed as one line plus the usage with exit 2 before
any connect (`src/attach.ts:56-89`, `src/attach-main.ts:9-21`). The skew path is a
string literal: `SKEW = 'unknown message type "attach"'`, checked in
`failBeforeAttach` to print the restart hint (`src/attach.ts:220-232`).

## Choice

- **`--list`** sends `{"type":"list"}`, prints the ids one per line in the order
  the daemon sent them (newest first), and exits 0 without attaching. It connects
  with the same waiting budget as an attach (10 s), and exits 1 with one message
  when it cannot connect, when the daemon refuses, or when the connection closes
  before a reply — the same contract `attach` already has.
- **Exclusive by construction.** `--list` combined with `--conversation`, `--new`,
  `--cwd` or `--emacs` is a usage error: one line plus the usage, exit 2, before
  connecting. The parse produces a *list invocation* instead of an attach
  invocation, so the exclusivity is unrepresentable rather than checked twice.
- **One reader for the vocabulary.** The `conversations` frame joins `Printable`
  (`src/render.ts:15`) and renders one id per line, so the client's output path
  stays `render` (the single place notices and events are turned into text) rather
  than a second writer that bypasses it.
- **Skew generalises.** The literal becomes a predicate: an error whose message is
  `unknown message type "<frame>"` is a skew, and the hint names the frame that
  the daemon did not know, prompting a restart. `attach`'s existing case becomes
  the first instance of the rule; `list` is the second.

## Alternatives

- `--list` combined into an attached connection ("attach, then list") — no, that
  binds a conversation to answer a question about conversations.
- A bare JSON array as the reply — an object carries a type tag, which is what
  makes the skew and future widening legible.
- Keeping the exact-message `SKEW` literal and adding a second literal — the next
  frame would add a third.

## Rationale

The flag set stays flat (one flag per mode, refusals by exclusion), the output
path stays single, and the skew rule stops growing a literal per frame.

## Consequences

- `test/attach.test.ts` gains the list mode's refusals and output; the skew test
  covers both frames.
- `render.ts` learns one frame and its terminal rendering.
- A pre-`list` daemon produces the restart hint, not a printed error line.

## Amendments (2026-10-23, after the informal critical pass)

- **The list mode is its own reader, not `attach()`.** It accepts exactly two
  frames — `conversations` and `error` — and ignores everything else, because an
  old daemon's first frame is root's `snapshot` (DEC-007 amendment). It also
  prints neither `[connected]` (`src/attach.ts:401`) nor `[detached]` (`:409`),
  since the criterion forbids any output but ids.
- **One vocabulary, one renderer — for its own frames.** The `conversations` frame
  still joins `Printable` and renders one id per line (`src/render.ts:15`), so the
  terminal and a future Emacs list buffer read the same text; the list mode simply
  does not hand unrelated frames to it.
- **Its own wait.** A short wait (one retry, about a second) rather than attach's
  ten-second `DEFAULT_WAIT` (`src/attach.ts:203`): a listing runs against a daemon
  that is already up, and Emacs runs it synchronously (DEC-009), where ten seconds
  of frozen UI is the difference between a message and a mystery.

## Amendments (2026-10-24, reconciliation of SL-003, RV-011 F-1)

- **The exclusivity set widens** (DEC-017, SL-003 design sec-5). `--topic` is
  exclusive with `--conversation`. `--here` is exclusive with `--topic`,
  `--conversation`, `--dir` and `--no-dir`. `--topics` stands alone.
  `--set-topic` excludes every attach and list flag. `--dir` excludes
  `--no-dir`. One helper, `checkAlone` (`src/attach-invocation.ts`), enforces
  all of it. Each refusal is still a `UsageError`: one line, the usage, exit 2.
- **The skew predicate matches two shapes.** `skewOf` (`src/request.ts`) also
  treats a strict-key refusal of a new key as skew: `attach: unknown key topic`,
  `list: unknown key topic` and `list: unknown key topics`. These sit alongside
  `unknown message type "<frame>"`. Interactive attach and the request path
  share it, so every skew prints the restart hint.
- **One request path.** `listConversations` became `request` in
  `src/request.ts`. It resolves to the typed reply and prints nothing. Callers
  render: `--list`, `--topics` and `--set-topic` write their reply to stdout,
  and everything else goes to stderr.
