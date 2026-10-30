Observed SL-011, 2026-10-30, run dr-01a18ac0 in stage `reviewing`.

- `doctrine design adopt` re-baselines an edited design.md; it does not import decisions.
- The only route to add a decision minted mid-review (DEC-106/107 here) to the run's accepted set is new inquiry nodes whose checkpoints adopt it. That reopens the graph, sending the run back toward inquiring and making graph-reviewed and sufficiency-accepted stale (re-record on the user's reply).
- Alternative taken: leave them out of the run graph. Link `shapes SL-<n>`, cite them in the design, append "Refined by" notes to the refined DECs' bodies. The lock gate does not check this.

Choose by cost: two extra user acts and a stage loop versus a run graph that omits refining decisions.
