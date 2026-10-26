# IMP-013: Keep the last good SATAN tool list when a refresh fails

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## Context

`satanTools`' `read` (`src/satan-tools.ts`) installs the empty `satan`
extension whenever a `tools/list` fails or passes its 2 s deadline. The rule is
"a failed read leaves no stale tools" (SL-028, RV-040 F-3).

Since satan SL-032 PHASE-07 (DEC-125), the first call of every new pool entry
also runs this refresh, once per conversation per idle window (15 min). So a
satan-mcp that is briefly busy (Emacs blocked) can now empty every
conversation's SATAN tools mid-turn, although nothing is down. The next
successful refresh restores them: the one before each external input
(`beforeInput`), or the next new entry.

Raised by the pi review of SL-032 PHASE-07 (finding 1, MAJOR). The user
deferred it here on 2026-10-26.

## Shape

Tell "satan-mcp answered with this list" apart from "the read failed". After a
failed read, keep the installed list if one was ever installed. Keep empty only
when no read has ever succeeded (satan-mcp absent at start-up). Weigh this
against the RV-040 reason for emptying: a tool that the server no longer serves
then fails at call time instead.
