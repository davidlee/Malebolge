# DEC-036: Posts carry their origin; a family over its cap, or the largest family over the global cap, is reaped and its originator told

<!-- Knowledge record body — context, detail, links. The structured, queried
     fields live in the sister `record-NNN.toml`; this prose is free-form and is
     never structurally parsed (the storage rule). -->

Addendum 2026-10-29 (operator: "I like cheap optionality"): a wake origin also records its wake's episodeClass (attend or seclude); a human origin records none, the operator being present by definition. Nothing in SL-006 acts on it: posts are not presence-gated, so a family started before the quiet window runs through it. A later gate or prioritiser reads it from the origin, cheapest at the family root rather than per post. A delayed thread (start or fork at a future time, or by presence) is wake plus thread start composed later, out of SL-006.


Refined 2026-10-29 after design review r1 (Sol F-1, F-4, F-6), not superseded:
- DEC-041: thread tools run sequentially, so one turn's parallel calls cannot pass the caps; 'off-by-one under concurrency' now means across concurrently running turns only.
- DEC-044: the reap order is reversed — tombstone (with a notice-owed flag) first, and every satan.post task enforces its origin's tombstone when it runs; tombstones are pruned by a long age.
- DEC-046: a wake scheduled from a reaped family opens a new, capped family (accepted; RSK-003).


Noted 2026-10-29 (design d1 review, pi F-7): a post is active until the recipient's turn ends, and a reply is sent during that turn, so a two-party loop holds up to two active posts, not one. K = 4 admits two co-resident loops per origin; the design states it.



## Premise outcome (SL-006 PHASE-03, 2026-10-29)
Premises (b) and (c) HOLD on pi-durable 1.4.0, pinned by test/queue-premises.test.ts: two follow-ups queued behind a held run are placed in two runs (3 model calls; the run answering post:44: does not see post:45:); abortSubmission of one queued post answers aborted and leaves its sibling queued, then placed. (b) rests on pi-durable's followUpMode default one-at-a-time, now pinned explicitly by DAEMON_SETTINGS (DEC-042).



Amended 2026-10-30 (operator: "agree", to raising the caps): K = 8 and N = 16, from 4 and 12. Evidence: origin 2738/3037 was reaped at 5 active with two child threads — two starts, one nudge, two replies queued behind the root's running turn. Every post counts until its recipient's turn ends, both directions, so a family of width w holds about 2–3w active posts and K = 4 admitted only two quiet children. K = 8 admits three children with replies, or two with nudges; a spawn loop still crosses it within a turn. N = 16 stays above one full family plus co-resident loops. Counting and reaping are unchanged; not counting replies to the root was rejected, as a looping child could then fill the root's queue with nothing to stop it.