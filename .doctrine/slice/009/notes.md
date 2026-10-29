# Notes SL-009: Session bridge: a jailed pi session and a malebolge conversation exchange messages

Durable per-slice scratchpad — tracked in git. The place to lift anything from a
disposable phase sheet (`.doctrine/state/.../phase-NN.md`) that must survive
`rm -rf` before the slice close-out audit harvests it.

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-29 · design re-locked (rev 55) · plan authored (10 phases) · 654d026 + plan revision

### Produced
- Design run dr-01a185c0… locked (rev 45); `design.md` 9 sections;
  slice-009.md scope reconciled to the decisions.
- Accepted: DEC-064..DEC-076, DEC-078, DEC-079, DEC-080, DEC-090
  (DEC-076 refines DEC-032; 078 refines 070; 079/090 refine 069; 080/090
  refine 066).
- ASM-004..ASM-008 (verify in plan PHASE-01); CHR-007 (~/flakes contract,
  DEC-074); ISS-003; IDE-009.
- Design revised for SL-010 (ISS-004, resolved): DEC-092, DEC-093; RV-023
  waived (operator).
- plan.toml / plan.md: PHASE-01..10; RV-021 routed findings transcribed
  (index in plan.md § Notes).
- RV-021 (design review) done: 14 findings, all fix-now, verified, routed
  (probe: F-1, F-6, F-9, F-10; demonstrate: the rest).

### Learned
- pi-durable `submit` takes no transaction — budget spend is its own commit
  (DEC-078).
- pi `clearQueue` on abort drops queued extension messages; `agent_settled
  {aborted}` and `ctx.isIdle()` are the safe injection points (DEC-090).
- Room SATAN's bash runs as `satan` in the room VM; it cannot reach host
  sockets under /run/user/1000 (rulings r1).
- Lock needs a route on every severe RV finding — set `--route` at first
  disposition.
- Room daemon jail already binds `/run/user/1000/satan/durable/room` rw
  (`~/dev/satan/flake.nix:486`).

### Open
- PHASE-01 next: ASM-004..008 and real-pi probes, plus EX-10 (jail node
  type stripping for malebolge-bridge; new ASM to record). PHASE-02 waits
  on SL-010 landing.
- Posture texts are placeholder corpus prose (DEC-040) pending the
  satan-corpus session.
- CHR-007 awaits a ~/flakes session.

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

## Review passes (2026-10-29, reviewing)

Passes run on the design draft: pi first pass (18 findings, disposed on
scratch rulings r2), GPT gpt-6.1-sol on RV-021 (F-1..F-14 over rounds 3–4,
all fix-now, all verified by the raiser at run revision 41), pi verify-only
pass (6 table gaps, fixed). Trend 8 → 18 → 8 → 6 → verify; the last
findings were state-table gaps in the pi extension lifecycle, and its main
mechanism (DEC-090) was simplified rather than patched.

No further design pass is needed. What remains is better caught by
red/green tests and by the PHASE-01 probes (ASM-004..008; DEC-079/090 abort
probe; notify-send in jail). A further pass, if one were run, would probe
only `pi-bridge/state.ts`'s table against real pi event ordering — which
the PHASE-01 probes cover directly.
