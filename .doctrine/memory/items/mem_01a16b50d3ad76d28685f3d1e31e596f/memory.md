SL-002 PHASE-04 EX-5 read: "No shipped document claims the listing waits ten
seconds." It was checked against `README.md` and `docs/internals.md`, both clean —
and passed. The reconciliation audit then found DEC-009's Choice still saying the
listing is "stderr merged, bounded by the client's own 10 s connect wait", plus a
design section that leans on an unrecorded five-second Emacs bound for the same
guarantee.

The failure is in the criterion's *reading*, not its wording: an accepted decision,
a locked design section and a plan row are all documents a future agent reads as
truth. A sweep for "no document says X" must cover `.doctrine/` — at minimum the
DECs the slice names in `shapes:`, the design sections it cites, and the plan's own
criteria.

Cheap habit: `grep -rn "<the claim>" README.md docs/ .doctrine/{dec,slice}/` before
marking such a criterion met. The reverse sweep is cheaper still — grep the
governance corpus for the *superseded* figure (here: "10 s", "merged") whenever an
amendment changes a mechanism.
