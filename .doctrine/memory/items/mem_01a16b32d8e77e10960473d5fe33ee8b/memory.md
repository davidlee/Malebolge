# The shape

`LIST_WAIT` (`src/attach.ts`) is a `ConnectWait`, passed to
`connectOrExplain` → `connectUnixWaiting`. It bounds *connecting*, not
answering. The reader settles in `settle(state)` — on the socket's `close`
— so a daemon that accepts the connection and never replies leaves
`malebolge-attach --list` running indefinitely.

# Measured

A fake server that accepted `{"type":"list"}` and wrote nothing kept the
client alive for **19 s**, until the server itself closed the socket (and
would have kept it alive indefinitely). The client then reported
`the daemon closed before the listing completed` through `NOT_LISTED` (since SL-003 PHASE-04: `REQUEST_FAILED`, from `request` in `src/request.ts`).

# Why it matters to Emacs

The picker runs `--list` synchronously, so an unbounded client would freeze
the editor. `malebolge--await-listing` (`emacs/malebolge.el`) therefore
carries its own bound, `malebolge--list-timeout` (5 s), deletes the client
and signals `user-error`. DEC-009's amendment ("DEC-008's short wait bounds
the pause") assumes the client bounds the reply; it does not, which is why
the picker's own bound exists.

# Not fixed here

Bounding the reply in the client is the right fix for the terminal path too,
and belongs to `src/attach.ts`, not to the Emacs picker. Filed as a backlog
improvement rather than folded into SL-002 PHASE-03.
