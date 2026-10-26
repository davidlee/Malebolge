# IMP-014: Emacs client: one transcript and draft buffer per conversation

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## Problem

`malebolge-attach` always runs the attach client in the fixed buffers
`*malebolge*` and `*malebolge-draft*` (`emacs/malebolge.el:78-79`,
`malebolge--start-transcript`). Attaching a second conversation detaches and
replaces the first, so two conversations cannot be viewed or driven side by
side. Submit and draft lookups also go by these names.

## Seen

satan SL-032 PHASE-08 (2026-10-27): V13 needed two live conversations; the
operator worked around it by attaching them one after another within the
satan pool idle window.

## Direction

Name buffers per attach target (e.g. `*malebolge: <conversation>*`, with a
paired draft), and resolve the process/draft from the current buffer rather
than a global name.
