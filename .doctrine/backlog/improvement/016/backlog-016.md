# IMP-016: Orient command: re-inject a fresh SATAN boot context into an interactive conversation

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## Problem

A long interactive conversation receives `satan_boot_context` (percept,
attention, motive, …) once, early. Compaction folds it away, and nothing
re-sends it. Wake fires re-fetch it for themselves (`perceptOf`,
`src/wake/task.ts`); interactive conversations have no equivalent.

Observed 2026-10-28 (satan run `20261028T111832-interactive-a4b117`): SATAN
claimed `activity_read`, `content_read`, `vcs_log`, `docs_read` and the memory
tools were "not available". satan-mcp offered all 37 tools on that connection
and the model never called any of them. Tool schemas ride every request, so
the stale belief came from lost context or a compaction summary, not missing
tools.

## Sketch (agreed with the user, 2026-10-28)

```
attach "/orient" ─┐
Emacs C-c C-o ────┴─> {type:"orient"} ─> daemon act()
                        └─ percept = bootContext(satan, key)   (lifted from wake's perceptOf)
                        └─ submit(input: <percept> + "re-read your tool manifest;
                                  earlier claims about tool availability are stale")
```

- One percept fetch shared by wake and orient; no second implementation.
- Daemon-side injection, deterministic; not a client alias that asks the
  model to call the tool.
- A failed fetch still submits, carrying `percept unavailable: …` (wake's
  degradation).
- Surfaces: protocol frame, typed `/orient` in attach, `malebolge-orient` in
  `emacs/malebolge.el`.

## Follow-up (not in scope)

- Orient automatically on `compaction_end`, reusing this command.
