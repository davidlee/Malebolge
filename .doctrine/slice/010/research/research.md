# SL-010 research — per-topic model, topics in the Emacs chooser

## Header

- Round 1, 2026-10-29. Baseline: `baseline.toml` (stamped by
  `doctrine slice research 10`).
- Producers (quotient pi `research` profile, deepseek-flash, read-only):
  - **Thread 1 governance**: decision records, SL-003/005/006 designs, and the
    staged flakes:DEC-093 (`.doctrine/state/slice/010/flakes-DEC-093.md`).
    Raw: `raw/governance.md`.
  - **Thread 2 code map**: this repo, plus the staged live gateway catalog
    (`.doctrine/state/slice/010/gateway-models.json`). Raw: `raw/code-map.md`.
  - Orchestrator (Opus): verification greps (✓ rows); pi-durable / pi-ai
    README reads on model changes (session, before the round).
- Operator inputs, 2026-10-29 (session): new conversations only; set by CLI
  and Emacs, no SATAN tool; chooser shows topics and `new` asks for one;
  per-conversation model command is a follow-up.

## Verification legend

✓ = checked by the orchestrator at the cited site. Unmarked = researcher
claim, cited but unchecked. Design may only load-bear ✓ rows, or verify at
point of use.

## Thread 1 — governance applicability

Full table: `raw/governance.md`. Rows design leans on:

| id | rule | bearing |
|---|---|---|
| DEC-025 | Toolset fixed at creation; a topic may carry one, judged against the profile policy at write; a topic change affects only later conversations. | The slice is this rule applied to `model`, with the gateway catalog as the judge. Extend, don't restate. |
| DEC-016 | One `topic` frame, one `topics` reply shape; first-line frames dispatch by one table. | `model` is a third frame key and a third `TopicSummary` field. |
| DEC-007 | Reply keys widen additively; element types don't change. | `TopicMessage.model`, `TopicSummary.model`, a per-id topic map on `list` are all permitted. |
| DEC-017 | `--set-topic` family, exclusivity through one `checkAlone`. | `--model` / `--no-model` join it. |
| DEC-008, DEC-039 | `--list` prints ids one per line; DEC-039 added `id<TAB>mark`. | Adding topic to the line amends the line format again. |
| DEC-009, DEC-010 | The chooser runs `--list` synchronously; bare ids suffice, label derivation refused (DEC-039 the narrow exception). | Topic per line is a second exception of the DEC-039 kind; model per line is a third. |
| DEC-015 | `default` is reserved; the topic frame refuses it. | **Closes OQ-2**: `default` cannot carry a model (✓ `src/topics.ts:251-254`). Plain `new` always takes the daemon default. |
| DEC-033 | A fork copies its parent's toolset. | A fork's model needs no rule: pi-durable copies the parent's agent at the fork entry (pi-durable README § Per-Conversation Agent, read this session). |
| DEC-034 | `thread_start`: toolset and cwd are the topic's, else the defaults. Model: the daemon default. | OQ-3: a started thread following its topic's model amends DEC-034. |
| DEC-024, DEC-033, SL-005 design | Refuse, naming the cause, over silent defaulting. | OQ-1 precedent. |

Revision candidates: DEC-025 (extend to model), DEC-016 / DEC-017 (new key,
new flags), DEC-034 (started thread's model), DEC-008 / DEC-039 (list line
format). RFC-002 D3 ("a topic carries only cwd; no model defaults yet") is
evidence the model was anticipated, not a gate.

Checked, not applicable: see `raw/governance.md` § Checked, not applicable
(prompt/env plumbing, mail, bridge, thread caps, superseded DEC-023).

## Thread 2 — code map

Full map: `raw/code-map.md`.

### Hotspots

| file | change |
|---|---|
| `src/protocol.ts` | `TopicMessage.model` (✓ :71-78), `TopicSummary.model`, `TOPIC_KEYS`, `ConversationsMessage` per-id topic |
| `src/topics.ts` | `TopicRecord`/`TopicChange` `model`, `KEYS` (✓ :209), `writeCreated` returns the model too |
| `src/conversations.ts` | `modelChange` beside `toolsetChange` (✓ :282-289); `setTopic` (✓ :337-341); creation applies the topic model; list page carries topics |
| `src/daemon-start.ts`, `src/models.ts` | move `requireKnownModel` to `models.ts`; pass `models` into `conversations(...)` |
| `src/daemon.ts` | `listReply` emits the new key |
| `src/threads/tools.ts` | `createStarted` applies the topic's model (✓ :169) |
| `src/attach-invocation.ts`, `src/request.ts`, `src/attach-main.ts` | `--model`/`--no-model`, `SKEWED_KEYS` (✓ `src/request.ts:93`), usage |
| `src/render.ts` | `--topics` gains a field; `--list` line gains topic |
| `emacs/malebolge.el` | candidate regex, `--topics` reader, topic on `new`, set-model command |
| tests | `test/topics.test.ts`, `conversations.test.ts`, `daemon.test.ts`, `attach-invocation.test.ts`, `render.test.ts`, `models.test.ts`, `malebolge-ert.el`, `emacs-attach-smoke.ts` |

