# Notes SL-010: Per-topic model, and topics in the Emacs attach chooser

Durable per-slice scratchpad — tracked in git. The place to lift anything from a
disposable phase sheet (`.doctrine/state/.../phase-NN.md`) that must survive
`rm -rf` before the slice close-out audit harvests it.

## Review passes (design, 2026-10-29)

Round 1 was informal, with findings outside the RV-022 ledger (it holds none):
a pi first pass, a GPT pass (gpt-6.1-sol), a pi pass over SL-009 overlap, and
a pi verify pass over the revisions. All accepted findings are integrated in
design.md; the SL-009 share is ISS-004.

No further review pass is needed before lock. What one would probe, if
wanted, is left to phase-plan as checks against code, not design questions:
- that the empty wake topic's heartbeat create reaches `topicInit` through
  `conversations.open`, so `UnknownModel` is what `startRoomTasks` sees;
- that `summaries` reads (up to 50 agent documents per page, one commit) stay
  cheap on a full page;
- pi-ai's chat-model enumeration name for `refs`.

## Implementation run
<!-- written by the /super-orchestrator seat, 2026-10-29; charters point here -->

- **Driver**: /super-orchestrator seat → `sub-orchestrator` charters (1–3 phases) → quotient pi workers. Main worktree. Halts before audit.
- **Host gate**: `just check` from the session shell. Baseline 2026-10-29: 104 files / 3542 tests green. Emacs ERT: `just ert` (host only; emacs absent in the pi sandbox) — PHASE-05 and PHASE-07 run it on the host.
- **quotient forms**: `write` runs every gate recipe (`fmt-check`, `lint`, `typecheck`, full `vitest run`) green; no form change needed. `fmt-check` prints 4 benign biome warnings (broken `.quotient/` symlinks, exit 0). Use the PATH `biome` (via `just fmt-check` / `just format`), not `npx biome`.
- **Never run two `vitest run` at once in this root**: concurrent runs share `coverage/.tmp` and the loser fails with ENOENT on a coverage json (seen at preflight). Serialise full-suite runs; pi workers run targeted tests (`npx vitest run <file> --coverage.enabled=false` — without the flag the suite-wide 85% coverage threshold fails a passing targeted run), the sub-orchestrator runs the full host gate. Other sessions may start a full run in this root: check `pgrep -af vitest` before the gate and re-run alone on a coverage ENOENT.
- **Other writers**: SL-009 (another session, in design), SL-008 audit (RV-024). Leave dirty: `.doctrine/slice/009/**`, `decision/092..093`, `review/023`, `review/024*`, `backlog/issue/004/*`, `.doctrine/memory/items/*` not written by this run, and `src/untrusted-block.ts` (foreign one-line comment fix, not an SL-010 file). Commit only SL-010 paths and the phase's source files, by path.
- **Plan under concurrent review** (fixes for PHASE-02..07 landed in e6ea5df): another agent reviewed the plan (operator, 2026-10-29: "you can go on with 01 meantime"). Re-read `plan.toml` before each charter; if the review changes a later phase, the next charter follows the revised plan.
- **PHASE-07 VH-1**: the operator's hand-run (Emacs + gateway) — leave open, don't attempt.
- **Background tasks** enabled (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` unset): spawns run in the background and wake the parent by notification.

## Autonomy log
- PHASE-07 · VH-1 run against gateway/chatgpt/gpt-6.1-terra, not the plan's openai-david ref (account out of credit) · operator's choice · decided

- PHASE-01 · ModelCatalog members are function-typed properties (`require: (ref) => ModelRef`), not method signatures as design sec-2 writes them · typescript-eslint `unbound-method` refuses passing `catalog.require` unbound, which design sec-4's `creationModel(..., catalog.require)` does; names/types unchanged · decided (local design correction; flag for audit)
- PHASE-01 · `startDaemon`'s first three preflight calls extracted into a `preflight` helper (same calls, order, errors) · `max-lines-per-function` (80) was saturated and the catalog check needs two lines · decided (adjacent refactor)
- PHASE-01 · shared fixture placed in new `test/model-fixture.ts` (EX-6 allows "beside" harness-fixture): `SLASHED_REF`, `FLASH_REF`, `IMAGE_REF`, `slashedModels()`, `catalogOf(...refs)` · model-only module avoids harness-fixture's conversation/daemon imports · decided (fixture)
- PHASE-01 · UnknownModel message is `unknown model <ref>` for both refusals; an unparseable ref carries the parse error as `cause` · one wording satisfies EX-2 · decided
- PHASE-02 · `FAUX_CATALOG = catalogOf(refOf(FAUX_MODEL))` exported from `test/harness-fixture.ts`; `test/conversations.test.ts` gains an `apiOf(session, defaults?, profile?)` helper over ~33 call sites · `conversations(...)` gained a 4th parameter; one shared catalog keeps callers to one added argument and a stray ref fails loudly · decided (fixture)
- PHASE-03 · `ConversationDefaults` tightened to `AgentChange & { cwd: string; model: ModelRef }` · topicInit's `fallback` is the defaults' model; pi-durable types `model` optional/nullable, so tightening (as `cwd` already was) avoids a cast · decided (local correction; flag for audit)
- PHASE-03 · `ModelSources.topic` widened to `topic?: string | undefined` · `exactOptionalPropertyTypes` refuses passing `record?.model`; no behaviour change · decided (local design correction; flag for audit)
- PHASE-03 · EX-8 via widening `attempted` (Refusal | UnknownModel), not a rethrow in createStarted · the smaller of plan.md's two options; shared by all thread tools, only thread_start can raise it · decided
- PHASE-03 · heartbeat catch extracted as `ensureHeartbeatOrLog` in src/daemon-start.ts · keeps startRoomTasks' shape; catches UnknownModel only · decided (adjacent refactor)
- PHASE-03 · `test/thread-fixture.ts` gains `SECOND_MODEL`/`SECOND_REF` (faux/faux-2) and a world catalog holding both · a topic's model must differ observably from the world default for VT-3/VT-4 · decided (fixture)
- PHASE-04 · `parseAttachArgs`' seven valued-option copies folded into a `VALUED_FIELDS` table + loop · eslint `complexity` (8) refused the added `model` branch; same behaviour, all rows green · decided (adjacent refactor)
- PHASE-05 · `knownTopicIn(index, name)` extracted from `indexOfTopic` · `topicPage` now reads the index inside its commit and needs the same refusal; one check, two callers · decided (adjacent refactor)
- PHASE-06 · `--topics`/`--models` branches extracted to `standaloneListing` in src/attach-invocation.ts; set-topic frame building extracted to `topicFrameOf` in src/request.ts · eslint `complexity` (8) on `attachInvocationOf` / `requestFrameOf`; same behaviour · decided (adjacent refactor)
- PHASE-06 · `listQuery` reads `topic`/`topics`/`models` from one `LIST_QUESTIONS` table; a clash names the first two present (`topic and topics are exclusive` unchanged) · one check for three questions; exclusive-pair wording otherwise free in design sec-5 · decided
- PHASE-06 · `SKEWED_KEYS` gains `models` (carried from PHASE-04's hand-back; PHASE-06/EX-4 names it) · in plan, no adaptation needed · decided
- PHASE-06 · `serveOptionsOf` helper in src/daemon-start.ts builds `ServeOptions` (adds `modelRefs: catalog.refs`) · `startDaemon` at `max-lines-per-function` · decided (adjacent refactor)
- PHASE-07 · `malebolge--new-target` helper (topic prompt on `new`) beside the spec's `malebolge--topic-names`; `malebolge--await-listing` folded into `malebolge--client` · one bounded wait, `malebolge--choose-target` stays one prompt deep · decided (adjacent refactor)
- PHASE-07 · client failure wording `malebolge: malebolge-attach ARGS failed: OUTPUT` / `… did not answer in N seconds; the outcome is unknown` · design sec-6 fixes only "verb-neutral, names the args" · decided
- PHASE-07 · README `--list` line description corrected to `ID<TAB>TOPIC<TAB>MODEL[<TAB>MARK]` · PHASE-05 changed the lines and left README's old `id[<TAB>mark]` text · decided (doc correction; flag for audit)
- PHASE-07 · phase left `in_progress`, VH-1 awaiting operator · charter: do not mark VH-1 met; `completed` would misstate it · decided
- reconcile · REV-002 abandoned empty; RV-025 F-15 DEC amendment notes landed via `knowledge edit --body-mode append` · REVs cannot target DECs; DEC-029 precedent · decided

## PHASE-01 run log

- EN-2: pi-ai 1.4.0 `Models.getModelsOfType(type, provider?)` confirmed at dist/models.d.ts:151; name unchanged.
- pi `implement` (deepseek-flash), 1 run, 23 requests, $0.05: fixture + VT-1..4 red-first (VT-4 already green, as predicted), then implementation; green. Misses: VT-2's "only chat" assertion was vacuous-risk (no proof the fixture held the image model) and sorting was unpinned (fixture catalog already in sorted order); both fixed by the orchestrator. The worker also noted the coverage threshold fails targeted runs: use `--coverage.enabled=false` for those.
- Negative controls (orchestrator): fallback on an unknown topic, all model types in refs, refs unsorted, split on the last slash, start check removed: each turns its VT red.

## PHASE-02 run log

- pi `implement` (deepseek-flash), 1 run, 54 requests, $0.06: VT-1..3 red-first (runtime assertion failures, not compile errors), then store/judge/frame/wiring; green. No misses of substance; the orchestrator collapsed redundant `apiOf(session, DEFAULTS, "host")` to `apiOf(session)`.
- Negative controls (orchestrator): `model` dropped from `KEYS` → VT-1 red (2 tests); `catalog.require` skipped in `modelChange` → VT-2 red; control-char check skipped for `model` → VT-3 red (3 rows).
- EX-4: `default` refusal tests untouched. Gate: `just check` 104 files / 3560 tests green.

## PHASE-03 run log

- EN-2 re-confirmed: ensureHeartbeat opens `{kind: "topic", new: false}` on the shared Conversations → openTopic → create(topicInit). EN-3: `UnknownModel` leaves `createConversation` with its class intact (VT-2 `rejects.toBeInstanceOf(UnknownModel)`); no wrapper.
- pi `implement` (deepseek-flash), 2 runs on one session: 61 requests $0.08 (hit the request ceiling mid-edit), continuation 20 requests $0.02. VT-1/2/3/5/6 red-first for the right reasons (wrong model, resolved-not-rejected, missing refusal, missing log line, attach succeeded); VT-4 and the root pin green on first run (pins). No misses of substance; it updated more toolsetInit callers than briefed (topics, session, wake-tools tests).
- Negative controls (orchestrator): heartbeat catch widened to every error → `VT-3 f` red; `attempted` without the UnknownModel arm → VT-3 refusal test red.
- `VT-3 f` unchanged. Gate: `just check` 104 files / 3569 tests green.

## PHASE-04 run log

- pi `implement` (deepseek-flash), 2 runs on one session: tests-red 15 requests $0.02 (VT-1 10 red, VT-2 4 red, VT-3 1 red, all assertion/unknown-option failures; 9 `toThrow(UsageError)` twin rows vacuously green before EX-1, meaningful after), implementation 20 requests $0.02. Miss: none of substance; it flagged the pre-existing `--topics` expectation in test/request.test.ts the four-field line breaks, and refactored for the complexity rule (Autonomy log).
- Gate: `just check` 104 files / 3592 tests green.

## PHASE-05 run log

- EN-2: see the measurement section below (go).
- pi `implement` (deepseek-flash): tests run 51 requests $0.08 (hit the 50 ceiling while finishing) + continuation 2 requests $0.004; implementation run (fresh session) 35 requests $0.03. TS VTs red-first on missing `summaries` / old line shape (13 failures); ERT red on host before the regex moved (2 candidate tests). Misses: one `no-unnecessary-condition` lint error in its VT-1 test (orchestrator fixed); `topicPage` duplicated the unknown-topic check (orchestrator extracted `knownTopicIn`); lineOf's two branches collapsed. Test mark texts in ERT (`forked from 12`) are not the daemon's wording; harmless to parsing.
- Host: `just ert` 42/42 + byte-compile clean; `just smoke` 4/4. Negative control: a mark regex allowing empty (`[^\t\n]*`) → ERT `…reject-malformed-ones` red.
- Gate: `just check` 104 files / 3596 tests green.

## PHASE-06 run log

- pi `implement` (deepseek-flash), one session: tests-red 30 requests $0.04 (VT-1 6, VT-2 1, VT-3 9, VT-4 4, VT-5 1 red; VT-5 red as a missing-renderer-row TypeError, not a diff); implementation 51 requests $0.07 (hit the request ceiling during its final diff read, work complete). Misses: none of substance; the orchestrator collapsed `listQuery`'s helper (`listingAsked` returned a pointless `true`) into the table form and merged `hereOf`'s two `undefined` cases.
- Negative controls (orchestrator): `models` dropped from `SKEWED_KEYS` → VT-4 red (2); clash check disabled → VT-1 red (4). VT-2's Conversations stub throws on `list`/`topics`, so a store-touching answer cannot pass.
- Gate: `just check` 104 files / 3621 tests green.

## PHASE-07 run log

- EN-1: `just ert` 42/42 + byte-compile clean, `just smoke` 4/4 before the phase; PHASE-06 a873454.
- pi `implement` (deepseek-flash), one session: tests run 51 requests $0.08 (hit the ceiling while answering; answer complete); host ERT then 13 red for the right reasons (void `malebolge--client` / `malebolge-set-topic-model`, `(new . TOPIC)` reaching the `--conversation` arm, no `Topic: ` prompt); implementation 25 requests $0.05. Host: `just ert` 48/48 and byte-compile clean, `just smoke` 5/5, first try. Misses: none of substance; the orchestrator swapped `(delete … (copy-sequence …))` for `remove`, and fixed README's stale `--list` line text.
- Negative controls (orchestrator): bound replaced by 60 s → `malebolge-client-gives-up…` red (30 s); `none` not mapped to `--no-model` → `…clears-the-model-with-none` red.
- Gate: `just check` 104 files / 3621 tests green.
- Status: left `in_progress` — **VH-1 awaiting operator** (checklist below).

## PHASE-07 VH-1 operator checklist

VH-1 (operator, live gateway): set a topic to `gateway/openai-david/gpt-6.1-terra` from Emacs, create a conversation in it from the chooser, see the model on its chooser line, and get a reply from that model.

0. Reload the elisp on this build: `M-x load-file RET ~/dev/malebolge/emacs/malebolge.el RET` (a daemon restart does not reload it, and `dl-satan.el`'s `:commands` autoloads only attach/start/stop — operator hit `malebolge-set-topic-model` undefined at step 3, 2026-10-29).
1. Restart the daemon on this build (`M-x malebolge-stop`, `M-x malebolge-start`); `node src/attach-main.ts --models` should list `gateway/openai-david/gpt-6.1-terra`.
2. Have a non-default topic (e.g. `node src/attach-main.ts --set-topic work`).
3. `M-x malebolge-set-topic-model` → `work` → `gateway/openai-david/gpt-6.1-terra`; expect `malebolge: topic work now uses gateway/openai-david/gpt-6.1-terra`. (`--topics` shows it in the fourth field.)
4. `C-u M-x malebolge-attach` → `new` → `Topic: work`; the transcript attaches to a new conversation.
5. Send a prompt (draft, `C-c C-c`); a reply arrives from that model.
6. `C-u M-x malebolge-attach` again: the new conversation's chooser line reads `ID<TAB>work<TAB>gateway/openai-david/gpt-6.1-terra`.
7. Record the outcome (pass, or what failed) for the agent to mark VH-1 and flip PHASE-07 `completed`.

### VH-1 result (2026-10-29, operator)

Passed (reply "yes"): topic `dwarf` set to `gateway/chatgpt/gpt-6.1-terra` via `M-x malebolge-set-topic-model`; new conversation 2738 from the chooser; `--list` line `2738<TAB>dwarf<TAB>gateway/chatgpt/gpt-6.1-terra`; reply received. Ref substituted for the plan's `openai-david` (that account returned 429, no credit) — operator's choice. Needed a home-manager switch (`~/flakes`) so the daemon's catalog listed `chatgpt/*`, and `llm-gateway` chatgpt sign-in. Rough edges hit: elisp not reloaded after update; `Topic:` RET defaults to `default` (first attempt landed in 2672/default); silent model failure (ISS-005); connect status lacks topic/model (IMP-026).

## PHASE-05 EN-2 measurement (VA-1)

- 2026-10-29, host, node-sqlite store (`openNodeSqliteStorage`, the daemon's), 60 conversations created via `Conversations.open({kind:"new"})`, page = LIST_PAGE (50): one commit of `scanConversations` + `readIndexDoc` + 50 `tx.doc(AgentDoc, id)` (all 50 carried a model). Warm session, 20 reps: median 0.14 ms, max 0.31 ms (scan + index alone: 0.03 ms). Cold, first commit after reopening the file: 0.30 ms.
- Outcome: go. Three orders of magnitude under the 100 ms consult threshold. Throwaway test kept at `.doctrine/state/slice/010/en2-bench.test.ts.txt` (gitignored), not committed.

## Audit pass (RV-025, 2026-10-29)

- Sweep: pi `review` (deepseek-flash) ran 57 requests, $0.07, no answer — the provider returned 402 insufficient balance; the continuation was refused at once. Fallback: one Sonnet subagent (read-only diff-vs-design sweep), 5 leads: 1 doc + 3 comments confirmed stale (F-16, fixed at audit), 2 judged not findings.
- Registry: sub-orchestrators had not run `slice record-delta`; bootstrapped at audit (F-1). Drivers should record at each phase commit.
- Phase sheets (`.doctrine/state/slice/010/phases/`): Risks/Decisions/Findings empty; everything durable was already lifted into this file's Autonomy log and run logs. Nothing further to harvest from them.

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-29 · audit concluded (RV-025) · status reconcile

### Produced
- PHASE-01..07 done (8aa02d9, c4542f8, 866a88c, 78856d0, 77ac080, a873454, 2538398); VH-1 passed by the operator (substituted ref, RV-025 F-10)
- design run dr-01a18627 locked rev 38 (eddc7d9); DEC-082..DEC-089, DEC-091; ISS-004
- RV-025 audit: 19 findings, all verified; Reconciliation Brief in review-025.md; F-16 comment/doc fixes and IMP-026 item 4 landed with the audit commit

### Learned
- mem.fact.malebolge.model-ref-provider-is-gateway
- mem.fact.malebolge.root-indexed-in-default

### Open
- RV-025 Reconciliation Brief — per-slice: selectors + design sec-2/sec-4/sec-7; governance: DEC-016, DEC-017, DEC-034, DEC-039, DEC-082 (for /reconcile)
- IMP-018 — resolve at /close (RV-025 F-19)
- IMP-026 — Emacs/transcript rough edges, incl. `Topic:` default (amends DEC-089 if changed)
- CHR-001 — `doctrine check gate` has no `just gate` recipe
- ISS-004 — SL-009 follow-ups (other session)
