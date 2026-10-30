# SL-011 notes

## Design triage (2026-10-30)

Evidence: `research/research.md` (gitignored; raw thread output beside it).

**Constraining governance**
- DEC-025: a conversation's mode never changes. Pair binds; it never rewrites a mode.
- RSK-002 + operator: mail-mode conversations never reach the bridge.
- DEC-066..070, 072..080, 090, 095..098: bridge mechanics carried unchanged.
- To supersede: DEC-065 (pair creates), DEC-071 (bridge mode). To amend: DEC-029
  (catalog), DEC-032 (talk-set quarantine precedent), DEC-076 (wake reach).
  DEC-092/093 hinge on OQ-1.

**Shaping decisions (operator, 2026-10-30)**
- pi names the conversation id; Emacs-initiated pairing is out.
- Jail text reaching other conversations (threads) is acceptable; jail
  network egress is the jail profile's choice.
- Mail talks to nothing.
- Model is chosen when the operator creates the conversation.

**Open questions → design inquiries**
- Pair target and refusals (inq-1); retiring the mode (inq-2); stored
  `bridge` records (inq-3, OQ-2); section rendering (inq-4); re-pair
  semantics (inq-5); pair without an id (inq-6, OQ-1); origin of
  bridge-started turns under DEC-036 (inq-7); stale pairings on a working
  conversation (inq-8); verification incl. an Emacs path (inq-9, OQ-3);
  the pi command surface (inq-10).

**Risks**
- Retiring `bridge` without a remap makes the room daemon refuse to start
  (`src/session.ts:131-190`).
- Abort in pi downgrades buffered bridge turns to notes (DEC-079/090); more
  frequent now that the bridged conversation is the operator's main one.
  Accepted, unchanged behaviour.

**Assumptions**
- The live room store may hold `bridge`-mode conversations from SL-009's
  VH run (3949, 4524). Not checked; the remap must handle any number.

## Design review (2026-10-30)

Further passes (review.passes): no further design pass. Across RV-029 the
findings narrowed from missing mechanism (pi round 1, GPT rounds 1-2) to one
minor (GPT round 3). The simplicity pass removed F-16's lock: the operator
chose the token-hash check in `boundLine` plus the stated residual. A pi
verify-only pass came back clean. The next adversarial pass belongs to the
plan: phase criteria for F-4 (bridge notes keep the caller's origin), F-15 /
DEC-106 (seq continues across re-pair), F-16's single VT (stale-line
refusal) and F-17 / DEC-107 (untrusted framing on forks).

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-30 · ready (plan PHASE-01..08, none started) · 638c9d5

### Produced
- design review RV-029 (F-1..F-20; verified, concluded) → design locked 0c2c9f2; DEC-106 (refines DEC-103/066), DEC-107 (refines DEC-102)
- F-16/F-19/F-20/F-10 tolerated: token-hash check in boundLine, stated residual in sec-4 (operator chose this over a per-conversation lock)
- DEC-106/107 not in the design run's graph (shapes links + design citations instead)
- plan PHASE-01..08 (fbb22db; revised 55ab1b2, 3a71ff5 after pi + GPT plan review); phases materialised, status ready (638c9d5)
- phase-sheet checks: PHASE-04 may have no pi-bridge-shell fixture change left; PHASE-07 VT keyword "injects" must appear in the test title
- no code changed; gate not run

### Learned
- mem.fact.pi-durable.section-render-undefined-omits
- mem.pattern.malebolge.vh-through-the-operators-client
- mem.fact.doctrine.design-review-decision-not-in-run

### Open
- IDE-010 — attach-side end (out of scope)
