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

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: <yyyy-mm-dd> · <PHASE-NN | stage> · <head-commit>

### Produced

### Learned

### Open
