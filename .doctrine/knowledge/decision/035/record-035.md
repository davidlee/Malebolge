# DEC-035: thread_post delivers a satan.post task without a bound; a post is never withdrawn

<!-- Knowledge record body — context, detail, links. The structured, queried
     fields live in the sister `record-NNN.toml`; this prose is free-form and is
     never structurally parsed (the storage rule). -->

Amended 2026-10-29 in the same inquiry: depth removed and origin added (DEC-036); failure answered to the sender by an active notice, on the operator's goal to deny explicitly or say "nope, here's why" rather than terminate silently.


Refined 2026-10-29 after design review r1 (Sol F-2, F-3, F-5), not superseded:
- DEC-042: afterFailedRun 'continue' daemon-wide, so a post queued behind a failed run progresses; the rationale 'turns end' holds again, and the consequence 'a stuck recipient holds a slot until its turn ends' now covers only a turn that never ends.
- DEC-043: an interrupted thread_post (crash after its commit) is ambiguous to the sender and may be duplicated by a retry; receipts are IMP-020.
- DEC-045: <post-failed> carries outcome withdrawn | delivered-incomplete.