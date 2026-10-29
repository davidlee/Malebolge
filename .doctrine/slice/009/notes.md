# Notes SL-009: Session bridge: a jailed pi session and a malebolge conversation exchange messages

Durable per-slice scratchpad — tracked in git. The place to lift anything from a
disposable phase sheet (`.doctrine/state/.../phase-NN.md`) that must survive
`rm -rf` before the slice close-out audit harvests it.

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-29 · design inquiring (rev 14) · 7187032 + handover commit

### Produced
- Slice scoped; research round 1 (`research/research.md`); design run
  dr-01a185c0… at inquiring, inq-1..inq-12 resolved.
- minted (proposed, not yet settled): DEC-064..DEC-075 (one per inquiry);
  ISS-003 (post envelopes unescaped); IDE-009 (bridge autonomy modes).
- No design.md, no code.

### Learned
- pi-durable `write` with model content waits for the next boundary (README
  § Busy Conversations) — basis of DEC-069 notes; ASM pending.
- Room daemon jail already binds `/run/user/1000/satan/durable/room` rw
  (`~/dev/satan/flake.nix:486`) — no satan change for the bridge socket.

### Open
- Operator acts outstanding: `sufficiency-accepted`; acceptance of
  DEC-064..075 (then settle them).
- Operator direction (2026-10-29): informal /arbiter-review with GPT over the
  inquiry answers (DEC-064..075) first; integrate feedback; then drafting and
  the official adversarial review are pre-approved.
- ASMs to record and verify in plan PHASE-01: write-with-model starts no run;
  TypeBox available to a jail-home extension; extension can set env for pi's
  bash tool.
- Flakes contract (DEC-074) needs a CHR backlog item (not yet created).

## Design triage (2026-10-29, exploring)

Operator inputs this session:
- SATAN → pi delivery is a **durable daemon-side outbox per pairing, acked by
  the pi client** (research X4 option b). Not an attach-style stream: pi must
  not consume SATAN's transcript.
- **No double handling** on the pi side: each message enters pi's context
  once. The post tool's result is a short ack, never an echo; inbound
  messages are pushed once; no polling receive tool.
- Posture: SATAN delegates (pi as hands) or operator-in-pi consults SATAN, by
  agreement. Emacs unchanged. Network is the jail profile's concern.
- The flakes combinator (socket dir ro, extension, read-only project mount)
  is the operator's / a flakes session's; this design owns its contract
  (DEC-059 pattern).

Defaults carried into inquiry unless the operator objects: `bridge` mode in no
talk set; posture fixed at pair; pi's messages escaped and framed as data;
pairing token; own socket directory.

Open questions → inquiries inq-1..inq-11 in the design run.

Risks: reach widens SATAN's capability (RFC-003); repo text inward (RSK-002,
light); two-agent loop (DEC-036 allows loops, so the bridge needs its own
bound); socket impersonation if the mount is writable (ISS-042).

Constraining governance: research.md Thread 1 (DEC-016, 024, 025, 029, 032,
035, 036, 038, 040, 042, 059, 014). Prior art: SL-006 threads; SL-008's
DEC-054 shared untrusted-block module (not yet built — sequencing to check).
Memories: frame-decoder-before-renderer; list-has-no-reply-timeout.
Side finding: ISS-003 (post envelopes unescaped).
