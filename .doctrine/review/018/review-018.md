# Review RV-018 — reconciliation of SL-006

Adversarial-review ledger. Structured findings live in the sister
ledger toml; this prose companion carries the reviewer's framing.

## Brief

<!-- Pre-reading + lines of attack: what this review is probing, the invariants
     it must hold the subject to, and where the bodies are likely buried. Seeded
     at `review new`; the reviewer fills it before raising findings. -->

Mode: **conformance** (self-audit; `--as auditor` raises, `--as implementer`
disposes). Surface: the primary checkout at `5569843` (main). Not dispatched:
phases ran under /super-orchestrator in the main worktree.

Lines of attack:

1. **Path conformance.** `doctrine slice conformance 6`: 22 undeclared, 0
   undelivered, 36 conformant. Each undeclared path is a lead: new modules the
   design did not name (`src/task-support.ts`, `src/tool-results.ts`), wake
   files the design called unchanged, test files outside the selectors.
2. **Design drift logged during the run.** The notes' Autonomy log defers
   items to /reconcile: `postRequestId` delimiter (S4), SweptKind `noun`,
   `requireSameTalkSet` target label, DEC-042 test-rewrite placement, module
   splits (`caps.ts`, `reap.ts`, `origin.ts`, `task-support.ts`,
   `tool-results.ts`), refusal/notify texts the design left open, admission
   split and refusal precedence, fork-parent invariant text, input-line
   bodies, `[wake]` face, and the user-directed THREADS_SECTION advice. Each
   must be checked against `design.md` and routed.
3. **Items deferred to audit.** Two uncovered branches (`src/threads/task.ts`
   abort handler settled-and-done; `src/threads/tools.ts` reap-own race) and
   the README `--list` text.
4. **Verification criteria.** Every phase VT has a test (`slice verify-vt`);
   VH-1 passed (operator, 2026-10-29); VA-1 (ERT) green.
5. **Gate.** `nix develop -c just check` and `just ert` green at HEAD;
   `doctrine check gate`.
6. **Invariants held to the design.** Talk-set refusal for mail/host; fork is
   sole-call and model-only; thread tools run sequentially (DEC-041); reap's
   first commit writes tombstone + notice together (DEC-044); tombstones never
   pruned; `latestIn` skips threads; DEC-024 guard covers start and fork.
7. **Registry coverage.** Post-run commits `40461df`, `d7082b0` landed after
   PHASE-08 closed.

## Synthesis

**Closure story.** SL-006 delivered what its scope promised: `thread_start`,
`thread_fork` and `thread_post` in the room's interactive talk set; the
durable `satan.post` task with `<post-failed>` outcomes; origin families
capped at 4 per origin and 12 daemon-wide, with a reap that writes its
tombstone and notice in one commit; IMP-017's fork branch; DEC-042
(`afterFailedRun: continue`) after its premise tests; and operator visibility
(`--list` marks, `[thread]` / `[wake]` lines, Emacs faces). Every planned
VT passes `slice verify-vt`; VH-1 passed in the room (operator, 2026-10-29);
`just check` and `just ert` (42/42) are green. Conformance is clean of
creep: 0 undelivered, and every undeclared path is in scope (F-1).

```
caller turn ──thread_* call──▶ admission (caller, origin, tombstone → target, talk set)
                                   │
                         verdict (familiesOf over harness.inspect)
                    admit │ reap-other │ reap-own
                          ▼            ▼
            one creating commit:   reap commit alone,
            child/post (+reap)     then refuse
                          │
                 satan.post task ──submit post:<id>:──▶ recipient's queue
                          │ fails
                          ▼
                 <post-failed> notice to sender
```

**What the audit changed.** Three fix-now items landed in the audit itself:
the README `--list` text (F-11); the `IndexDocument` ownership guard, which
never read subdirectories and so missed a violation in `admission.ts` (F-12);
and tests for `thread_start` and `thread_fork` reaping another family in
their own creating commit, the one cap path only `thread_post` exercised
(F-13, the only major finding; mutation-checked).

**Design drift.** Ten findings (F-1..F-10) are the design text trailing
decisions the run made and logged: a finer module split, a
delimiter-terminated request id, two widened signatures, a reordered
admission, texts the design left open, PHASE-08's line shapes, the premises
phase, and the operator-directed sender advice. None changes behaviour the
design promised; each is routed to /reconcile below.

**Standing risks** (accepted in design; not reopened): an interrupted thread
call may duplicate (DEC-043, IMP-020); counts can overshoot across concurrent
turns (DEC-036, DEC-041); a reaped family can resume through a wake (DEC-046,
RSK-003); a post placed in the moment of its reap is delivered (DEC-044). The
wake notify body still mentions a failed run (CHR-005).

**Tradeoffs accepted.** F-14 tolerates eight uncovered guard and race
branches whose consequences are pinned elsewhere. `doctrine check gate` has
no `just gate` recipe in this repo (CHR-001, already open); `just check`
stood in, as in RV-016.

Sources worth opening: `doctrine show DEC-036` (families and caps),
`doctrine show DEC-044` (reap ordering), `doctrine show DEC-040` (prompt
surface; F-8 amends it), `doctrine review show RV-018 -f 13` (the major).

## Reconciliation Brief

### Per-slice (direct edit)

