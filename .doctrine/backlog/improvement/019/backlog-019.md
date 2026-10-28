# IMP-019: Reconcile wake delivery with thread posts

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

SL-006 gave thread posts (DEC-035) a delivery that differs from wake's in two
ways. Reconcile wake with it:

- **Bound.** Wake withdraws a still-queued input after the ceiling
  (`boundedWait`, `src/wake/task.ts:409`); a post waits unbounded. Decide
  whether a one-shot wake should also wait, keeping the bound only where a
  stale fire is meaningless (the heartbeat re-arms anyway), and share one
  submission helper (requestId, `followUp`, typed entry) between them.
- **Extra field.** Wake's is `payload` (a JSON object, rendered with
  `JSON.stringify`); a thread's is `context` (a free string, DEC-034). Consider
  renaming wake's to `context` as a string, keeping stored `payload` readable.
- **Failure answered to the scheduler.** A failed one-shot wake is journaled
  and notified to the operator (DEC-134) but never told to the conversation
  that scheduled it; posts answer their sender (DEC-035). Consider the same
  terminal notice for wakes.
