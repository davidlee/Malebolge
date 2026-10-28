# Notes SL-006: Threads: start, fork and post among interactive conversations

Durable per-slice scratchpad — tracked in git. The place to lift anything from a
disposable phase sheet (`.doctrine/state/.../phase-NN.md`) that must survive
`rm -rf` before the slice close-out audit harvests it.

## Design triage (2026-10-29, design run revision 5)

Evidence: `research/research.md` (cited `F-n`, `X-n`). Framing: RFC-003 and
the operator's answers recorded there (talk sets; mail in no set;
conversation before delegation; prompt model changes incrementally).

**Operator leanings carried into design (2026-10-29)**
- Fork point: spike first, then decide (X-3).
- Project context per conversation (RFC-002 D2): out of scope (X-4).
- A post addresses a conversation by id only (X-7).
- Caps: live counts through `harness.inspect`; chain depth on the post entry;
  cost stays with satan IMP-053 (X-6).
- Threads run in the room only, for now (X-8).

**Constraining governance**
- DEC-012 / RFC-002 D7: every ownerless conversation is indexed in its
  creating commit, by the hook; a fork takes its parent's topic and records it.
- DEC-024: every create path names a toolset; the guard test covers every path,
  across a restart. Start and fork join it.
- DEC-025 (1): toolset fixed at creation; forks inherit it.
- DEC-029: closed catalog; a new extension is named in the interactive list.
- DEC-015: latest = highest id, so a new thread becomes its topic's latest.

**Shaping facts**
- Wake already delivers a durable, deduped, provenance-carrying turn into
  another conversation (F-10..F-13): the post's delivery path (X-1).
- A tool can create or fork inside its own commit and get a handle (F-1..F-3):
  start can be atomic, brief included (X-2).
- A runtime fork today blocks the next start, and the backfill would give it
  the default toolset (F-7..F-9, X-5): fork and IMP-017 land together.

**Risks**
- Runaway turns between threads (bounds are mandatory).
- A fork point with a dangling tool call (X-3), unverified.

**Assumptions**
- EVD-001 (busy conversations queue input) holds for task-submitted input, as
  it does for wakes.

**Open questions**: the design graph's inquiries (`doctrine design show 6`).

## Inquiry resolutions (2026-10-29, design run revisions 12-22)

Proposals were taken one at a time with the operator; several changed in
discussion. Records: inq-1 DEC-032, inq-2 DEC-031, inq-3 DEC-033, inq-4
DEC-034, inq-5 DEC-035 (amended same day), inq-6 DEC-036 (+ addendum),
inq-7 DEC-037 (refines DEC-015), inq-8 DEC-038, inq-9 DEC-039, inq-10
DEC-040, inq-11 out of scope (non-durable note).

Changes from the proposals, and why:
- Fork: sole-call refusal and a written child tool result, after reading
  pi-durable's result pairing (`dist/harness/context.js:217-243`).
- Fork toolset: no parent backfill (dead after the startup commit); heartbeat
  needs no special case (forks copy documents, not tasks).
- Start: two tools; `brief` became `intent` + optional `context`.
- Post: no delivery bound (a dropped message is not harmless); failure
  answered to the sender.
- Bounds: depth cap dropped (loops are legitimate); origin families, reap on
  family or global overflow, tombstone, no `Conversation.abort` (it withdraws
  every queued input of the conversation).
- Topic latest: threads skipped, since every fork would otherwise capture
  its parent's topic.
- Visibility: transcript lines and faces for posts, notices and wakes.

## Design review passes (2026-10-29, design run revisions 33-60)

Informal, no RV ledger: Sol (GPT) twice, pi twice, the disposer
adjudicating, the drafter applying. Rulings landed as R1-R14 and as
decision notes on DEC-036 and DEC-044 (notice in the tombstone commit;
no `withdrawn` count; never-pruned tombstones; the reap's guarantee at
placement; faulted runs).

A further pass is not needed before locking: the last pi verify pass found
R1-R14 in place, and the operator accepted the design. What one would probe,
if run:
- The reap under concurrency: the in-commit tombstone re-read, the
  notice created only on a new tombstone, and the at-most-K-plus-overshoot
  bound when a post is placed in the moment of a reap.
- The early VTs' premises: the fork child's written `ToolResultEntry`
  (DEC-031), one follow-up placed per run, sibling withdrawal (DEC-036).