- **Selector registry (F-1, load-bearing).** `doctrine slice selector add 6`
  design-target: `src/task-support.ts`, `src/tool-results.ts`,
  `src/wake/task.ts`, `src/wake/tools.ts`; `test/conversation-context.test.ts`,
  `test/daemon-sections.test.ts`, `test/daemon-start.test.ts`,
  `test/daemon.test.ts`, `test/harness-fixture.ts`,
  `test/late-binding.test.ts`, `test/queue-premises.test.ts`,
  `test/structure.test.ts`, `test/task-sweep.test.ts`,
  `test/wake-heartbeat.test.ts`, `test/wake-task.test.ts`,
  `test/wake-tools.test.ts`; `README.md` (F-11); `.doctrine/slice/006/**`; the DEC-031 and DEC-036 record
  directories; CHR-005's directories. Then `slice conformance 6` must read
  0 undeclared, 0 undelivered. Mirror in design § Code impact.
- **design.md § Code impact, § Components and boundaries (F-2).** Add
  `src/threads/origin.ts`, `caps.ts`, `reap.ts`, `src/task-support.ts`,
  `src/tool-results.ts`; admission.ts = reads (`admitCaller`, `admitPost`,
  `admitStart`); `topics.ts` gains `readIndexDoc`; `daemon-start.ts`
  `startRoomTasks`; drop wake/task.ts and wake/tools.ts from "Unchanged"
  (helpers moved out, behaviour unchanged). Update the diagram and
  responsibilities list; coupling rules stand.
- **design.md § The satan.post task, delivery sequence, § The reap (F-3).**
  `postRequestId` = `post:<id>:`, with the prefix-collision reason.
- **design.md § Components, SweptKind block (F-4).** Add `noun`.
- **design.md § Talk sets (F-5).** `requireSameTalkSet(profile, caller,
  target, targetLabel)`.
- **design.md § The thread tools, Shared steps (F-6).** Order: caller,
  origin and tombstone; then target and talk set; then verdict; then commit.
- **design.md, several sections (F-7).** Record the settled texts: refusals
  (`no conversation N`, `conversation N is not in a topic (a task's
  conversation)`, `this conversation has no index entry`, the reap-own form
  with `: <reason>`); notify titles; blocked report lines; abort reasons; the
  fork-without-toolset invariant text; thread_fork's description.
- **design.md § Prompt surface (F-8).** Quote the shipped THREADS_SECTION
  paragraph 1 and the start/fork description sentences; framing becomes
  "facts, and how a reply comes back".
- **design.md § Operator visibility, transcript lines and Emacs (F-9).**
  Header-only post-failed / family-reaped lines; post body intent then
  context; `[wake]` speaker label in `malebolge-user-face`;
  `malebolge--font-lock-keywords` a defconst.
- **design.md § Verification (F-10).** "post phase" → "premises phase
  (PHASE-03), before the post task" for premises (b)/(c) and DEC-042's
  rewrites.

### Governance/spec

- **DEC-040 (F-8).** Amendment note, as its r1 amendment was recorded: after
  VH-1 the operator directed that the threads section and start/fork
  descriptions say a thread answers only by `thread_post`, and that a sender
  ask for that reply; "facts only" now admits this one line of how-to.

## Reconciliation Outcome

Operator agreed the edit set ("agreed", 2026-10-29).

### Direct edits applied
- Selector registry (F-1): 21 design-target selectors added
  (`slice selector add 6`). `README.md` was added and then removed: its F-11
  fix landed in the audit commit (d8c5c16), which is no recorded phase
  delta, so the selector read undelivered. `slice conformance 6`: 0
  undeclared, 0 undelivered, 58 conformant.
- design.md § Components, § Code impact (F-2): `origin.ts`, `caps.ts`,
  `reap.ts`, `task-support.ts`, `tool-results.ts` in the diagram,
  responsibilities and table; admission.ts as reads; `readIndexDoc`;
  `startRoomTasks`; wake/task.ts and wake/tools.ts no longer "Unchanged";
  the `Origin` block names origin.ts.
- design.md § The satan.post task, flows diagram, § The reap (F-3):
  `post:<id>:` with the prefix-collision reason.
- design.md § Components, `SweptKind` (F-4): `noun`; `TaskId`,
  `BlockedReason` types as shipped.
- design.md § Talk sets (F-5): `targetLabel`.
- design.md § Shared steps (F-6): four steps, caller + origin + tombstone
  first. Code comments citing the old step numbers (src/threads/tools.ts,
  admission.ts) renumbered to match; comments only.
- design.md (F-7): post refusals, the reap-own refusal with its reason,
  blocked report lines and titles, abort reasons, the fork-parent invariant
  text, notification titles.
- design.md § Prompt surface (F-8): shipped THREADS_SECTION paragraph and
  start/fork descriptions; framing "facts, and how a reply comes back".
- design.md § Transcript lines, Emacs (F-9): header-only failure/reap lines;
  body intent then context; shared `inputLine`; `[wake]` speaker label;
  defconst keywords; first-match label lookup. The brief named
  `malebolge-user-face` for `[wake]`; the shipped face is
  `malebolge-wake-face` (IMP-021, 52dcfbf), and the design records that.
- design.md § Verification (F-10): premises (b)/(c) and DEC-042's rewrites
  in the premises phase (PHASE-03), before the post task.

### Governance
- DEC-040 (F-8): amendment note appended to its record body, as its r1
  amendment was. A decision record is not a REV target; no REV opened.

### Withdrawn / tolerated
- F-14: tolerated; rationale in its disposition.
- F-11..F-13: fixed in the audit (d8c5c16).

`just check` green after the edits: 96 files / 3351 tests, lint 0 warnings.
Reconcile pass complete — handoff to /close.
