# Review RV-014 — reconciliation of SL-004

Adversarial-review ledger. Structured findings live in the sister
ledger toml; this prose companion carries the reviewer's framing.

## Brief

<!-- Pre-reading + lines of attack: what this review is probing, the invariants
     it must hold the subject to, and where the bodies are likely buried. Seeded
     at `review new`; the reviewer fills it before raising findings. -->

Mode: conformance, self-audit. Surface: primary tree of `~/dev/malebolge`,
`main` at 7fc7f28 (implementation 67208d0..9d996b2; not dispatched).

Lines of attack:

1. Path conformance: `doctrine slice conformance 004` — every undeclared or
   undelivered path dispositioned.
2. The six-key invariant (RV-012 F-1): `conversationVars` never omits a key or
   yields `undefined`; masking proven on both profiles by printing
   `[${SATAN_TOPIC}]` as `[]`.
3. Design sec-2..sec-6 against the code: hook type, `conversationEnv`'s cwd
   fallback (DEC-022), env id `pi-env:daemon-room` for every conversation
   (RFC-002), failed index read propagates (RV-013 F-2), section untagged after
   `cwd` (DEC-019), `src/runner/` untouched.
4. Plan EX/VT: `doctrine slice verify-vt 004`; plan deviations named in the
   notes Harvest.
5. Gate: `just check` on the host (no `gate` recipe, so `doctrine check gate`
   is unconfigured).
6. Second-pass code read by a delegate (quotient `review` profile, run
   run-20261024T130914542Z-33); its leads checked here before raising.

## Synthesis

SL-004 delivers what design sec-1..sec-6 describe. Each conversation's tools
run with all six `SATAN_*` variables, set per env build through `shellEnv`. The
prompt carries an untagged `conversation` section after `cwd`. Evidence:

- Gate: `just check` green on the host at 9d996b2 (71 files, 2083 tests,
  coverage 98.41% lines). `doctrine check gate` has no `gate` recipe to run.
- `doctrine slice verify-vt 004`: 8 of 9 VTs pass. PHASE-01 VT-2 fails on a
  keyword only (F-4, tolerated).
- `doctrine slice conformance 004`: 10 conformant paths, none undelivered, 5
  undeclared. All five are in scope and intended; the design lags them (F-1).
- The six-key invariant (RV-012 F-1, the slice's main risk) holds in the code
  (`src/conversation-context.ts`, with its warning comment) and in behaviour.
  On both profiles an inherited `SATAN_TOPIC` prints as `[]` while an
  unrelated inherited variable still arrives. The room test runs pi-env's
  real local daemon behind a fake `ssh`.
- A failed index read rejects the env build on both profiles (VT-6). The env
  id stays `pi-env:daemon-room` for every conversation. `src/runner/` is
  untouched.

No code defect of substance. The delegate's second pass found none either. It
raised two leads: unclosed test harnesses (F-6, fixed now) and a
registration-time env snapshot in `envFixture`. The snapshot is taken before
any test body runs, so it holds the pristine values; not raised.

Standing risks:

- **VH-1 is unrun.** Room runtime, the user at the terminal, after deploying
  this build. It is the only proof that `~/db/q` writes a `mem.origin` row
  with these values. /close must confirm it or record it as outstanding.
- One index snapshot read per env build and per prompt preparation (RV-012
  F-3). Accepted, unmeasured; no memoisation.
- `inheritEnv: false` execs and per-command sourced scripts (`$BASH_ENV`)
  bypass `shellEnv` (design sec-2). Accepted.
- Out of scope, owned elsewhere: the `q spawn` reminder in
  `~/satan-corpus/prompts/env/room.txt` (satan), IDE-002 (task-owned
  conversations), IMP-011 (the remaining index reads in topics.ts).

Tradeoffs accepted: plan criteria are immutable, so F-3 (assertion count) and
F-4 (VT keyword) stay as recorded deviations rather than plan edits. PHASE-04
VT-2 stays a source-token check, with VT-1 as the behavioural proof (F-5).

## Reconciliation Brief

### Per-slice (direct edit)

- F-1, selector registry (load-bearing for conformance): `doctrine slice
  selector add` design-target selectors for `src/topics.ts`,
  `test/harness-fixture.ts`, `test/conversations.test.ts`,
  `test/daemon.test.ts`, `test/topics.test.ts`. Re-run `doctrine slice
  conformance 004` and expect 0 undeclared.
- F-1, design.md sec-5 (mirror): add a `src/topics.ts` row: `IndexReader`,
  and `storedEntry` beside `storedTopic` over one own-key helper. Correct the
  bullet "reads through `readIndex` only" to "through `readIndex` and
  `storedEntry`". Extend the `test/harness-fixture.ts` row with the helpers
  lifted there (`closing`, `openIndexedHarness`, `createConversation`,
  `createTaskOwned`, `forkConversation`, `stubTask`), and note that the three
  test files lost their copies.
- F-2, design.md sec-3: quote the hook as pi-durable's `(target: EnvTarget,
  context) => ExecutionEnv | undefined | Promise<ExecutionEnv | undefined>`
  (`harness/types.d.ts:566`), typed `NonNullable<HarnessOptions["env"]>` in
  `src/session.ts`, with both arms always returning an env.
- Edit design.md in place; do NOT run `doctrine design materialise` on SL-004
  (the design was edited after lock).

### Governance/spec (REV)

- None. SL-004 touches no ADR, policy or spec. SPEC-001 and SPEC-002 live in
  the satan repo, and neither names the tool environment's variables.
