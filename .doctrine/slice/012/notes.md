# Notes SL-012: Mail action plans: the mail agent proposes, the operator executes in Gnus

Durable per-slice scratchpad — tracked in git. The place to lift anything from a
disposable phase sheet (`.doctrine/state/.../phase-NN.md`) that must survive
`rm -rf` before the slice close-out audit harvests it.

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-30 · design/drafting (run rev 18) · 0c2c9f2 (SL-012 work uncommitted)

### Produced
- DEC-108, DEC-109, DEC-110, DEC-111, DEC-112, DEC-113, DEC-114, DEC-115, DEC-116 (accepted, shape SL-012)
- research/research.md (threads 1–5, raw/ beside it)
- ISS-007 (malebolge canonical for its own records), ISS-008 (daemon jail never hosts a coding-tool agent)

### Learned
- JMAP Email ids are not addressable over IMAP; the RFC 5322 Message-ID is the only identity shared with Gnus (research cross-thread 3)
- nnselect summaries stage marks until `q` (push) / `Q` (discard): research thread 5
- Org buffers visiting no file never process file-local variables (DEC-116 rationale)

### Open
- Assumption in DEC-109: inbox children are `INBOX/<name>` over IMAP (live probe phase)
- Live probe items in DEC-112 consequences (multi-way `or`, UID MOVE on Fastmail)
- Reconcile-time record amendments: inq-9 non-durable note in the design run

## Design review (2026-10-30)

Informal arbiter review on RV-030's pass: pi first pass (F-1..F-8), GPT
gpt-6.1-sol adversarial pass (G-1..G-3), Opus disposer and author, pi
verify-only pass. Findings narrowed from missing mechanism (Message-ID
validation, forged plan ids, duplicate Message-IDs, marks pushed by moves) to
wording slips. Accepted bounded risks: no daemon-side mailbox path check
(operator's own names; one plan refused loudly); marks a move pushes are not
logged (the move is).

A further pass would probe only what review cannot settle and PHASE-01's live
probe and red/green tests will: Gnus behaviour on Fastmail (multi-way `or`,
UID MOVE, INBOX children, the `malebolge-mail--pushing` binding,
`gnus-activate-group` on a missing group, set-mark hook ordering on `q`).
No further design review pass is needed before lock; the plan gets its own.
