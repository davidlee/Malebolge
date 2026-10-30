# Review RV-027 — reconciliation of SL-009

Adversarial-review ledger. Structured findings live in the sister
ledger toml; this prose companion carries the reviewer's framing.

## Brief

<!-- Pre-reading + lines of attack: what this review is probing, the invariants
     it must hold the subject to, and where the bodies are likely buried. Seeded
     at `review new`; the reviewer fills it before raising findings. -->

Mode: conformance (self-audit; one agent drives raiser and responder via `--as`).
Surface: primary checkout, main @ b62ba72. Not a dispatched slice; no candidate branch.
Only uncommitted change: `flake.nix` (the operator's local `jailed-pi-bridge`, runbook P3) — not SL-009 deliverable.

Evidence base:
- `just check` on the live tree at b62ba72: green, 115 files / 4170 tests, lines 97.5%, branches 94.05%.
- `doctrine check gate` cannot run: unconfigured, it proxies `just gate`, which the justfile lacks. `just check` is the project gate (CLAUDE.md, notes § Implementation run).
- `doctrine slice conformance 009`: undeclared 100, undelivered 2, conformant 44.
- notes.md § Autonomy log (every "flag for audit" line), § Probes (PHASE-01 VA/VH, PHASE-10 VH Outcomes + Result).
- DEC-095..098 (operator rulings during PHASE-08..10 that change design text).

Lines of attack:
1. Conformance algebra: split SL-009's own undeclared paths from other slices' commits inside recorded ranges; test each undelivered selector.
2. Design text vs code: every value or rule the autonomy log says was chosen locally ("flag for audit"), and every operator ruling (DEC-095..098), checked for a home in design.md.
3. Verification: design §9 rows vs the observed VT/VH evidence, esp. the real-jail row.
4. Residual risk: surviving mutants, untested paths, DEC-096's env consequence.
5. Docs: `docs/internals.md` and README carry the shipped behaviour, including the run's late fixes.
6. Ledger hygiene: open review ledgers targeting SL-009.

Invariants held: pi-bridge/ imports nothing from src/ (structure test); posture texts ship as placeholders by design (CHR-008 authors them); deployment contract is implemented in ~/flakes (CHR-007), not here.

## Synthesis

**Closure story.** SL-009 delivers what its scope promised: a room-only bridge socket with its own frame tables, pairing with a hashed token and supersede-by-newer, a durable acked outbox (SATAN → pi), idempotent pi → SATAN posts with a withdrawal notice, a per-pairing turn budget spent before submit, the `bridge` mode with talk-set-bounded wakes, the pi extension as a pure `step` table under a thin shell, and `malebolge-bridge send`/`tee`. Evidence: `just check` green at b62ba72 (115 files / 4170 tests, lines 97.5%); per-phase negative controls in notes § Autonomy log (PHASE-08: 17/17 killed, PHASE-09: 16/16); PHASE-01 real-pi probes; PHASE-10 real-jail VH run (pair, both postures both ways, ro mount refuses writes, connect failure notifies in pi, send/tee bare from pi's bash).

No blocker. Two majors, both design text lagging operator decisions taken in the VH run (F-1 DEC-095/096/097 → sec-7; F-2 DEC-098 → sec-3). The rest is design text catching up with local choices the log flagged (F-3, F-4, F-8), a selector registry that under- and over-declares (F-5, F-6), and three fix-now items done in this pass (F-9 docs, F-13 stray RV-023, F-14 a false comment).

One finding was withdrawn: F-10 took the PHASE-07 log's premise ("the host's bridgeHost never resolves, so an unguarded refill hook hangs host input") on trust. A probe disproved it — bridgeHost resolves on every profile, and an unconditional hook leaves a host daemon serving. The guard is harmless; its comment was false (F-14). Lesson: a "flag for audit" premise is tier-5 evidence; probe before raising on it.

**Standing risks.**
- Posture texts are DEC-040 placeholders until CHR-008 (by design; DEC-098's environment text now carries the facts).
- Deployment lives in ~/flakes (CHR-007), not yet built; its implementer must `mkdir -m 700` the bridge directory or `servePrivateUnix` refuses start (docs/internals.md clause 1).
- Desktop notification of an outage cannot work in the jail (ASM-005); the operator sees it only inside pi until IMP-025.
- A subverted pi can fake an operator refill (documented residual, DEC-070).
- `doctrine check gate` is unconfigured here (proxies a missing `just gate`); `just check` is the gate in use.

**Tradeoffs accepted.** F-7: range-based delta registry carries other slices' commits; split by commit in this audit. F-11: three surviving mutants with no wire-visible effect. F-12: `!` commands run on pi's `process.env` without pi's bin dir or `shellPath` (DEC-096).

## Reconciliation Brief

### Per-slice (direct edit)
- design.md sec-7 (F-1): add table row `outage | /bridge end → unpaired` with effects `settlePending`, close socket, unpaired marker, clear credentials/posture/bash env, info `ended locally`, no frame; pairing/resuming `/bridge end` refused busy (DEC-095). "Bash env": a `user_bash` handler applies the same env to operator `!` commands, base `process.env` (DEC-096). Status effect: also `powerbar:update`, segment `malebolge-bridge` registered at `session_start`, cleared with the status (DEC-097).
- design.md sec-3 "Posture" (F-2): SATAN's bridge section = untrusted framing, then (bridged only) `BRIDGE_ENVIRONMENT`, then posture text; pi's prompt = `PI_BRIDGE_ENVIRONMENT`, then posture text (DEC-098). Mirror in sec-7's `before_agent_start` bullet.
- design.md sec-7 (F-3): state the `persisted` event that drives the ack (skip without re-ack until persisted); connection generations (stale frames/closes/deadlines ignored; deadlines fed back as events); settlePending completes every pending post `outcome unknown` (drop "refused if not sent"); a drop while `end` is awaited = end unanswered; `refused pairing ended` answering `end` is an info `ended`.
- design.md sec-2/3/7 (F-4): sec-2 `BRIDGE_POST_WAIT_MS` = 30 s, `BRIDGE_LINE_MAX_BYTES` = 6 × body + 4 KiB (a capped body is never refused by the line cap), unknown keys refused, `bridge` section key untagged (tag collides with the envelope); sec-3 accessors `pairingDoc` (commit), `pairingSnapshot` (read-only; a refused resume writes nothing), `watchPairing`; sec-7 `malebolge-bridge` exits 2 also on a local refusal (no env vars, bad args), `send` prints `accepted`, `tee` no ack.
- selector registry (F-5): `doctrine slice selector add 009 <path> --intent design-target` for flake.nix, README.md, package.json, biome.json, tsconfig.json, vitest.config.ts, src/runner/control.ts, test/pi-bridge-fake-daemon.ts, test/pi-bridge-fake-pi.ts, test/conversations.test.ts, test/daemon-start.test.ts, test/persona.test.ts, test/queue-premises.test.ts, test/unix-socket.test.ts, test/wake-fixture.ts. Mirror: design.md sec-8 adds flake.nix (runner `npmDepsHash`, pi-bridge in fileset/installPhase), `pi-bridge/{notices,connection,posture,shell,command}.ts`, and the test fakes.
- selector registry (F-6): `doctrine slice selector rm 009` test/pi-bridge-state.test.ts and test/pi-bridge-wire.test.ts (shadowed by `test/pi-bridge-*.test.ts`).
- design.md sec-9 "real jail" (F-8): a stopped daemon notifies inside pi; desktop notify-send is best-effort and fails in the jail (ASM-005; IMP-025).

### Governance/spec (REV)
- none. DEC-095..098 are accepted records whose consequences name design.md only; no ADR, policy, standard or spec governs SL-009.

### Done in audit (fix-now, land with the audit commit)
- F-9 docs/internals.md § Bridge, README "Pairing a jailed pi": DEC-096/097/098.
- F-13 RV-023 concluded.
- F-14 src/daemon-start.ts `operatorRefillOf` comment.

## Reconciliation Outcome

### Direct edits applied (design.md; operator agreed 2026-10-30)
- sec-7 (F-1): rows for `/bridge end` in outage (unpair locally, info `ended locally`, no frame) and in pairing/resuming (busy) per DEC-095; `user_bash` env for operator `!` commands (DEC-096); status also a `powerbar:update` segment (DEC-097).
- sec-3 "Posture" + sec-7 `before_agent_start` (F-2): untagged section order untrusted framing → `BRIDGE_ENVIRONMENT` (bridged) → posture; pi `PI_BRIDGE_ENVIRONMENT` → posture (DEC-098).
- sec-7 (F-3): `settlePending` completes every pending post `outcome unknown`; connection generations; deadlines and `persisted` as events; `persisted` row acks; injected-not-persisted deliveries skipped without ack; end-awaited drop/deadline = end unanswered; `refused pairing ended` answering `end` = info `ended`.
- sec-2/3/7 (F-4): `BRIDGE_POST_WAIT_MS` 30 s; `BRIDGE_LINE_MAX_BYTES` 6 × body + 4 KiB; unknown keys refused; untagged `bridge` section; accessors `pairingDoc` / `pairingSnapshot` / `watchPairing`; `malebolge-bridge` exit 2 on local refusal, `send` prints `accepted`, `tee` no ack.
- sec-8 (F-5 mirror): rows for `pi-bridge/{shell,connection,notices,posture,command}.ts`, `flake.nix`, the pi-bridge test fakes; `index.ts` relabelled as the entry.
- sec-9 "real jail" (F-8): stopped daemon notifies inside pi; desktop `notify-send` best-effort, fails in the jail (ASM-005, IMP-025).
- design run is locked: per the CLI, reconcile edits design.md directly and does not `design adopt`.

### Selector registry
- F-5: 15 paths upserted with intent `design-target`.
- F-6: `test/pi-bridge-state.test.ts`, `test/pi-bridge-wire.test.ts` removed (shadowed by `test/pi-bridge-*.test.ts`).
- `doctrine slice conformance 009`: undelivered 0, conformant 59; undeclared 85 = doctrine records and other slices' commits (F-7, tolerated).

### REVs completed
- none: no governance/spec item in the brief.

### Withdrawn / tolerated
- F-10 withdrawn; F-7 tolerated (see dispositions). F-9, F-13, F-14 landed fix-now in e3cf8ff.

Reconcile pass complete — handoff to /close.
