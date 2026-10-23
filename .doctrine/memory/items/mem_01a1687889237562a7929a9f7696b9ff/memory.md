Observed SL-002 PHASE-01, 2026-10-23.

`doctrine slice verify-vt 2` reported every VT of every phase as
`≈ UNATTRIBUTABLE — keyword present but <file> not modified by this slice`,
both before the implementation and immediately after the phase's code commit
(`ec6c8c5`). The keywords were already present and the files were in the commit.

The attribution range is the phase's conformance boundary: `code_start_oid` is
stamped when the phase enters `in_progress`, `code_end_oid` when it reaches
`completed`. Until the boundary closes there is no range to attribute over, so
"UNATTRIBUTABLE" here means "not yet", not "missing evidence".

Consequences: run `verify-vt` after `doctrine slice phase <id> PHASE-NN
--status completed`, and never "fix" a keyword because it read UNATTRIBUTABLE
mid-phase. The handover's note that it is "expected before the first landing"
is the same fact stated from the other end.
