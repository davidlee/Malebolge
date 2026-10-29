Observed on SL-008 (2026-10-29): seven phases were committed by /super-orchestrator sub-orchestrator charters in the main worktree. At audit, `doctrine slice conformance 8` reported 0 conformant and every design-target selector "undelivered" — the registry had no rows, because no step of that path records them (the automatic phase binding belongs to the solo /execute path).

Fix at audit: one `doctrine slice record-delta <slice> PHASE-NN --commit <phase commit>` per phase. `--commit` records only that commit's own patch, so interleaved commits from other sessions stay out. A follow-up fix-up commit (docs) is not covered; note it, or use `--start/--end` if its paths matter.

Better: the seat (or sub-orchestrator) records each phase's delta right after committing it.