### Load-bearing facts

1. ✓ **A model ref is `gateway/<id>`**: `GATEWAY_PROVIDER = "gateway"`
   (`src/models.ts:30`) is stamped on every catalog model (`src/models.ts:108`);
   the catalog's own provider key (`llm-gateway`) is discarded. The live refs
   are `gateway/openai-david/gpt-6.1-terra` etc.
2. ✓ `parseModel` splits at the first `/` (`src/models.ts:39-45`), so slashed
   model ids survive.
3. ✓ **`Models` is not reachable from the topic write.** `ServeOptions` carries
   only `conversations`, `beforeInput`, `orientation` (`src/daemon.ts:27-35`);
   `conversations(session, defaults, profile)` has no catalog
   (`src/conversations.ts:291-295`). The catalog exists as a local in
   `startDaemon` (`src/daemon-start.ts:210`). Threading it into `conversations`
   touches ~30 test call sites.
4. ✓ Toolset is judged in `setTopic`'s change builder, not the frame parser
   (`src/conversations.ts:282-289`, `:337-341`). `modelChange` slots in beside it.
5. ✓ `written` takes `string | null | undefined` (`src/topics.ts:218-224`):
   storing the ref **string** in `TopicRecord` needs no type widening.
6. Creation: `toolsetInit` reads the topic inside the creating commit through
   `writeCreated`, which returns only the toolset (`src/topics.ts:135-150`,
   `src/conversations.ts:165-186`). The model can be applied by the same init
   with `configure(tx, id, { model })`; pi-durable runs init after the `agent`
   change (researcher cite: pi-durable `types.d.ts:417-425`).
7. ✓ `thread_start` configures `{ ...deps.defaults, cwd }` (`src/threads/tools.ts:169`):
   a started thread takes the daemon default model unless this changes.
8. Root takes `defaults` on every open (`src/session.ts:199`); topics never
   reach it.
9. ✓ **The Emacs chooser regex admits one TAB field**
   (`emacs/malebolge.el:316-322`). A further field drops every line silently.
10. Emacs has no `--topics` reader (researcher: `grep -c topics` = 0).
11. `requireKnownModel` has no direct test; `test/gateway-catalog.json` holds
    only `deepseek-flash` (✓), so a fixture with a slashed id is needed.

## Cross-thread findings

- **The model write is DEC-025's toolset write with a different judge.**
  Policy (`requireAllowed`) judges toolsets; the catalog would judge models.
  The difference that matters: the policy is code, the catalog is loaded at
  start, so `conversations` needs the catalog as a dependency (fact 3).
- **OQ-1 has a second timing.** The catalog changes only across restarts
  (loaded at start). SL-005 refuses *startup* when a topic names a toolset the
  profile disallows. For a model, refusing startup means one dropped catalog
  entry stops the daemon; refusing *creation in that topic* keeps the daemon
  up and fails where the topic is used. Both are explicit denials. Design picks.
- **OQ-2 is closed by DEC-015 + code.** `default` carries no model, so plain
  `new` (the chooser's current path) stays on the daemon default. Picking a
  topic on `new` is the only way to reach a topic model from Emacs.
- **OQ-3 splits as the toolset rule does.** Forks inherit through pi-durable
  with no code; started threads need `src/threads/tools.ts:169` changed and a
  DEC-034 amendment. Following the topic matches how cwd and toolset already
  behave for started threads.
- **The `--list` line format is shared state.** DEC-039 gave it
  `id<TAB>mark`; the Emacs regex pins that. A topic field needs a fixed field
  order (e.g. `id<TAB>topic<TAB>mark?`) and a regex change in the same phase,
  or the chooser empties. `--conversation` argv also goes through
  `malebolge--candidate-id`.
- **Refs are long and prefixed.** Users will type `gateway/openai-david/gpt-6.1-terra`.
  This raises OQ-4's stakes: free text plus the daemon's refusal is workable
  but error-prone; completion needs a model list the daemon serves (a new
  listing frame, DEC-016 table) or the client reads the catalog file itself
  (coupling to a path the daemon owns).

## Design-input deltas

1. `requireKnownModel` moves to `src/models.ts`; `conversations()` takes the
   catalog; `modelChange` judges a set model there. Store the ref string.
2. OQ-2 resolved: no model on `default`.
3. OQ-3 proposal: forks inherit (no code); started threads take the topic's
   model, else the default (amend DEC-034).
4. OQ-1: choose between refusing startup and refusing creation in the topic.
5. OQ-4: decide on a model listing (`--models`, a `list` query kind
   `models`) versus free text.
6. OQ-5: topic per line is cheap (index already read for marks); model per
   line costs an agent read per id. Lean topic only.
7. `--list` line format and the Emacs regex change together; pin field order.
8. `SKEWED_KEYS` gains `model` so an old daemon's refusal prints the restart hint.