- The fork sole-call check against a mid-call append to the caller.
- The DEC-042 blast radius on wake and operator input behind a failed run.
These are carried as tests in the design's Verification section, so the
plan's phases test them rather than another design pass.

## Plan review pass (2026-10-29)

Plan authored and committed (3efcd6c): 8 phases, `plan.toml` + `plan.md`. Not yet
`doctrine slice phases`, not yet `slice status ready`. Plan deviates from design
in one place: DEC-042 (`DAEMON_SETTINGS`) is its own PHASE-02, not in the post phase.

pi first pass done (profile `review`; run artifacts
`~/.local/state/quotient/runs/run-20261028T164712520Z-1-77de3424c15d/`). 15 findings,
UNDISPOSITIONED (adjudicate under /feedback against the tree; pi's claims are evidence):
- F1 blocker: `test/wake-heartbeat.test.ts` also pins `afterFailedRun: keep` (behindFailure-style, ~274-308, used by 7 cases); PHASE-02 omits it.
- F2 major: sweep move is not "moved, not rewritten": `sweepBlockedWakes` called at 8 sites in wake-heartbeat.test.ts with pinned journal text ("blocked (task_too_old); aborting", "withdrew N queued input(s)"); `SweptKind.report` has no hook for those lines or the IndexReader.
- F3 blocker: PHASE-04 needs `Origin`/`originKey` (PostInput) but PHASE-05 creates them; move pure data to PHASE-04.
- F4 blocker: PHASE-05 breaks `test/fixtures/interactive-baseline.json` (toolsets.test.ts:140-145) and ~11 `daemonExtensions` literals (toolsets/daemon-sections/daemon-start tests) if `DaemonParts.threads` is required.
- F5 major: PHASE-04 EX-1 early premise VTs presume createPostTask/fixture from the same phase; say they drive raw Conversation.submit/abortSubmission.
- F6 major: PHASE-04 oversized; split.
- F7 major: PHASE-02 VT-1 untestable (no settings reader in pi-durable); make behavioural.
- F8 major: PHASE-04 VT-5 (faulted run) has no faux recipe; add or spike.
- F9 minor: PHASE-02 VT-2 keywords not distinctive. F10 minor: PHASE-03 VT-2 splits across conversations.test.ts and wake-tools.test.ts. F11 minor: cap constants created in PHASE-05, used in PHASE-07. F12 minor: PHASE-04 EX-7 coupling rule unenforceable; add rule to test/structure.test.ts or demote to VA. F13 minor: quote design's refusal texts verbatim. 
- F14 major: DEC-042 lands before premises (b)/(c) are proven; keep it a one-line constant with recorded rollback, or move after PHASE-04 premise tests (design's placement).
- F15 minor: journal line forms have no VT.
Also noted by me: `verify-vt` shows some keywords already present (non-distinctive: "startedBy", "marked id", "DAEMON_SETTINGS"?) — tighten.

Next: disposition under /feedback (verify F1, F2, F4 against the tree first), revise plan, commit, then Sol via codex:ask (operator's order: pi, then Sol), then `slice phases`, `slice status ready`, /super-orchestrator.

### Plan review dispositions (round 1, pi)

Plan restructured (still 8 phases): old PHASE-02 (DEC-042) dissolved into a new PHASE-03 that runs the
queue premises first, then DEC-042 (arbiter ruling on F14); tombstones moved from the post-task phase
to the caps phase; caps now precede start/fork. New order: 01 seams, 02 index, 03 premises + DEC-042,
04 post task, 05 thread_post + wiring, 06 tombstones/caps/reap, 07 start + fork, 08 visibility.

- F1 accept. `test/wake-heartbeat.test.ts:274-308` `behindFailure` asserts `queued` after `model_error`; the wake fixture opens through `openSession` (`test/wake-fixture.ts:201`), so DEC-042 reaches it. PHASE-03 EN-2 enumerates every keep-pinning case (grep, with both files as positive control); EX-3 rewrites both recipes; VT-4 pins the heartbeat rewrite.
- F2 accept-modified. 8 call sites confirmed (`wake-heartbeat.test.ts` 7, `daemon-start.ts:90`); journal lines live in `src/wake/sweep.ts:61,63`. PHASE-01 EX-2 now says call sites change, assertions stay byte-identical, the wake row is a factory over WakeDeps + IndexReader. Design-drift item if SweptKind needs a journal noun.
- F3 accept-modified. `Origin`/`originKey` land in PHASE-04, in `admission.ts` (the design's home), imported as a type; no new module.
- F4 accept-modified. Baseline exact-equality confirmed (`test/toolsets.test.ts:138-146`), but the fixture says "never regenerate": PHASE-05 EX-4 compares the snapshot without `threads` and pins the delta instead. `daemonExtensions` sites are 6, not 11 (`daemon-sections` uses a shared `HOST` const at 34): listed in EX-3. `threads` stays required, mirroring `tasks` per design.
- F5 accept. PHASE-03 EX-1: premises drive raw `Conversation.submit`/`abortSubmission` on the wake fixture; design titles kept for traceability.
- F6 accept-modified. Not split in two as proposed; instead premises moved out (PHASE-03) and tombstones moved to the reap phase (PHASE-06), which owns everything about a reap.
- F7 accept. No settings reader in pi-durable's harness `.d.ts`. Tautological VT dropped; DEC-042 is verified behaviourally (PHASE-03 VT-3..VT-5); `followUpMode` is pinned behaviourally by VT-1 running on `openSession`'s harness.
- F8 accept-modified. No faulting recipe in `test/wake-fixture.ts` (only `failingOnce` 605, `heldUntilCutOff` 516). PHASE-04 EN-2: find one first (scheduler faults a throwing invocation, `scheduler.js:1761`); if none, consult, never waive silently.
- F9 accept. Keywords now `"placed in the next run"`, `"no further input"`.
- F10 accept. Split: `test/conversations.test.ts` and `test/wake-tools.test.ts` rows (PHASE-02 VT-2, VT-3).
- F11 accept. Constants created in PHASE-05 (in thread_post's description), used by `verdict` in PHASE-06. The admit-everything stub is dropped: no tool reaches PHASE-06 needing a stub's signature.
- F12 accept-modified. `test/structure.test.ts` has an allowlist mechanism (tiers, `ROOM_DOOR_READERS`); PHASE-01 EX-4 adds the design's coupling rules there, unconditionally, with checker cases.
- F13 accept (observation confirmed: two forms, plus the start form). PHASE-01 EX-3 quotes all three verbatim. Design-drift item: `requireSameTalkSet(profile, caller, target)` has no target label, which the texts need.
- F14 accept per arbiter ruling. DEC-042 lands in PHASE-03 after premises (b)/(c); no tree evidence that placement cannot work (premises do not depend on `afterFailedRun`). F1 applied there.
- F15 accept. Journal VT keywords added: PHASE-04 VT-9, PHASE-05 VT-6, PHASE-06 VT-11, PHASE-07 VT-7.
- Also: every VT keyword grepped absent from `src/ test/ emacs/` (positive control: the same grep finds the existing title "records each create's toolset" in `test/conversations.test.ts`). Old PHASE-05 EX-5's DEC-024 guard claim was wrong (thread_post creates no conversation); the guard now gains start/fork in PHASE-07. Old EX-5's restart-reconcile log check dropped: existing `test/session.test.ts:390-404` already pins the mechanism.

Design-drift items for audit: (1) SweptKind may need a journal noun; (2) `requireSameTalkSet` needs a target label;
(3) the design says "rewritten in the post phase" for DEC-042's test rewrites; the plan puts them in the
premises phase immediately before the post-task phase.

Arbiter rulings (seat, operator asleep; reversible, logged for audit):
- F14: DEC-042 follows the premise (b)/(c) tests (design placement); premises get their own phase (PHASE-03) ahead of the post task. Design-drift item 3 for audit.
- Uncapped window PHASE-05..PHASE-06 accepted: intermediate commits only; don't run the daemon from a PHASE-05 commit.
- Spot-check: `daemonExtensions(` has ~10 test call sites (daemon-sections 6, daemon-start 3, toolsets 1), not 6; the plan must hold whichever way `DaemonParts.threads` is threaded.

### Plan review dispositions (round 2, Sol)

- S1 accept. Verified: PHASE-07 EX-1 allowed the fallback while EX-3 and VT-1 required the written result. EX-1 is now a probe that selects the path (recorded on DEC-031 and here); EX-3 writes the ToolResultEntry on the pass path only; VT-1 is path-agnostic: "a fork's child learns its parent and purpose".
- S2 accept. Verified: `markOf` returns `ThreadMark` (design § Operator visibility), absent until PHASE-08; `eslint.config.js:60-61` enforces explicit return and boundary types. `markOf` moved to PHASE-08; `isThread` stays in PHASE-02.
- S3 accept. Verified: `just check` excludes ERT (`justfile` `ert` recipe "kept out of `check`"). PHASE-08 VA-1: the orchestrator runs `nix develop -c just ert` on the host (not in the pi sandbox).
- S4 accept-modified (seat: smallest correct fix). Verified: `wakeRequestPrefix` ends in ':' (`src/wake/task.ts:126`); the design's `postRequestId` gives `post:44`, a prefix of `post:440`. Fix: `postRequestId` ends in a delimiter (`post:44:`), so SweptKind keeps one prefix contract and wake is untouched; Sol's per-kind predicate would change the contract and the wake row. PHASE-04 EX-2 states it; VT-8 adds the collision regression ("leaves post 440 queued"); PHASE-06 EX-6 matches by equality with `postRequestId`.
- Seat F4 correction: about 10 `daemonExtensions(` calls (5 spread the shared `HOST`); my "6" counted edit points. PHASE-05 EX-3 now says grep every call; the plan holds either way, since `threads` stays required as `tasks` is.
- New keywords grepped absent from `src/ test/ emacs/`.

Design-drift item for audit: (4) `postRequestId` is `post:<id>:` (design shows `post:44` and `post:<task>`).

Sol verify-only pass (resumed thread): S1-S3 fixed; S4 fixed, but the fix diverges from the locked design (`postRequestId` = `post:<id>:` vs design § "The satan.post task and its notices" `post:<id>`; also the sequence diagram and § reaping text `post:<familyTaskId>`). Seat ruling (operator asleep; reversible: one-character id format, no persisted data yet): keep the delimiter-terminated id; do not hand-edit the locked design (`design adopt` is reconcile's crossing); carried as Autonomy log drift for /audit -> /reconcile. Review stopped here per stop rule: findings narrowed to one contract-text slip.

## Implementation run
Seat: /super-orchestrator (2026-10-29, operator asleep). Main worktree, no dispatch.
- Host gate: `nix develop -c just check` (fmt-check, lint, typecheck, test). Green at 4ecb060: 87 files / 3234 tests.
- Emacs: `nix develop -c just ert` on the host (pi form has no emacs). Green at baseline. Required by PHASE-08 VA-1.
- pi form (`implement` profile): biome, eslint, `npx tsc`, vitest all green in sandbox; root writable. No form change needed.
- Known hazard: two concurrent vitest runs with coverage collide on `coverage/.tmp` (ENOENT). Never run the full suite concurrently (pi + host); workers run targeted tests with `--coverage.enabled=false`; the seat/sub-orchestrator host gate is authoritative.
- biome warns about 4 broken symlinks under `.quotient/`: harmless.
- No operator-supplied inputs needed.

## Autonomy log
- plan / F14: DEC-042 after the premise tests (design placement). decided.
- plan / caps window PHASE-05..06: accepted; no daemon run from PHASE-05 commits. decided.
- plan / S4: post request id `post:<id>:` (delimiter-terminated) diverges from design § "The satan.post task and its notices" (`post:<id>`) to avoid prefix collision (post:44 vs post:440). deferred -> /reconcile (design drift).
- plan / design-drift items 1-3 from round 1 (SweptKind journal noun; requireSameTalkSet target label; DEC-042 test rewrites in premises phase). deferred -> /reconcile.
- PHASE-01 / SweptKind gains `noun` (journal name, `wake N blocked ...`), keeping wake lines byte-identical; design-drift item 1 applied as a local correction. decided; -> /reconcile.
- PHASE-01 / requireSameTalkSet(profile, caller, target, targetLabel): the label yields `conversation 13` / `topic inbox` in the refusal; design-drift item 2 applied. decided; -> /reconcile.
- PHASE-01 / VT-2 "mixed sets" read as caller in a set, target in none (TalkSet has one value, so two distinct sets cannot exist yet). decided.
- PHASE-01 / test helper `sweepWakes(wake, read)` in wake-heartbeat.test.ts collapses the 7 sweep call sites (refactor, no expectation changed). decided.
- PHASE-02 / writeCreated takes an optional trailing `startedBy`; cwd lookup is exported `topicCwd(index, topic, defaults, requested?)` (design names no function). decided.
- PHASE-03 / premises (b),(c) HOLD (test/queue-premises.test.ts); outcome appended to DEC-036; DAEMON_SETTINGS landed after. decided.
- PHASE-03 / every EN-2 case kept via a held run (behindHeldRun; heldUntilCutOff across close/reopen); none removed. wake-wait gains VT-3g/h/i (placed in the next run, no further input; one-shot, heartbeat, across a reopen). VT-3a restored to a failed foreground run (worker had moved it to a held run; the failed run now continues, which is the sharper claim). decided.
- PHASE-03 / wake notify body "heartbeat unanswered (queued behind a failed run?)" is stale under DEC-042. deferred -> CHR-005.
- PHASE-04 / shared task helpers (SATAN_CALL_DEADLINE_MS, scheduledKey(conversation), notifyBestEffort, reasonOf) moved from src/wake/task.ts to new neutral src/task-support.ts; wake and threads both use it (no copy). Design § Code impact names no such module. decided; -> /reconcile.
- PHASE-04 / texts the design leaves open: notify titles `SATAN thread notice failed` (failed notice) and `SATAN post blocked` (blocked post); blocked report line `post N failed: blocked (<reason>) origin K` / `notice N to C failed: blocked (<reason>) origin K`; abort reasons `aborted`, `not admitted`, `aborted while placed`. decided; -> /reconcile.
- PHASE-04 / extension.ts also exports `threadBinding()` (mirrors wakeBinding). Entry data is the whole input incl. `to` plus taskId (design example omits `to`). decided.
- PHASE-04 / VT-4 faulted recipe without patching pi-durable: a faux response carrying a bigint `responseId` makes the assistant-entry commit reject, so the run faults (`unanswered`, reason `faulted`). VT-5 "submit throws" seeds a write submission under the same request id. Notice `target unreachable` is only reachable via a notice task owned by another conversation (createPostTask validates its owner). decided.
- PHASE-05 / malformed input entries (a satan.wake without episodeClass, a satan.post without a valid origin) throw an invariant error rather than being skipped, so the scan never inherits an older origin; `isOrigin` moved to admission.ts and reused by task.ts's `isPostInput`. decided.
- PHASE-05 / refusal texts the design leaves open: `no conversation N` (also a non-integer `to`), `conversation N is not in a topic (a task's conversation)`, `this conversation has no index entry`; admission refusals are a `Refusal` error class mapped to an isError result, other errors propagate. Admission reads live in `admitPost(tx, profile, caller, to)` (admission.ts). decided; -> /reconcile.
- PHASE-05 / `answer`/`refusal` tool-result helpers moved from src/wake/tools.ts to new src/tool-results.ts, shared with src/threads/tools.ts (design § Code impact lists wake/tools.ts as unchanged; refactor only). decided; -> /reconcile.
- PHASE-05 / `startWakes` renamed `startRoomTasks` (sweeps wake and post rows, then the heartbeat). decided.
- PHASE-05 / THREADS_SECTION joins each design paragraph into one line, paragraphs separated by a blank line. decided.
- PHASE-05 / task.ts abort handler's settled-and-done branch still uncovered (needs an abort racing a done submission; not cheap). deferred -> /audit.
- PHASE-06 / familiesOf and verdict in new src/threads/caps.ts; the reap (reapIn, withdrawFamily, afterReap) in new src/threads/reap.ts (design § Code impact puts both in admission.ts, which keeps the reads). decided; -> /reconcile.
- PHASE-06 / Origin, originKey, isOrigin moved from admission.ts to new src/threads/origin.ts, breaking an admission<->tombstones import cycle; admission now imports POST_KIND from task.ts (its local copy removed). decided; -> /reconcile.
- PHASE-06 / reap-own refusal text `origin K was reaped for fan-out: <reason>; posts and thread starts from it are refused` (design gives none); `reapedRefusal(origin, reason?)` in tombstones.ts owns both texts. decided; -> /reconcile.
- PHASE-06 / ThreadsDocument unexported; `threadsDoc(tx)` the one accessor (EX-1). admitPost returns the reaped key set from its one read; thread_post = admission commit, inspect, verdict, then the reap-own commit or one creating commit that re-runs admitPost. `decided`/`branched` in tools.ts are the reusable steps for PHASE-07. decided.
- PHASE-06 / VT-1 "passed its check, restarted before submit" realised as create + tombstone, close, reopen: the check commits nothing, so the durable state is identical. decided.
- PHASE-06 / VT-7 seams without product change: a registered post task whose `initial` throws for letter post (pi-durable runs it inside createTask, after reapIn wrote); the in-commit refusal interleaved by wrapping deps.harness.inspect. decided.
- PHASE-06 / "reaped families are not counted" is unobservable end to end (withdrawn tasks settle before the next count); covered by the pure familiesOf tests only. decided.
- PHASE-06 / tools.ts reapOwn branch "another conversation reaped between admission and the reap-own commit" uncovered. deferred -> /audit.
- PHASE-07 / EX-1 premise (a) HOLDS: a tool's own commit forks at the latest entry and appends the child's ToolResultEntry; the child reads it, no synthetic 'unavailable' (test/threads-fork.test.ts probe, kept). Outcome appended to DEC-031; written-result path taken, fallback not built. decided.
- PHASE-07 / indexConversation throws `conversation N: fork of P, which has no toolset` (design gives no text); a fork's parent must have an entry (DEFAULT_TOPIC fallback dropped). session.ts reads the index through new `readIndexDoc(tx)` in topics.ts (a test pins IndexDocument to topics.ts). decided; -> /reconcile.
- PHASE-07 / admission split: `admitCaller` (caller entry, origin, tombstone; returns toolset and the index it read), `admitPost` and `admitStart(tx, caller, topic?)` build on it; fork uses `admitCaller`. `refuseOutsideTalkSet` maps the talk-set throw to a Refusal for post and start. Refusal precedence moved: a reaped origin now refuses before target checks. `decided(call, admit)` takes the admission. decided; -> /reconcile.
- PHASE-07 / thread_fork description fills the design's `…` with "intent: why it exists, about a sentence; context: optional material." and "Refused over the post caps." decided; -> /reconcile.
- PHASE-07 / worker D added an optional `SessionOptions.settings` override in src/session.ts to script compaction; removed (the daemon's own policy compacts on `Conversation.compact()`, test passes without it). decided.
- PHASE-07 / DEC-024 guard (conversations.test.ts) registers the real threads extension in place of ROOM_UNION's name-only stub and drives thread_start/thread_fork; thread-fixture gained `callerThread`/`attemptCall`/`answeredChild` etc. (moved from threads-tools.test.ts). decided.
- PHASE-08 / post-failed and family-reaped lines carry no body (design table gives the header only); post body is intent then context, one per line; both presentations share one `inputLine` (`[kind] header`, then body). decided; -> /reconcile.
- PHASE-08 / Emacs: `[wake] scheduled by ...` is also a speaker label, in `malebolge-user-face`, so a wake's intent is not coloured as SATAN's turn (design names only the post label). `malebolge--label-face` rewritten as an explicit first-match loop. decided; -> /reconcile.
- PHASE-08 / render.ts guards wake entry data locally (`isWakeEntry`, reusing `isEpisodeClass`); wake exports no entry-data guard. List pages build marks via private `marksOf(index, ids)`; scanPage reads the index in its scan commit. decided.

### PHASE-03 blast radius (EX-5)
- Wake one-shot and heartbeat: an input queued behind a failed run is now placed in the next run and answered (VT-3g/h/i); no journal `failed:` line, no notify. The 2h bound now only fires behind a run that is still going (held) or a faulted run.
- Abort handler: unchanged; a withdrawn input is not revived by the failed run continuing (VT-3a).
- Start sweep: unchanged behaviour; its cases now get their queued input from a held run, which survives close/reopen (pi-durable re-runs the cut-off turn on reopen; queued inputs stay queued).
- Operator input: queued behind a failed run, answered in the next run (session.test.ts).

## Pi passes (implementation)
- PHASE-01: 4 parallel `implement` runs (A lateBinding, B task-sweep, C talk sets, D structure rules), ~$0.06 total, all green first time. Misses: D named its may-import predicate `crosses` (inverted polarity; renamed `seamAllows`); B left 7 repeated 4-line sweep calls (helper extracted). Sandbox: repo-local biome binary missing, workers used nix biome 2.5.15.
- PHASE-02: 1 `implement` run, green first time; added shared `startThread` fixture in test/harness-fixture.ts; replaced private creationCwd with exported `topicCwd`. No misses found on review.
- PHASE-03: 3 `implement` runs (A premises $0.03, B wake-wait+session $0.12 incl. one ceiling continuation, C heartbeat $0.06), all green. Misses: B moved VT-3a off its failed run needlessly (restored); B hit the request ceiling mid-format (continued). Finding: heldTurn ignores the abort signal, so a close with one in flight hangs; use heldUntilCutOff across a close.
- PHASE-04: 3 `implement` runs + 3 ceiling continuations (~$0.31). Both main runs hit the ~60-request ceiling; split the phase earlier next time. Misses: notice built from a second postTask definition; journal before the settling commit; stale part-1 comments; VT-8 written against a fully stubbed harness (rewritten by a third run against a real task_too_old post). Coverage gap: abort handler's settled-done branch untested.
- PHASE-05: 4 `implement` runs (A origin $0.04; B1 tool+section $0.07 + continuation $0.03; B2 refusal tests $0.03; C catalog+wiring $0.07 + continuation $0.01), ~$0.25. B1 and C each hit the ~60-request ceiling (B1 probing pi-durable id internals; C on a daemon-start test). Misses: A skipped malformed input entries (would inherit an older origin; now throws); B1 duplicated wake's answer/refusal (extracted); C titled a daemon-start case `VT-5` (renamed EX-3) and its VT-5 section check ignored key order (prompt order asserted).
- PHASE-06: 5 `implement` runs (A tombstones $0.06, B caps $0.05 parallel with A; C reap $0.09; D refactor + global cap/VT-7 $0.09; E concurrency/crash $0.08), ~$0.37, no ceiling hits (C used 60 requests exactly). Misses: A left an admission<->tombstones import cycle (origin.ts extracted by hand) and duplicated the tombstone read in task.ts (folded); C threaded 5-6 positional params through tools.ts (D bundled them in `Call`); D's VT-7 rollback test accepted either outcome (E pinned it). My spec B arithmetic was wrong (4+4+3+1=12); B caught it.
- PHASE-07: 5 `implement` runs + 2 ceiling continuations (A probe $0.05, B hook/session $0.05 parallel with A; C admission+start $0.08+$0.02; D fork $0.12+$0.003; E guard $0.08), ~$0.41. C and D hit the 60-request ceiling. Misses: C left an unused `profile` param, a duplicated talk-set try/catch and a duplicated journal tail (D folded them); D added a product settings seam to script compaction (removed; not needed); C's cwd test could not tell the default from the caller's cwd (E tightened). B created and removed a scratch git worktree to check a concurrent failure (no residue).
- PHASE-08: 3 `implement` runs (A list marks $0.06 parallel with C Emacs $0.07; B input lines $0.04), ~$0.17, no ceiling hits, ERT green first run on host. Misses: B duplicated the episode-class check (now reuses `isEpisodeClass`); A and B could not run biome in the sandbox (2 files reformatted on host).

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-29 · plan authored (not yet ready), pi review findings recorded · head 3efcd6c + this notes edit

### Produced
- RSK-002, RFC-003 (framing); `research/research.md`; EVD-002
- DEC-031..DEC-046; amendments noted on DEC-034, DEC-035, DEC-036, DEC-040, DEC-042, DEC-044; DEC-015 refined
- minted: CHR-004, IMP-019, IMP-020, IDE-003, IDE-004, RSK-003
- `design.md` (13 sections, locked); RV-017 (design review, waived)
- `plan.toml` / `plan.md` (8 phases), commit 3efcd6c; pi plan-review findings F1-F15 (§ Plan review pass)

### Learned
- EVD-002 — fork inside a tool call
- `mem.fact.doctrine.design-section-order` — design.md orders sections by id as text; selector steps need an explicit discharge
- `slice verify-vt` passes keyword-only on text already in the test file: titles must be genuinely new

### Open
- plan review: pi F1-F15 undispositioned; then Sol (codex:ask) pass; then phases/ready
- DEC-031 premise VT (PHASE-06), DEC-036 premise VTs (PHASE-04): first VTs of their phases
- DEC-042 placement (PHASE-02 vs design's post phase): pi F14 contests it
- RFC-003 OQ-1, OQ-2, OQ-4, OQ-7, OQ-8
- doctrine tool: lexical sort of `sec-N` ids, no reorder verb; belongs in doctrine's backlog
