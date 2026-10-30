# SL-007 notes

## Design surface triage (2026-10-29)

> Superseded by the inquiry's decisions (DEC-047 to DEC-063, CON-001). In
> particular the "plain, read-only key file" below gave way to DEC-059 (the
> unit decrypts screwtape's credential). Kept for history.

Sources: `slice-007.md`, `research/research.md` (with its addendum), and
operator answers given in the session.

### Shaping decisions (operator, 2026-10-29)

- **Placement.** Answers go on the existing tools, not a new `mail_classify`
  tool (OQ-1). This leaves the DEC-029 catalog unchanged.
- **Cost.** Classify is fast and functionally free. Batch it anyway, on
  principle (OQ-4).
- **Budget.** Answers may sit on top of DEC-026's per-item share, and the
  agent gets only the useful subset (OQ-5).
- **Jail path (e).** Classify runs inside the jail through the gateway
  socket the jail already holds, bridged to loopback. The Jev key is
  provisioned as a plain, read-only key file, which is Jev-only and useful
  only on loopback. The wrapper / `systemd-run --user` route is rejected:
  it needs the user bus, which is a jail escape (research addendum).

- **Quarantine hardening (scope objective 6).** The operator added three
  requirements:
  - framing as untrusted, possibly hostile, never authority or instruction;
  - a self-report protocol for the agent, independent of Jev;
  - a pre-filter that withholds what Jev flags as hostile.

  These are inquiries inq-10, inq-11 and inq-12. The pre-filter is a scoped
  exception to the "no filtering policy" non-goal.

### Open questions → design inquiries

1. Where classification enters the port, and which tools carry answers.
2. What classify reads: a separate fixed-size read, or the tool's own read
   (research X-3).
3. The adapter's invocation: a no-shell spawn with stdin, bounds, timeout,
   and an id/order check (X-2).
4. Jail wiring, which crosses repos:
   - who runs the `socat` bridge;
   - key file provisioning and env vars;
   - whether the gateway socket's API matches the relay's;
   - the child env.
5. The cache: scope, key, bound (X-4).
6. Failure semantics: per message vs per page, and wording (X-5).
7. Rendering:
   - the useful subset;
   - the reserve on top of the share;
   - pi's 50 KiB cap;
   - `MAIL_SECTION` (X-6).
8. Governance edits at lock.
9. Verification.

### Risks

- Answers are influenceable by an attacker, so they are advice only
  (RSK-002). `agent_directive` and `deception_cues` are themselves targets
  for an attacker to game.
- Cross-repo changes in satan (jail binds, key file, bridge). This slice's
  phases can't land them alone.
- pi may truncate a tool result above 50 KiB (unverified). If it does,
  "on top of budget" must still fit under that cap.

### Assumptions

- The gateway's client unix socket serves the same HTTP API as the relay
  on `127.0.0.1:4000` (inference).
- A JMAP message id names immutable content, so a cached classification
  never goes stale under the same id and config.

### Constraining governance

- DEC-026, DEC-027, DEC-028, DEC-029, DEC-030
- RSK-002
- ASM-001
- Screwtape's README contract: "classify", "Resume and skip", "Bounds".

## Further review (2026-10-29)

RV-020 ran three informal passes over the design (pi first pass, GPT critical
pass, pi verify-only). The last pass found only wording and recipe slips, so no
further design pass is planned. What one would probe, if run: the `seen`
contract once screwtape IMP-006 is specified (field shape, per-list address
bounds, the raw bounds table); whether the mail-only framing should move into
the shared untrusted block for bookmarks (SL-008, DEC-054). Recipe-level
slips are left to red/green tests; the next review is of the plan.

## Implementation run
<!-- written by the /super-orchestrator seat, 2026-10-29; charters point here -->

- **Driver**: /super-orchestrator seat → `sub-orchestrator` charters → quotient pi workers. Main worktree. Scope PHASE-01..07; halt before PHASE-08 (VH, operator: satan IMP-060, flakes IMP-055, deployed screwtape) and before audit. Screwtape SL-005 is `done` (checked at preflight), so PHASE-07 is in reach; its EN-2 still re-reads the contract.
- **PHASE-01 VA-1 / EX-1: done at preflight by the seat (host), PASS.** socat bridge `127.0.0.1:4107` → `/run/llm-gateway-client/api.sock` vs relay `:4000`, on `/v1/systemone` (screwtape `jev/client.gleam`): GET 404 `no such route` and POST 401 `auth_error "unknown key"` on both, identical JSON bodies. Recorded on ASM-002 (now `validated`). PHASE-01 starts at its code.
- **Host gate**: `just check` from the session shell. Baseline 2026-10-29 at 5540321: fmt-check, lint, typecheck green; vitest 3782 passed, 3 failed — all in SL-009's in-flight files (`test/bridge-inbound.test.ts`, `test/bridge-listener.test.ts`, `test/bridge-pairing.test.ts`; red TDD in another session). **A gate is green for SL-007 when every failure is in a file SL-009 holds dirty**; any other failure is ours.
- **Never run two `vitest run` at once in this root** (shared `coverage/`; the loser dies with "coverage report directory … already in use" — happened at preflight, from another session). Before the host gate check `pgrep -af vitest` (a `pgrep -f 'vitest run'` loop matches its own shell line); re-run alone on that error. pi workers run targeted tests: `npx vitest run <file> --coverage.enabled=false`.
- **quotient forms**: `write` re-probed: just, biome, node, npx present; fmt-check, lint, typecheck, targeted vitest green; root writable. **No `socat`, `nix`, `python3` in the form.** Use PATH `biome` (via `just format` / `biome format --write <files>`), not `npx biome`. fmt-check's 4 warnings (broken `.quotient/` symlinks) are benign.
- **Operator ruling — PHASE-04 overlap** (2026-10-29, "Wait for SL-009"): PHASE-04 edits `test/daemon-sections.test.ts`, which SL-009's session may hold dirty. PHASE-04 starts only once that file is clean in `git status`; if it is still dirty then, park PHASE-04..07 (they depend on it) and push a notification.
- **Other writers**: SL-009's session (`src/bridge/**`, `test/bridge-*`, `test/daemon-sections.test.ts`, `.doctrine/slice/009/**`) and other sessions committing on main (e.g. IMP-026 fixes in render/emacs). Commit only SL-007 paths and the phase's source files, by path. If another writer appears in a file the current phase owns, halt that phase and escalate.
- **Cross-repo**: do not edit satan, flakes or screwtape; read-only looks only.
- **Operator prefs**: YAGNI; no tests pinning framing wording (DEC-061) — only `MAIL_SECTION` names the rendered tag; no test pins a bound's value. VT keywords are test titles/identifiers to write verbatim (`doctrine slice verify-vt 7`).
- **Background tasks** enabled (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` unset); spawn depth unset (default ≥ 2).

## Autonomy log

- PHASE-01 · VA-1/EX-1 recorded satisfied by the seat's preflight probe (ASM-002 validated); not re-run · charter says done · decided
- PHASE-01 · stdinEnv refusals (string command, inheritEnv not false — absent included, empty argv) return `spawn_error` · design says "refused" without a code; mirrors NodeExecutionEnv's empty-argv convention · decided
- PHASE-01 · answers schema kept as the design's three shapes; pi had widened it to accept a bare string so the generic extra-field sweep passed — reverted, and the sweep instead adds a future *question* (known shape) inside `answers` (`withFutureFields`) · a string answer must stay a contract violation · decided
- PHASE-01 · `test/mail/project.test.ts` projection sweep excludes `contract/classify.json` (classify has no view) · needed for green; not in plan's file list · decided
- PHASE-01 · fixture scores set to the probability-weighted level (0.9, 1.5) per screwtape § classify's "within 0.05" rule · transcription fidelity · decided
- PHASE-01 · fakeMailSource.classify: an unscripted id answers `failed`; no reply rejects like the other verbs · EX-4 leaves the default open · decided
- PHASE-02 · `ScrewtapeOptions` gains optional `credentials` and `stdinEnv` (default the real stdinEnv); credentials absent → every id `unavailable`, nothing spawns · design names no injection seam; optional keeps daemon-start.ts (PHASE-04 wires credentials) and smoke.test.ts untouched · decided
- PHASE-02 · classify positions and "at most n lines" count over the batch of surviving reads; an unterminated last line (no breach) is a contract violation; a stdout breach keeps the checked prefix (table's last row) · design's prefix rule read literally · decided
- PHASE-02 · host gate: fmt-check and lint fail only on SL-009's untracked `pi-bridge/state.ts`, vitest fails only in its untracked `test/pi-bridge-state.test.ts` (59, red TDD); tsc green · not ours per the green-for-SL-007 rule · decided
- PHASE-03 · added a test: an earlier hostile row with a later absent row withholds `missing_question` (every policy question present before any hostility check) · the red set passed a row-by-row loop; negative control for the flowchart order · decided
- PHASE-03 · `classificationsOf` dedups in first-appearance order and maps only the outcomes the port answered (an omitted id stays absent, so it reads as missing → withheld) · design silent; the port promises one outcome per id · decided
- PHASE-03 · host gate fully green (fmt-check, lint, typecheck, vitest 3993/3993); VA-1 grep: question names only in `src/mail/policy.ts` · PASS · decided
- PHASE-04 · `WRAPPER_BYTES` = the old 64 + `untrustedLine(LONGEST_TAG)` + newline, `LONGEST_TAG = "bookmark-data"` in `src/untrusted-block.ts` · design says "at the longest tag in use"; computed, not hand-counted · decided
- PHASE-04 · `test/mail/render.test.ts` "sec-4 figures" pinned `WRAPPER_BYTES` 64 / `HEADER_MAX_BYTES` 1984; replaced those two with relations (wrapper > the line; header = reserve − wrapper) rather than new numbers · operator pref: no test pins a bound's value; the other pre-existing figure pins left alone (not this phase's) · decided
- PHASE-04 · header-reading test helpers (`headerLinesOf` in mail-fixtures, bookmarks render/tools) drop the line above the open tag when it is `untrustedLine(tag)` · the line is renderBlock's, not the header's; no assertion changed · decided
- PHASE-04 · `mailRefusal` and `MailRefusalFacts` in `src/mail/extension.ts`; `MAIL_ERROR_PREFIX`, `MAIL_DESCRIPTION_SUFFIX` exported from tools.ts so tests assert via the constants (DEC-061) · design names no home for the constants · decided
- PHASE-04 · no Opus framing review: MAIL_SECTION checked verbatim against design § Framing by script; untrusted line, prefix path (one `errorResult`) and suffix read by me against the design; diff small · cost not earned · decided
- PHASE-04 · host gate: fmt-check, typecheck green; lint fails only in SL-009's untracked `pi-bridge/posture.ts`, `pi-bridge/shell.ts`; vitest 4029/4029 · green for SL-007 · decided
- seat · `mailPart` reads `/sys/class/net`; satan's room jail (`~/dev/satan/flake.nix`, `--unshare-net`) shows no explicit `/sys` bind, and the jail.nix source was not checked. If the jail lacks sysfs, mail refuses "cannot list network interfaces" (fails closed). Must hold for PHASE-08; raise with satan IMP-060's session · escalated (open for the operator, non-blocking)
- seat · **operator ruling (2026-10-30, "agreed")**: `mailPart` reads interface names from `/proc/net/dev` instead of `readdirSync("/sys/class/net")`. Host bwrap probe: under `--unshare-net`, a bind of host `/sys` or `/sys/class/net` lists the host's 5 interfaces (sysfs reflects its mounter's netns; bwrap cannot mount a fresh sysfs), so the check would always refuse "can reach the network"; `/proc/net/dev` with `--proc /proc` lists `lo` only, and the host's full list without `--unshare-net`. Same check, refusal texts and `MailRefusalFacts`; correct design § Preconditions to match. Lands as the PHASE-07 charter's first commit. Satan's jail must mount `/proc`: operator confirmed `ls /proc` works from a jailed shell in malebolge (2026-10-30) · decided by operator
- PHASE-05 · projectNew/projectRead take `classified` now; their `maxBytes` parameter waits for PHASE-07 (nothing would read it before seen's text) · YAGNI within the planned signatures · decided
- PHASE-05 · `jev` sits in the core right after `has_attachment`; CUT_ORDER gains `jev` after `subject` (design) and `sender_domains` after `from`; withheld core order follows the design table, then held_back/in_store, then cut · design names the fields, not their positions · decided
- PHASE-05 · an id `classificationsOf` leaves unanswered is screened as `unclassified: failed` (withheld) · PHASE-03 left it absent; the screen must fail closed · decided
- PHASE-05 · senderDomains: an address with no `@` or an empty domain contributes nothing; the 253-byte check is on the raw text before lowercasing; the cap applies after dedup · design silent on these edges · decided
- PHASE-05 · header: one `missing question: <name>` line per distinct name, in WITHHOLD_POLICY order, right after the items line; a name outside the table throws (header stays trusted) · design says "names its question once" · decided
- PHASE-05 · render.test "mail_new at limit 20" core bound: the pinned `<= 1280` became `<= shareOf(20) - 1024` (core still leaves 1 KiB for fill and body); jev in the core grows it as design § Rendering's table expects (≈1.3 KiB) · operator pref: no pinned bound values; not a weakening of a design bound · decided
- PHASE-05 · eight pre-existing tools tests pinned the old joint clamp (4096 at limit 10, 2048 at limit 20) and "defaults report no clamp"; rewritten to the computed `jointBound(limit)` (`floor(NEW_JOINT_BYTES / limit) - JEV_MAX_BYTES`), the no-clamp cases moved to each limit's joint bound · design § Rendering sets the deduction; the default call now reports a max_bytes clamp → IMP-028 · decided / deferred
- PHASE-05 · green dropped `in_store: true` from withheld thread entries; added the assertion (red, 7 cases) and passed the flags through `itemOf` · design: "held-back and in_store flags stay in the core" · decided
- PHASE-05 · Opus review (no blocker/major) adopted: `projectWithheld` takes `flags.size` instead of sniffing `"bodies" in item` (deletes `summaryView`); `jevOfAnswers` factored out; tests added — maximal withheld item fits shareOf(40), VT-2 matrix asserts the exact key set and no sender text in the line, a page where classify omits one id; red-step `withFact` helper removed · small clarification of the design's projectWithheld signature, behaviour unchanged · decided
- PHASE-05 · not acted on (review nits): `Object.entries` orders integer-like question keys first (current schemas use identifiers); jev question keys and choice labels are classifier-produced free strings, safe only while screwtape enforces its schema · recorded for audit · decided
- PHASE-05 · host gate fully green (fmt-check, lint, typecheck, vitest 4133/4133); verify-vt PHASE-05 VT-1..4 PASS · decided
- PHASE-06 · mail_report returns the plain text `reported` through the shared `mailTool` wrapper (refusal, `malebolge: ` error prefix, description suffix); "the usual framing" read as that wrapper, since the result carries no mail data; `MailTool` gains `mail_report` as design § Rendering lists · design does not say whether the result is a mail block · decided
- PHASE-06 · a refused report (full set, bad input) logs nothing and sets nothing · design: "a report of a new id is refused", the operator sees refusals in the reply · decided
- PHASE-06 · the red step pinned `required: ["id"]` for mail_report; green refused to widen `kind` to optional and reported it; I corrected the test to `["id", "kind"]` (design gives `kind` without Optional) · test error, not a contract change · decided
- PHASE-06 · `reportLine` writes the literal `malebolge: ` rather than reusing `MAIL_ERROR_PREFIX` (a journal line is not an error result); an idOf comment green re-cited to "§ One tool call" restored to SL-005 design "Inputs" · naming/cohesion · decided
- PHASE-06 · catalog guard collects tools from the room's extensions whose names are in `toolsetList("mail", "room")`; the toolset lists `mail-persona` while the built extension is named `persona`, so a tool the persona extension registered would escape the guard (it registers none today) · pre-existing name mismatch, noted for audit · decided
- PHASE-06 · no Opus review: diff small (one tool, one validator, one log line), read in full by me against design § mail_report · cost not earned · decided
- PHASE-06 · host gate fully green (fmt-check, lint, typecheck, vitest 4153/4153); verify-vt PHASE-06 VT-1..3 PASS · decided
- fix · /proc fix per the seat's operator-ruling line (2026-10-30): `interfaceNamesOf` (pure, `src/mail/extension.ts`) parses `/proc/net/dev`; `networkInterfaces` in daemon-start reads it once at build; refusal texts and `MailRefusalFacts` unchanged · decided by operator
- fix · `interfaceNamesOf` answers undefined when the file names no interface (refuses "cannot list"), since an empty list would pass `onlyLoopback` and every netns holds `lo` · fail closed · decided
- fix · design drift for /reconcile: design § Preconditions (table row "checked from", and the `mailPart` paragraph) still says `/sys/class/net` / `readdirSync`; the design run is locked (rev 71) and reopening was an operator act, so the text is left · deferred to /reconcile

- PHASE-07 · EN-2: screwtape README re-read at d705f5b (HEAD; README last changed 65879a9, the commit DEC-094 cites); § classify_state seen shape equals SeenSchema field for field, no drift; fixture and schema unchanged · decided
- PHASE-07 · test fixtures: `seenOf(item)`, `classifiedAs(item, answers?)`, `classifyAll(items)`, `ANY_MAX_BYTES` in mail-fixtures; existing tests moved to a seen mirroring the item first (refactor step, suite green) so the switch broke only the dropped-field tests · fixtures/helpers · decided
- PHASE-07 · a seen attachment with no read attachment at its index is dropped and names `attachments` in cut (never an invented id) · design silent; Opus review agreed · decided
- PHASE-07 · `bodies_omitted` sets is_truncated only, not a `body` cut name · design § Jev's window body-flags row · decided
- PHASE-07 · `foldBodies` narrowed to `readBodyFlags` (is_encoding_problem, truncated_by); the blank-line join lives only in `seenBody`; `readParts` shared by projectNew/projectRead · Opus review M2 / DRY · decided
- PHASE-07 · test "mail_read max_bytes above 32768" pinned 32768; rewritten against `READ_MAX_BYTES.max` (green stopped and reported it) · operator pref: no pinned bound values · decided
- PHASE-07 · IMP-028 (mail_new default max_bytes reports a clamp) does not fall out of passing maxBytes to the projectors; left deferred · no extra scope · deferred
- PHASE-07 · Opus review (capsule-worker, opus; reason: DEC-048 trust boundary): no blocker/major; adopted M1 (attachment-mismatch test), M2, M3 (distinct seen type in VT-1), N1 (header comment), N2 (shared ANY_MAX_BYTES); not acted on: N3 (fixture flag state screwtape never emits, follows the design table), N4 (READ_MAX_BYTES.max not tied to CLASSIFY_READ_BYTES; DEC-094 makes it unnecessary) · decided
- PHASE-07 · host gate fully green (fmt-check, lint, typecheck, vitest 4166/4166); verify-vt PHASE-07 VT-1, VT-2 PASS · decided

## Pi runs

- PHASE-01 · 5 implement runs (red A, red B, green A, green B, refactor B), ~$0.14 total · misses: widened the answers schema instead of flagging the test conflict; briefed `biome lint` (my error — lint is ESLint), so green B landed 12 ESLint errors, fixed in the refactor run
- PHASE-02 · 2 implement runs (red, green), ~$0.12 · clean; I added the caller-abort classify test and folded the empty-batch branch into mergeOutcomes
- PHASE-03 · 2 implement runs (red, green), ~$0.08 · clean; the red set lacked a missing-before-hostile control (added in the green brief); I trimmed header comments
- PHASE-04 · 3 implement runs in one session (red A structural, red B, green), ~$0.14 · per-run ceiling is 60 requests (90 refused), so red split in two; green re-pinned two bound values (I replaced them with relations) and cited the wrong design section ids (sec-3; fixed to § names)
- PHASE-05 · 6 implement runs (red A + continuation, red B, green + continuation, refactor), ~$0.42 · two runs hit the 60-request ceiling before answering (continued in-session); green correctly refused to edit 8 stale clamp tests and reported them; green dropped `in_store` on withheld thread entries (caught by me, not by its tests); red A re-pinned nothing but cited `sec-16` (fixed)
- PHASE-06 · 2 implement runs (red, green), ~$0.10 · red pinned `required: ["id"]` for mail_report (wrong); green stopped and reported it instead of widening the schema (good); green coupled the log line to MAIL_ERROR_PREFIX and mis-cited one comment (fixed)
- PHASE-07 · 3 implement runs (fixtures refactor, red, green), ~$0.22 · clean; green stopped on a stale 32768 clamp pin and reported it (good); I folded the projectNew/projectRead duplication into `readParts` and applied the Opus review

## Audit (RV-028, 2026-10-30)

- audit · RV-028 opened, conformance mode, primary tree at 38a3c8a; PHASE-01..07 audited; F-1 (VH-1 unrun) held open by operator choice ("Hold audit open") · decided by operator
- audit · F-2, F-3 fixed red/green in the audit (uncommitted): `mail_read` max_bytes schema text from READ_MAX_BYTES; classify `stopReason` reads stderr only on a non-zero exit (a transient ending can no longer cache `too_large`) · `just check` 4177/4177 · decided
- audit · home-switch deployed 2026-10-30 10:39: unit loads `jev`, jail sets MALEBOLGE_SCREWTAPE_CREDENTIALS and carries socat, daemon starts with 6 mail tools; **unit reports LimitCORE=infinity, DEC-081 needs 0** (flakes IMP-055 incomplete). The running daemon predates the audit fixes; restart after they land to test them live · open for the operator

- PHASE-08 · VH-1 step 2 PASS (operator, 2026-10-30 ~11:05): self-sent mail `StlnQ8D167U-` ("important", david@davlee.com) shown by mail_list withheld `{"reason":"hostile","detail":"agent_directive","score":0.99}`, body held back; SATAN reported it to the operator. Classify reached Jev from the jail (bridge + credential live), so step 1's path holds; jev on shown items still to confirm · operator-observed
- PHASE-08 · first attempts saw nothing: the mail arrived 10:46, after the 10:45 sync (window: inbox, 30 days, 15-min timer), and SATAN filtered `from` on a wrong address and paged mail_new from the window's oldest end. Not defects; mail_list or `since` reaches new mail · decided
- PHASE-08 · VH-1 steps 1 and 3 PASS (operator): every shown item carries jev scores; mail_report StlnRSkM1m_J kind=phishing logged (journal 11:00:46) and the message withheld as reported afterwards. The journal line doubled its prefix → RV-028 F-10, fixed · operator-observed
- PHASE-08 · VH-1 step 4 not observable as written: killing the jail's :4000 socat also took down the room model (gateway-models.json baseUrl http://127.0.0.1:4000/v1; wake 1976 model_error). Operator choice (a): accept VT coverage of the degraded mapping; the design is corrected at /reconcile (RV-028 F-11). Room restarted 11:04 with the audit fixes · decided by operator
- PHASE-08 · deploy notes for satan IMP-060: the launcher starts the :4000 socat twice (the second fails "Address already in use" and stays a zombie); for flakes IMP-055: unit LimitCORE=infinity, DEC-081 needs 0 · open for the operator

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-30 · close · reconcile applied (RV-028 outcome)

### Produced
- PHASE-01..07 done (commits 616f2ec..d8d2466, /proc fix cc52b22); PHASE-08 VH-1 run live 2026-10-30 (steps 1–3 pass, step 4 by VT)
- RV-028 audit: F-2, F-3, F-10 fixed; reconciliation brief for design.md § Preconditions, § One tool call, § Reaching Jev, § Verification, slice-007.md risks, DEC-049
- minted: IMP-028 — default mail_new reports a max_bytes clamp
- reconciled: design.md (4 sections), slice-007.md risks, DEC-049 choice via knowledge edit; REV-003 abandoned (a DEC is not a REV target)

### Learned
- mem.fact.malebolge.screwtape-classify-window — classify strips PII before its byte cut
- mem.pattern.malebolge.own-the-window-upstream — upstream reports what it saw
- mem.fact.malebolge.pi-tool-output-bound — pi bounds tool results to 50 KiB
- mem.fact.malebolge.screwtape-classify-failure-line — a classify error line carries a cursor

### Open
- satan IMP-060 (doubled socat), flakes IMP-055 (LimitCORE=0 not live) — deployment residue
- ASM-003 — launcher wraps the daemon (satan IMP-060)
- IMP-024 — drop `preview`; IMP-028 — default clamp report
- RV-020, RV-026 — design-review ledgers awaiting raiser conclusion
