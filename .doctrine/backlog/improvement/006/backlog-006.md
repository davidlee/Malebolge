# IMP-006: `malebolge-attach --list` should bound the wait for its reply, not just the connect

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## Context

`LIST_WAIT` (`src/attach.ts`, `{intervalMs: 200, timeoutMs: 1000}`) is a
`ConnectWait`: it is handed to `connectOrExplain` → `connectUnixWaiting`, so it
bounds *connecting* to the socket and nothing else. The listing reader settles in
`settle(state)` — on the socket's `close` event — so a daemon that accepts the
connection and never answers leaves `--list` running until the socket closes.

Measured while implementing SL-002 PHASE-03: a fake server that accepted
`{"type":"list"}` and wrote nothing kept the client alive for **19 s**, until the
server itself closed; it would have kept it alive indefinitely. The client then
reported `the daemon closed before the listing completed` through
`NOT_LISTED` — the right error, but only once something else ended the
connection.

## Detail

- DEC-008 describes `LIST_WAIT` as the listing's short wait and DEC-009's
  amendment says "DEC-008's short wait bounds the pause" for Emacs's synchronous
  call. Neither holds: the wait bounds the connect only.
- SL-002 PHASE-03 therefore carries its own bound in the picker
  (`malebolge--list-timeout`, 5 s, with `malebolge--await-listing`), which
  defends Emacs but not the terminal path: `malebolge-attach --list` against a
  hung daemon still waits forever.
- The fix belongs in `src/request.ts` (`request`, since SL-003 PHASE-04; it
  serves `--list`, `--topics` and `--set-topic`): a reply bound in its settle path,
  producing `REQUEST_FAILED` (was `NOT_LISTED`) with a message naming the daemon that did not answer —
  then the picker's own bound becomes a backstop rather than the only defence.
- `mem.fact.malebolge.list-has-no-reply-timeout` records the shape and the
  measurement so this is not rediscovered.

## Links

- Found in SL-002 PHASE-03 (2026-10-24).
- Related: `mem.fact.malebolge.attach-exit-truncates-piped-stdout` — the other
  sharp edge in the same client, also left unfixed by SL-002.
