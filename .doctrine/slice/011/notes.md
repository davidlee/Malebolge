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
