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
