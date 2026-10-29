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

- PHASE-02 (sub-orchestrator): pi `implement` x2 (deepseek-flash). T1 contract tests VT-1/VT-2, red shown, $0.029; T2 moves, gate-green first try, $0.031. Misses: none material; tests duplicate the refusal-message expression (left). Negative controls by me: drop uid check -> VT-1 uid case fails; drop require hook -> VT-2 fails.

- PHASE-03 (sub-orchestrator): pi `implement` x2. T1 contract tests (VT-1..4), red shown, self-checked against a throwaway impl, $0.054; T2 code + config, gate-green first try, 58 requests, $0.148. Misses: capTail reversed the whole string by code points (I replaced it with a byte-wise step); string-key checks were only tested with a number (a "non-number passes" negative control survived) - I added null/object/boolean/2^53 cases. Negative controls by me: drop tail boundary step -> 5 fail; loose string check -> 3 fail.

- PHASE-04 (sub-orchestrator): pi `implement` x2. T1 tests (toolsets, persona, daemon-sections, wake reach), red shown, $0.058; T2 code, gate-green first try, $0.035. Misses: one misleading catalogue comment (rewritten). Negative controls by me: drop reach check -> 3 fail; drop self-skip -> 1 fail.
- PHASE-05 (sub-orchestrator, partial): Sonnet capsule-worker T1 contract tests + fixture (71 tests, self-checked against 12 mutants of a throwaway impl); pi `implement` T2 code, $0.105, gate-green except 7 lint errors in the Sonnet test files (fixed by me). Verified by me after HOLD; 15c2a6f.

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
- PHASE-02: topicInit's hooks type named `CreationHooks` (replaces `StartedThread`, both fields optional); servePrivateUnix throws its own `PrivateDirectoryRefused` (unix-socket.ts cannot import runner/errors), control maps it to StartRefused with the same text; connection-reply's state is a structural `Replying {socket, ended}`. Names not in the design; local, flag for audit. Tier: decide.
- PHASE-02: VT-1's other-uid case spies `process.getuid` (no chown without root). Tier: decide.
- PHASE-03: BRIDGE_POST_WAIT_MS = 30 s (design names no value); BRIDGE_LINE_MAX_BYTES = 6 x body + 4 KiB (JSON escapes a byte to at most 6, so the line cap never refuses a capped body); parser strict on unknown keys; refusal reason texts fixed in pi-bridge/wire.ts and pinned by test/pi-bridge-wire.test.ts. Tier: decide.
- PHASE-03: design sec-8 omitted flake.nix. The dev dependency changes package-lock.json, so the runner package's npmDepsHash changed; src/truncate.ts now imports pi-bridge/wire.ts and the runner reaches truncate.ts, so the runner fileset and installPhase copy gained pi-bridge(/wire.ts). Built `.#runner` and `checks.runner-starts` green on host. Read the "flake edits need operator assent" ruling as ~/flakes (the jail); this is this repo's own package, mechanical consequence of planned EX-1/EX-4. Local design correction, flag for audit. Tier: decide (flagged).
- PHASE-03 (seat): this repo's flake.nix runner change (npmDepsHash, pi-bridge in fileset) is in scope — the 'flake edits need operator assent' ruling covers ~/flakes only. Kept; flagged for audit. decided
- PHASE-04: wake reach refusal for a missing index entry reads `topic <t>: conversation <id> has no index entry` (caller checked first); the talk-set refusal is requireSameTalkSet's text with label `topic <t>`. Design names no text; local, flag for audit. Tier: decide.
- PHASE-04: the no-index-entry test target is a conversation created after startup without topicInit (hook entry with no toolset, which storedEntry reads as none). Tier: decide.
- PHASE-05: contract fixed in `.doctrine/state/slice/009/briefs/phase-05-contract.md`: pairing doc "absent" = tokenHash "" sentinel, `fork: "initial"` (a fork is not bridged); checkToken checks the token before `ended`; unfilled rows (post, ack, refill, post-once) refuse `<type> is not implemented yet` (PHASE-06/07 rewrite those tests; design says ack has no reply); other-toolset refusal `topic <name> has toolset <t>, not bridge`; `create` exported from src/conversations.ts for pair. Local, flag for audit. Tier: decide.
- PHASE-05: HOLD (coordinator, gateway down) at 2026-10-29: tests (Sonnet) + code (pi) in tree uncommitted, `just check` green (107 files/3799 tests); I fixed 7 test lint errors. NOT yet done: my read of listener.ts/pairing.ts (token, socket mode), negative controls, commit, flip completed. Tier: decide.
- PHASE-05: resumed after HOLD; T3 done by me: trust-boundary read of listener.ts/pairing.ts (token never stored/logged, sha256 + timingSafeEqual, servePrivateUnix only), negative controls on the real code (token always-match -> 4 fail; fork current -> 1; no supersede -> 2; serveUnix -> 45; no toolset require -> 1; bound ended unchecked -> 1), `just check` green; committed 15c2a6f. For audit: resume's check and the bound ended re-read run in write commits (`harness.commit`), so a resume naming a plain conversation materialises its initial (unbridged) pairing doc; a snapshot read would avoid that write. Stop order closes daemon.sock before bridge.sock (not strictly the reverse of start). Tier: decide (flagged).
- PHASE-05 (seat): a refused resume of a non-bridged conversation must not write; the per-frame ended re-read and resume move to a read-only snapshot as PHASE-06's first commit (local fix, in envelope). decided
- PHASE-05 follow-up (seat ruling): resume and the per-frame ended re-read read `pairingSnapshot` (harness.snapshot, no commit), a second read accessor beside `pairingDoc` in src/bridge/pairing.ts; red test "a refused resume of a plain conversation writes no pairing document", negative control (ended re-read disabled -> 1 fail), `just check` green (107 files/3800 tests); committed 1ed42f6. Second accessor is a small extension of EX-1's "one accessor"; flag for audit. Tier: decide.
- PHASE-06: HOLD (coordinator, gateway cycling) before /phase-plan; phase still `planned`, no pi run started, nothing uncommitted in src/ or test/. Draft contract in `.doctrine/state/slice/009/briefs/phase-06-draft-contract.md`. Next: phase sheet, flip in_progress, test worker (VT-1..3) then code worker. Tier: decide.
- PHASE-06: contract fixed in `.doctrine/state/slice/009/briefs/phase-06-contract.md` (supersedes the draft): appendOutbox refuses `not a bridged conversation` first; bridge_post throws its refusal inside the commit (nothing written); success text `sent #<seq>`; the section key `bridge` is UNTAGGED (pi-durable wraps a tagged section as `<bridge>…</bridge>`, the untrusted envelope's own tag); ack has no reply, an unknown seq is silent; watchPairing added beside pairingSnapshot. Local, flag for audit. Tier: decide.
- PHASE-06: HOLD (sub-orchestrator) after flipping in_progress: both pi runs (T1 tests, then the retry a minute later) failed at the first request with DeepSeek 402 `Insufficient Balance`; not a gateway cycle, so no further retry and no switch to Claude. Nothing in src/ or test/ changed. T1 brief ready: `.doctrine/state/slice/009/briefs/phase-06-t1-tests.md`. Tier: escalate.
- PHASE-06: resumed after top-up. T1 tests (pi implement, $0.08, 18 red for the right reasons), T2 code (pi implement, $0.05). T2 found a test defect: `answersProbe` read the next frame by index, so pushed deliver frames sat ahead of the probe's reply; I made `answersProbe` skip deliver frames (any other frame ahead of the probe still fails). Tier: decide.
- PHASE-06: negative controls (mutate, run the 4 files, restore): cap dropped 2 fail; echo text 2; bind delivers only new 3; ack without commit 2; posture swap 2; not-bridged check dropped 2; tagged section 4; redeliver all 4. Survivors: the close handler's `watch.stop()` and `deliver`'s `state.ended` guard (singly and together, 0 fail): `finish` ends the socket and `write` checks `socket.writable`, so neither is observable on the wire; the unstopped watch is a leak, not a wrong frame. Accepted as defence in depth; flag for audit. Tier: decide.
- PHASE-07: single phase, no split (budget shares the post's spend commit). Contract `.doctrine/state/slice/009/briefs/phase-07-contract.md`: BridgeHost gains satan/log/now; Listener holds the watch map (never pruned, budget-bounded); post-once starts no withdrawal watch (no message id, DEC-075); refill row has no reply; notice-undeliverable log/notify texts fixed there; untrusted-block.ts's renderBlock is a JSON-lines block, not this envelope, so escapeXml is used (DEC-054 "where it fits"). Local, flag for audit. Tier: decide.
- PHASE-07: onOperatorInput is passed for the room only: the pi worker wired it unconditionally, which would hang every host-profile input on a bridgeHost that never resolves; I made it room-only (`operatorRefillOf`). No test pins the host-profile case; flag for audit. Tier: decide.
- PHASE-07: pi T1 tests ($0.13, two runs), T2 code ($0.08, hit ceiling), lint/refactor ($0.06, two runs). I fixed two test defects: the duplicate test read callCount before the run (now waits for done); delivered-incomplete used abortSubmission on a placed submission (`already_placed`), now aborts the conversation and releases the held step. "One submission for the requestId" is evidenced by submissionByRequest + spent + model call count (Harness has no settled-submission scan). Tier: decide.
- PHASE-07: negative controls (mutate, run inbound/pairing/listener, restore): no dedupe 3 fail; no watch map 1; body unescaped 2; no cap 1; no notify 2; no spend 6; refill no-op 2; operator hook removed 1. Survivor: whenBusy steer instead of followUp (0 fail): with a one-step faux run, steering and a follow-up run are indistinguishable on the wire/model inputs. Accepted; flag for audit. Gate: `just check` green on an export of dd6ae25 (109 files / 3848 tests); the live tree's other writers' uncommitted mail/stdin-env work fails lint and one mail test, not ours. Tier: decide.
- PHASE-08: EN-2 checked against sec-7 before coding: probes EX-5/EX-6/EX-7 match the table's assumptions (isIdle false before agent_start; agent_settled once, last, carries aborted). Tier: decide.
- PHASE-08: contract `.doctrine/state/slice/009/briefs/phase-08-contract.md`, types written by me in pi-bridge/state.ts. Local design clarifications, flag for audit: (a) a `persisted` event (the shell reports an injected entry is in the session) drives the ack, and an injected-not-persisted seq is skipped without re-ack (ASM-004: ack once the entry is in the session); (b) connections carry a generation `conn`, so stale frames/closes/deadlines are ignored; reply deadlines are effects fed back as events; (c) every pending post has been sent (posts are accepted only while bound), so settlePending always completes `outcome unknown` and sec-7's "refused if not sent" has no reachable case; (d) `/bridge end` while pairing/resuming/outage is refused busy (sec-7 names no row; an operator in a long outage cannot end locally); (e) a drop while an end is awaited = end unanswered (unpaired with marker, loud, no re-pair); (f) end's answer `refused pairing ended` is an info `ended`, not a loud refusal. Tier: decide (flagged).
- PHASE-08: pi T1 tests ($0.08), T2 code ($0.09). pi misses: a deadline-post fixture omitted a post (T2 caught it and stopped, as briefed); T1 wrote F-9 as a one-step no-op and no F-1 sequence, so I added both sequences, an F-5 case from a non-initial phase, and made F-10's settle not-aborted. My review found the forked session_start kept the prior phase (safe only from the initial state); fixed. Refactor: askEnd shared by /bridge end and bound /bridge pair. Tier: decide.
- PHASE-08: negative controls (mutate state.ts, run, restore byte-identical): 17 mutations, all killed (settle none 12; outage notify each failure 1; refill any phase 1; no recovery 1; ignore isIdle 2; ignore running 1; flush all 1; aborted triggerTurn 2; agent_end flushes 2; no re-ack 2; no session dedupe 2; fork resumes 2; fork keeps phase 1; deadline not mayHaveCreated 1; supersede marker 2; no resend 2; post deadline keeps pending 2). Gate: `just check` green on a `git archive` export of 9a779e2 (111 files / 3964 tests); the live tree has other writers' untracked src/mail work, not ours. Tier: decide.
- PHASE-08/09 (operator ruling 2026-10-30, "unpair locally"): `/bridge end` during outage unpairs locally (pi drops the pairing marker; the daemon's pairing document is left as is) instead of being refused as busy. Design sec-7 gains this row; implemented in PHASE-09 against pi-bridge/state.ts. /reconcile folds it into design.md. decided (operator)
- PHASE-09: operator ruling applied as its own commit d5ff906 (state.ts row + test, red first): outage | end -> settlePending, close, unpaired marker, env cleared, info `ended locally`; no frame. Pairing and resuming stay busy (an in-flight pair/resume reply would otherwise land on a session that already gave the pairing up; busy is the safe default). sec-7 table delta for /reconcile: row "outage | /bridge end -> unpaired locally". Tier: decide.
- PHASE-09: no split (VT-5's pi->SATAN note and F-6 need the command). Contract `.doctrine/state/slice/009/briefs/phase-09-contract.md`, stubs/signatures by me: pi-bridge/{notices,connection,posture,shell,command,index}.ts + malebolge-bridge. Local choices, flag for audit: CLI with no MALEBOLGE_BRIDGE_* vars, or bad args, exits 2 (local refusal; design lists only 0-3); `send` prints `accepted`, `tee` prints no ack; pi-direction inject content is the delivery text as-is (design names no framing that way); notify-send fires for outage notices only (and the command's connect failure); topic in notices = `<project>-bridge`. Tier: decide.
- PHASE-09: pi runs (deepseek-flash, implement): T1 command tests $0.06, T2 notices/connection/command $0.06, T3 shell tests $0.15, T4 shell $0.08 (total ~$0.35, 4 runs, none hit the ceiling). pi misses I fixed: T1's real-script test spawned with no argv and T2 made empty argv mean `send` (contract: usage, exit 2) — test now passes `send`, parser tightened; T4's `bridgeEnv` left a trailing `:` when PATH is unset (an empty PATH element is the cwd) — now the dir alone, test pinned; dead connections stayed in the shell's map — removed on close; connection.ts kept reading lines after a handler closed mid-chunk — guarded. Added tests: outage `/bridge end` through the shell; interactive-only refill (was a surviving mutant). Tier: decide.
- PHASE-09: negative controls (mutate, run the three pi-bridge test files, restore): 16 mutations, all killed after the refill test was added (outage end busy 2; env keeps inherited vars 1; no desktop 1; shell deadline x2 3; idle always 1; no persisted 4; input any source 1; no PATH prefix 4; posture always delegate 1; tee no copy 1; no cap 1; connect failure as unknown 1; cmd deadline x2 1; ends omit conversation 1; close ignored 3). Host smoke with real pi 1.4.0 (`-e pi-bridge/index.ts`, rpc, fake provider): loads, `/bridge` notices as expected. Gate: `just check` green on a `git archive` export of af200b5 (115 files / 4054 tests, lines 97.5%). record-delta range d5ff906^..af200b5 includes two SL-007 commits (b4caa4b, 107abce) between ours: flag for audit. Tier: decide.
