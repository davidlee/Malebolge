Seen in SL-009 PHASE-07..10 (2026-10-29/30): SL-007 and SL-010 sessions left lint errors and failing tests uncommitted in the shared main worktree, so `just check` on the live tree was red for reasons outside the phase.

Gate the phase's own commit instead: `git archive HEAD | tar -x -C <scratch>`, symlink the checkout's `node_modules` into it, run `just check` there. Report which tree was gated. Never stash/checkout/reset others' work to get a green live tree. The host gate on the live tree remains authoritative once the other writers commit.
