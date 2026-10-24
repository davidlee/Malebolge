# RSK-001: Runner does not detect a conversation task parked by pi-durable's crash-loop guard

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## Context

Surfaced by CHR-002 (pi 1.4.0 upgrade), 2026-10-24.

pi-durable 1.4.0 added a crash-loop guard (`packages/durable/CHANGELOG.md`
§1.4.0). A task cut off by a crash, eviction or reset 5 times in a row
without committing a new state is **parked**. A parked task is blocked with
reason `restart_limit` in `inspect()`, is not active in `wake()`, and is
reported once. Only `Harness.retryTask(id)` runs it again.
`settings.restartLimit` sets the threshold; `Infinity` restores the old
behaviour.

## The risk

Evidence:

- The runner leaves `restartLimit` at its default of 5.
- The runner reads no task state, inspection or blocked reason, and never
  calls `retryTask`. In `src/`, `inspect(` matches only local git and
  quarantine helpers.
- The runner tracks a conversation by its submission record. `recover.ts:75`
  and `ending.ts:14` read `done` and `unanswered`.

Inference, not tested:

- If a job's conversation task is parked, its submission never settles. The
  job stays `running` while nothing runs.
- The active wall-clock deadline (`deadline.ts`, `active_wall_clock_s`)
  should still end the job. A crash interval counts as active time, and the
  timer is re-armed on every restart. So the job ends late, not never.
- The job then ends as a ceiling breach, not as a crash loop. The operator
  sees the wrong cause, and the "reported once" signal from pi-durable is
  dropped.

## Options

- At start-up recovery, run `inspect()` and fail any job whose conversation
  task is blocked with `restart_limit`, with a failure that names it.
- Or set `restartLimit: Infinity` to keep the 1.3.0 behaviour. The deadline
  then stays the only bound. This is simpler, but loses the guard.

## Done when

- A test reproduces a conversation task parked by `restart_limit`, and the
  job ends in a state that names the crash loop.
