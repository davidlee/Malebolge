# RSK-003: A reaped thread family can restart its fan-out through wake_schedule

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

`wake_schedule` (`src/wake/tools.ts:92-115`) records no origin, and DEC-036
gives every wake turn a fresh origin. So a reaped family's surviving turn, or
its `<family-reaped>` notice turn, can schedule a wake whose turn starts the
same fan-out again as a new family. Wakes scheduled before the reap escape the
same way.

**Accepted for SL-006** (operator, 2026-10-29, SL-006 inq-17; Sol review r1
F-6): each new family is still capped at K and reaped in turn, and wake timing
is clamped and jittered, so the harm is bounded. DEC-040's wording is narrowed
to match.

**Deferred resolution, if it proves an issue:** `wake_schedule` refuses when
the caller's origin is tombstoned, reusing the tombstone lookup the post task
does (SL-006 inq-15). A loud refusal; no origin carried into wakes.

**Signal to act:** journal lines showing a `<family-reaped>` origin followed by
a wake-originated family reaped for the same activity.
