# Notes SL-009: Session bridge: a jailed pi session and a malebolge conversation exchange messages

Durable per-slice scratchpad — tracked in git. The place to lift anything from a
disposable phase sheet (`.doctrine/state/.../phase-NN.md`) that must survive
`rm -rf` before the slice close-out audit harvests it.

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-29 · ready (plan PHASE-01..10, none started) · 8fca207

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

- PHASE-01 VT-1: pi `implement` (deepseek-flash), 36 requests, $0.035: ASM-006 test + negative control, green first pass. Miss: placed the block mid-file (moved to end); `npx biome` crashes in-form, used flake biome.
- PHASE-01 VA-1: Claude Sonnet capsule-worker (host; pi/nix not in the quotient form): 5 real-pi rpc probes with a fake provider, all premises held; rerun by the orchestrator reproduced them.

## Implementation run (2026-10-29, super-orchestrator)

Seat: super-orchestrator in the main worktree. Scope this run: PHASE-01
only; PHASE-02 waits for SL-010 on main (SL-010 being driven by another
session; leave `.doctrine/slice/010/` and its src/ changes alone).

- Host gate: `just check` (fmt-check, lint, typecheck, test) — green at
  c4204c0. Commit only the paths a phase changed (`git commit <paths>`).
- quotient forms (`.quotient/forms/{read,write}`): write form runs every
  gate recipe and the full suite green (104 files / 3542 tests); network
  available. **No `pi`, no `nix` in the form**: real-pi probes run on the
  host (Claude workers), not pi workers.
- Host pi: `~/.nix-profile/bin/pi` 1.4.0 (llm-agents package, same input
  the jail uses); source at `~/.local/src/pi` @ 936e5f40a.
- Jail: `~/flakes/agents/jailed-agents.nix`. Its `commonPkgs` has
  libnotify but no nodejs. Operator ruling (2026-10-29): runtime deps the
  bridge needs in the jail belong in ~/flakes' agents flake, not this
  repo's flake. Flake edits need operator assent before they're made.
- Other writers: SL-010's session (src/, `.doctrine/slice/010/`); untracked
  `.doctrine/review/024*` belong to SL-008's audit — not ours.

## Probes (PHASE-01, 2026-10-29)

pi probed: `~/.nix-profile/bin/pi` 1.4.0, source `~/.local/src/pi` @ 936e5f40a.
Stubs and drivers live in `.doctrine/slice/009/probes/` (not src/, not
pi-bridge/: EX-9); copy a directory to a scratch dir before running it, since
the drivers write `work/` and logs beside themselves.

### VA-1: host probes (agent-run)

Rig (`probes/va1/`): `drive.mjs <probe>` spawns
`pi --mode rpc --no-session -e stub.ts --provider fake --model fake-1 --offline`
with `PI_CODING_AGENT_DIR=va1/agentdir` (operator's `~/.pi` neither read nor
written; `agentdir/settings.json` sets `retry.baseDelayMs` 200). `stub.ts`
registers a deterministic fake provider (`pi.registerProvider`), can delay in
`before_agent_start`, fails once with `503 service unavailable (stub)` (pi's
retryable pattern, `packages/ai/src/utils/retry.ts:33`), and implements DEC-090's
buffer (deliver iff `ctx.isIdle()` and not running; else buffer; flush on
`agent_settled`, turn as `triggerTurn: !aborted`). "Esc" = rpc `abort`.
Rerun all: `sh run-all.sh`. Stub logs of the 2026-10-29 run:
`probes/va1/evidence/<probe>.stub.jsonl`. Rerun by the sub-orchestrator
reproduced every outcome.

| EX | premise | outcome | decisive evidence |
|---|---|---|---|
| EX-1 | ASM-004 (idle paths) | validated | `triggerTurn:false`: entry + details present at return (n 0→1). `triggerTurn:true`: absent at return and after a microtask; present at the consuming `turn_end` (n=2) |
| EX-5 | RV-021 F-1 | validated | `before_agent_start` delayed 1.5 s: there `isIdle()` false, running false; delivery buffered; rpc `get_state` `isStreaming:true, pendingMessageCount:0`; abort → `agent_settled {aborted:true}`; flush as note, one entry |
| EX-6 | RV-021 F-9 | validated | rpc order `agent_end`(error) → `auto_retry_start` → `agent_start` → `auto_retry_end` → `agent_end`(stop) → `agent_settled`; `agent_settled` once, last, `aborted:false` |
| EX-7 | DEC-090/079 abort probe | validated | busy note buffered, abort, settle: one entry, no new `agent_start`. `ex7b`: a buffered *turn* after abort lands as a note (`triggerTurn:false`, no run); without abort it starts one run and appears once |

Observations for the design (none invalidates a premise):

1. `sendMessage(triggerTurn:true)` while idle fires `before_agent_start` and
   flips `ctx.isIdle()` false synchronously inside the call, while the
   extension's own running flag (set on `agent_start`) is still false. The
   `isIdle()` check is the load-bearing guard; the running flag alone is not.
   Consistent with the RV-021 F-1 fix (check both at every deliver).
2. An abort during a non-abortable `before_agent_start` handler takes effect
   only when the handler returns; `agent_settled` then reports `aborted:true`
   without calling the provider. The bridge's `before_agent_start` (posture
   rendering) must stay fast.
3. `sendMessage(triggerTurn:true)` inside an `agent_settled` handler is deferred
   by pi (`_deferredSettledActions`) and starts a new run after settle, which
   gets its own `agent_settled`. The flush-on-settle shape works as designed.
