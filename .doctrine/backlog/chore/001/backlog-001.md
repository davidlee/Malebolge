# CHR-001: Add a just gate recipe so doctrine check gate runs the project gate

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

From RV-004 F-8 (SL-001 audit). `doctrine check gate` fails with "justfile
does not contain recipe `gate`". Add `gate: check` (optionally with `ert` and
`smoke` when Emacs is present) so the doctrine gate runs the project gate.
