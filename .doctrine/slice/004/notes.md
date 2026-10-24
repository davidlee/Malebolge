# Notes SL-004: Conversation context in the tool environment and system prompt

Durable per-slice scratchpad — tracked in git. The place to lift anything from a
disposable phase sheet (`.doctrine/state/.../phase-NN.md`) that must survive
`rm -rf` before the slice close-out audit harvests it.

## Research

`research/research.md` (gitignored, baseline restamped 2026-10-24). Thread 1
by pi (deepseek-flash), Thread 2 by hand after a gateway outage.

## Design run

### Triage (explore.triage)

Constraining governance: DEC-012 (task-owned conversations are not indexed),
DEC-013 (the index is the one source of topic/parent), DEC-015 (root is in
`default`), satan DEC-104/107 (stored `cwd` is authoritative), satan DEC-106
(room faults per daemon), CHR-002 (pi stays 1.4.0). RFC-002: the room env id
stays `pi-env:daemon-room`.

Consumer contract (`~/db/q` as pasted by the user, 2026-10-24): reads
`SATAN_HARNESS SATAN_PROFILE SATAN_TOPIC SATAN_CONVERSATION
SATAN_PARENT_CONVERSATION SATAN_CWD`; unset → NULL ("honest gap"); session
start is `q spawn`.

Open questions (design inquiries):

- Q-1 / inq-2. A separate `conversation` section, or fold into `cwd`?
  Proposal: separate — `cwd` keeps pi's wording, one fact per section.
- inq-5. `SATAN_CWD` when the agent has no `cwd`: proposal — the cwd the env
  is built with (`target.cwd ?? daemon cwd`), i.e. where tools actually run.

Shaping decisions (proposed):

- inq-1. One module `src/conversation-context.ts`: `contextOf(read, id)` reads
  the index entry; pure `conversationVars({profile, id, cwd, entry})`; the
  `conversation` section. Both outlets share one read and one mapping.
- inq-3. `shellEnv` at construction, no exec wrapper (research X-1);
  `observedEnv` gains an optional `shellEnv`; `daemonEnv` already holds the
  profile, so nothing new is threaded.
- inq-4. Index miss (task-owned, DEC-012): topic and parent unset, the rest set.

Risks / assumptions:

- ASM: one index snapshot read per env build (each tool call) is cheap —
  in-process sqlite, one document.
- Out of scope, follow-up: the runner's patch-job env
  (`src/runner/tenancy.ts:35`) could carry the same variables.

### Review (RV-012)

Adversarial pass: pi `review` profile (deepseek-flash), quotient run
`run-20261024T101840336Z-7-4c312f259bb8`. 9 findings, all disposed:
F-1 changed the design (DEC-021 amended to empty strings, user-accepted);
F-4 rejected (env id is the file namespace); the rest wording or impact-table
fixes.

Further pass (review.passes): none needed. The remaining risk is the room's
runtime behaviour, which no reading can settle; VH-1 probes it (all six
present with this conversation's values, and a `mem.origin` row from
`q who`). A second desk pass would re-read the same pi-durable/pi-env sources.

## Plan review (RV-013)

Adversarial plan+design pass, 2026-10-24: three pi `review` probes
(quotient run-20261024T111155349Z-9/-10/-11), each claim checked by the
orchestrator before raising. 10 findings, all verified by the raisers'
resumed sessions (-12/-13/-14). Design edited in place, not via the design
run (user direction). Outcomes:

- The room daemon is launched without a login shell; masking (DEC-021) is
  defence in depth, and the test fixture over-approximates production.
- A failed index read propagates and fails the tool task (user decision).
- PHASE-02 split; new PHASE-04 (room) runs before PHASE-03.
- Rejected: runner conversations (separate store and env hook); hook
  re-entrancy (pi-durable's buildEnv does the same read).

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-25 · /audit (RV-014 concluded; next /reconcile) · 9d996b2 + F-6 fix

### Produced

- DEC-018, DEC-019, DEC-020, DEC-021 (amended RV-012 F-1), DEC-022
- RV-012 (adversarial design pass, done)
- plan.toml / plan.md (four phases); RV-013 (plan+design pass, concluded); design VT-6
- IDE-002 (task-owned conversations' variables)
- PHASE-01 conversation context, 0a80895; PHASE-02 host shellEnv, 51c5dfb; PHASE-04 room shellEnv, 322cfdb; PHASE-03 prompt section + docs, 9d996b2. `just check` green on host at 9d996b2 (2083 tests); no `gate` recipe, so `doctrine check gate` is unconfigured.
- Plan deviations for /audit + /reconcile: PHASE-03 EX-2 predicted four assertion updates, but three were needed (the re-send case's `before` harness declares only persona+skills); PHASE-02 env hook type is pi-durable's wider `NonNullable<HarnessOptions["env"]>`; PHASE-04 VT-2 is a source-token check, its behavioural proof is VT-1. Beyond plan: test helpers lifted into `test/harness-fixture.ts`; `IndexReader`/`storedEntry` added to `src/topics.ts`; host and room env tests share one fixture.
- minted: IMP-011 — route topics.ts's remaining index reads through the own-key helpers
- RV-014 (reconciliation audit): F-1/F-2 design-wrong → its Reconciliation Brief; F-3/F-4 tolerated plan deviations; F-5 aligned; F-6 fixed (test harnesses closed in test/daemon-sections.test.ts)

### Learned

- Consumer contract: room `~/db/q` (see Triage above); `q spawn` is the session-start verb.
- pi-env drops undefined `shellEnv` values (RV-012 F-1) — basis of DEC-021.
- Merge order daemon env < `shellEnv` < per-exec `env` holds in the shipped pi-env daemon; empty strings survive transport (RV-013 F-1, by running it).
- An env-build throw ends the tool task `failed` (`harness/tool.js:309-329`); the prompt path degrades on its own.
- mem.pattern.malebolge.env-hook-test-idioms — stub readers, configured created conversations, inherited-env order in daemon env tests

### Open

- VH-1 (room runtime, user at the terminal) — design sec-6; /close confirms or records it outstanding (RV-014 Synthesis).
- satan side, out of scope: the `q spawn` reminder in `~/satan-corpus/prompts/env/room.txt`.