4. ASM-004's validation plan also named "kill pi between queueing and
   persistence; daemon redelivers": that is daemon behaviour (outbox resume),
   covered by later phases' tests, not by EX-1.

### VT-1: ASM-006 (agent-run)

`test/queue-premises.test.ts` "ASM-006: a write with model content on an idle
conversation": validated; negative control (the note sent as `input`) fails
the zero-model-calls assertion. ASM-006 settled validated.

### VH-1: operator in-jail probes (done 2026-10-29)

Kit: `probes/vh1/sl009-probe/` (`index.ts` stub: TypeBox tool `sl009_echo`,
bash replaced via `createBashTool` spawnHook setting `SL009_PROBE=1` and
prepending the stub dir to PATH; `sl009-hello` bare executable; `sl009-wire`
extensionless `#!/usr/bin/env node` script importing `./wire.ts`). Host smoke:
the stub loads in pi 1.4.0 (typebox and `createBashTool` resolve under `-e`);
`sl009-wire` runs on host node v24.21.0, no flags, from any cwd.

Jail facts (read-only look at `~/flakes/agents/jailed-agents.nix`, ~/flakes
@ 08c0f37d): persisted home `~/.local/share/jail.nix/home/<home>` is bound at
`$HOME` (`agent` for specDev, `agent-research`, `agent-offline`, or a
`persistedHome`); `commonPkgs` has `libnotify`, no `nodejs`; pi 1.4.0 is a
compiled ELF and adds no `node` to PATH (malebolge's own jails get
`nodejs_24` via `shellPkgs`; other projects' pi jails do not); no D-Bus bind
and no `DBUS_SESSION_BUS_ADDRESS` (only `XDG_RUNTIME_DIR` with
`satanMcpOptions`).

Runbook (operator; `<H>` = the jail's persisted home on the host):

0. EX-10 needs node in the jail: apply the proposed ~/flakes change (node in
   pi jails) first, or run EX-10 in malebolge's own `jailed-pi`, which has
   `nodejs_24` (that validates the script, not other projects' jails).
1. Install: `cp -r .doctrine/slice/009/probes/vh1/sl009-probe <H>/.pi/agent/extensions/`
   (remove it afterwards). Start the jailed pi; expect the notify
   "sl009-probe loaded from …".
2. EX-3 (ASM-007): ask pi to call `sl009_echo` with `hi`; expect `sl009:hi`.
   Load failure (cannot resolve typebox) → invalidated.
3. EX-4 (ASM-008, F-6): ask pi to run, via bash, `cd /tmp && echo $SL009_PROBE && sl009-hello && ls -d "$PWD" && echo ok >&2; exit 3`.
   Expect `1`, `sl009-hello ran: SL009_PROBE=1 cwd=/tmp`, the stderr line and
   exit status 3 reported (built-in behaviour kept).
4. EX-10 (ASM-009): via bash, `cd /tmp && sl009-wire`; expect
   `sl009-wire ran on node v2x…: {"text":"xxxxx…xxxxx","truncated":true}` and no
   flag. `env: 'node': No such file` or a type-stripping error → invalidated.
5. EX-2 (ASM-005): via bash, `notify-send sl009 "jail probe"`; record whether a
   desktop notification shows or the error text (expected: fails, no bus).
   Failure is acceptable (DEC-073); a bus bind would be a CHR-007 item.
6. Report each outcome; the agent records ASM-005/007/008/009 and flips
   PHASE-01 completed.


Outcomes (operator, 2026-10-29; recorded on the ASMs):
- EX-3 / ASM-007 validated: `sl009_echo hi` → `sl009:hi`.
- EX-4 / ASM-008 (RV-021 F-6) validated: `1`, hello line with `cwd=/tmp`, `/tmp`;
  stderr `ok`; exit 3 reported.
- EX-10 / ASM-009 validated: `sl009-wire` on node v26.12.1, no flags. That
  jail's node came from its project, so node in every pi jail stays a
  ~/flakes concern (proposed diff, assent pending).
- EX-2 / ASM-005 invalidated, as EX-2 allows: notify-send exit 1, no D-Bus
  (glib machine-id missing). DEC-073 floor stands; no /consult needed.

## Autonomy log

- PHASE-01: probe stubs and drivers kept in `.doctrine/slice/009/probes/` (beside notes) instead of only the scratchpad, so VH-1 and reruns survive the session; outside src/ and pi-bridge/, unlinted, untested (EX-9 intent kept). Tier: decide.
- PHASE-01: VA-1 probes used a stub-registered fake provider instead of a reachable model; deterministic, no credentials, retryable error forced as EX-6 allows. Tier: decide.
- PHASE-01: EX-10 premise recorded as ASM-009 (held; host evidence only). Tier: decide.
- PHASE-01: VH-1 needs node in non-malebolge pi jails: proposed ~/flakes diff handed back for operator assent, not applied (outward reach). Tier: escalate.
- PHASE-01: ASM-005 invalidated but pre-ruled acceptable by PHASE-01 EX-2 and DEC-073; PHASE-01 closed without /consult. decided
- PHASE-01: ~/flakes agents/jailed-agents.nix gains `lib.optional piInJail pkgs.nodejs_24` (+ test in jailed-agents-test.nix, red-checked); operator assent 2026-10-29 ("you can make this edit"); left uncommitted in ~/flakes for the operator. decided
- PHASE-02 EN-2: operator 2026-10-29 "it's ready for audit after a VH" — SL-010 code complete on main (2538398); topicInit, ModelCatalog, ModelsMessage, modelRefs present. SL-010's audit may still touch src/; treat its edits as another writer. decided
