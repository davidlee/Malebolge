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

- PHASE-01 · ModelCatalog members are function-typed properties (`require: (ref) => ModelRef`), not method signatures as design sec-2 writes them · typescript-eslint `unbound-method` refuses passing `catalog.require` unbound, which design sec-4's `creationModel(..., catalog.require)` does; names/types unchanged · decided (local design correction; flag for audit)
- PHASE-01 · `startDaemon`'s first three preflight calls extracted into a `preflight` helper (same calls, order, errors) · `max-lines-per-function` (80) was saturated and the catalog check needs two lines · decided (adjacent refactor)
- PHASE-01 · shared fixture placed in new `test/model-fixture.ts` (EX-6 allows "beside" harness-fixture): `SLASHED_REF`, `FLASH_REF`, `IMAGE_REF`, `slashedModels()`, `catalogOf(...refs)` · model-only module avoids harness-fixture's conversation/daemon imports · decided (fixture)
- PHASE-01 · UnknownModel message is `unknown model <ref>` for both refusals; an unparseable ref carries the parse error as `cause` · one wording satisfies EX-2 · decided
- PHASE-02 · `FAUX_CATALOG = catalogOf(refOf(FAUX_MODEL))` exported from `test/harness-fixture.ts`; `test/conversations.test.ts` gains an `apiOf(session, defaults?, profile?)` helper over ~33 call sites · `conversations(...)` gained a 4th parameter; one shared catalog keeps callers to one added argument and a stray ref fails loudly · decided (fixture)

## PHASE-01 run log

- EN-2: pi-ai 1.4.0 `Models.getModelsOfType(type, provider?)` confirmed at dist/models.d.ts:151; name unchanged.
- pi `implement` (deepseek-flash), 1 run, 23 requests, $0.05: fixture + VT-1..4 red-first (VT-4 already green, as predicted), then implementation; green. Misses: VT-2's "only chat" assertion was vacuous-risk (no proof the fixture held the image model) and sorting was unpinned (fixture catalog already in sorted order); both fixed by the orchestrator. The worker also noted the coverage threshold fails targeted runs: use `--coverage.enabled=false` for those.
- Negative controls (orchestrator): fallback on an unknown topic, all model types in refs, refs unsorted, split on the last slash, start check removed: each turns its VT red.

## PHASE-02 run log

- pi `implement` (deepseek-flash), 1 run, 54 requests, $0.06: VT-1..3 red-first (runtime assertion failures, not compile errors), then store/judge/frame/wiring; green. No misses of substance; the orchestrator collapsed redundant `apiOf(session, DEFAULTS, "host")` to `apiOf(session)`.
- Negative controls (orchestrator): `model` dropped from `KEYS` → VT-1 red (2 tests); `catalog.require` skipped in `modelChange` → VT-2 red; control-char check skipped for `model` → VT-3 red (3 rows).
- EX-4: `default` refusal tests untouched. Gate: `just check` 104 files / 3560 tests green.

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-29 · ready (PHASE-01..07 planned, none started) · cf7049a

### Produced
- SL-010 scoped (slice-010.md, scope re-confirmed at review.scope); research round 1 (research/)
- design run dr-01a18627 locked rev 38 (eddc7d9); informal review: 4 passes, see "Review passes" above; RV-022 waived (no findings)
- minted: DEC-082..DEC-089, DEC-091 (refines DEC-089); DEC-083 + DEC-089 body notes; ISS-004 (SL-009 follow-ups; SL-010 lands first)
- plan.toml + plan.md, 7 phases (cf7049a); phase sheets materialised; status ready
- no code changed; gate not run (nothing to gate)

### Learned
- mem.fact.malebolge.model-ref-provider-is-gateway
- mem.fact.malebolge.root-indexed-in-default

### Open
- DEC-034, DEC-039, DEC-016, DEC-017 — amended by DEC-084/087/086; record at /reconcile
- PHASE-03/EX-8 — thread_start maps UnknownModel to a refusal (DEC-083 on the tool path; arbiter ruling, not in design)
- PHASE-05/EN-2 — summaries cost on a 50-id page, measure before the phase
- ISS-004 — SL-009 (other session) absorbing; DEC-092/093 there call SL-010's topicInit
- IMP-018 — absorbed by SL-010; close with the slice
- research advisory reports drift (scope/design edited since research); not restamped
