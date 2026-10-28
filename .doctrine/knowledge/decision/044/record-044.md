# DEC-044: A reap writes the origin's tombstone first, and every post task enforces its origin's tombstone

<!-- Knowledge record body — context, detail, links. The structured, queried
     fields live in the sister `record-NNN.toml`; this prose is free-form and is
     never structurally parsed (the storage rule). -->


Amended 2026-10-29 by the operator ('the alternative sounds reasonable, let's see if it survives GPT'): the notice is made durable by creating its delivery task in the tombstone's commit, replacing the notice-owed flag and the startup delivery from it. To be tested in the post-draft review.


Consequence 2026-10-29 (design d1 review, pi F-2; operator agreed): the <family-reaped> notice is created in the tombstone's commit, before any withdrawal, so it carries no withdrawn count; DEC-036's example attribute withdrawn="3" is dropped. The journal line keeps the count.


Consequence 2026-10-29 (design d1 review, pi F-8; operator: 'keep 7 day pruning & accept'): the 7-day pruning is best effort. A turn still alive after the tombstone is pruned (DEC-035 admits a turn that never ends) could post again; its family is counted and capped anew.


Amended 2026-10-29 (operator: 'maybe just leave the tombstones, it seems unlikely to cause issues and is less code'): tombstones are never pruned. This replaces the best-effort 7-day pruning noted above.