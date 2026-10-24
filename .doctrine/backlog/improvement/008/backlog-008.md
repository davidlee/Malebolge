# IMP-008: Tie the documented page limit, waits and truncation text to the constants they describe

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

From RV-007 F-8 (SL-002's reconciliation audit).

## Context

Four facts about SL-002's listing are stated in prose and read by nobody:

| fact | where it lives in code | where it is restated |
|---|---|---|
| one page is 50 | `LIST_PAGE` (`src/conversations.ts:37`) | `README.md` §"Which conversation"; `docs/internals.md` §Protocol |
| the connect budget is one second | `LIST_WAIT` (`src/attach.ts:255`) | `README.md` |
| the picker waits five seconds | `malebolge--list-timeout` (`emacs/malebolge.el:220`) | `README.md` |
| the truncation line's exact text | `TRUNCATED_HINT` (`src/attach.ts:258`) | `README.md`; the Emacs picker's message |

All four are correct today. Nothing fails when one of them moves: the truncation
test asserts that exactly one non-empty stderr line exists, not what it says, and
no test reads a number out of either document. PHASE-04 recorded the risk twice
("Stale number drift", "The docs hard-code numbers that no test reads") and
deliberately left it, because a doc test over prose is a new mechanism rather
than a trailing phase.

## Options

- **A doc test over the two files.** Read the constants from the modules and
  assert their decimal forms appear in `README.md` / `docs/internals.md` — cheap,
  and it fails on exactly the drift that matters (a reworded sentence that keeps
  the number passes, which is the right tolerance).
- **Generate the passages.** A snippet the docs include, rendered from the
  constants. Stronger, but it makes the README a build artefact.
- **A comment in each constant** naming its documented home. Cheapest; catches
  nothing by itself, but tells the next editor where to look.

The first option is the one that pays: it is the same shape as `verify-vt`'s
literal-keyword check, which this project already relies on.
