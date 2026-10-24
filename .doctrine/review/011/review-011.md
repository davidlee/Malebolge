# Review RV-011 — reconciliation of SL-003

Adversarial-review ledger. Structured findings live in the sister
ledger toml; this prose companion carries the reviewer's framing.

## Brief

<!-- Pre-reading + lines of attack: what this review is probing, the invariants
     it must hold the subject to, and where the bodies are likely buried. Seeded
     at `review new`; the reviewer fills it before raising findings. -->

**Mode.** Conformance audit of a self-driven slice (raiser and responder are the
same agent), against the locked design (`design.md`, run rev 49), `plan.toml`
PHASE-01..06, DEC-007/008/010 and DEC-011..017. Surface reviewed: the primary
checkout at `7e50232`, six phases `completed`, implementation `a7ec48f..8e0534e`.

RV-010 (code review, 21 findings, all verified) is **evidence, not re-raised**.
This pass audits what RV-010 does not: whether the design, the registry, the
plan's verification mandates and governance still tell the truth after its
fixes.

Invariants the slice is held to:

1. **The index cannot lag the store** (DEC-012): every creating commit writes
   the entry; the backfill covers only pre-index conversations.
2. **One owner per concern**: `src/topics.ts` alone names `IndexDocument`;
   `src/daemon.ts` knows only `Conversations`; one request path in the client.
3. **Wire shapes widen additively** (DEC-007's rule, DEC-016), and every skew
   shape prints the restart hint.
4. **The design describes the code**, section by section, including the RV-010
   fixes that changed behaviour.
5. **Governance describes the code**: an accepted DEC the slice moved past is
   drift even when the design is right.
6. **The registry tells the truth**: conformance and `verify-vt` read
   `slice-003.toml` and `plan.toml`, so a red cell is a finding, not a
   statistic.

Lines of attack, in order worked:

- Algebra first: `slice conformance 3` (10 undeclared / 1 undelivered / 22
  conformant), `slice verify-vt 3` (4 FAIL of 21), `check gate`.
- Gates on host: `just check` (2062 passed, eslint 0 warnings), `just ert`
  38/38, `just smoke` 4/4.
- Read design sec-2..sec-6 against `src/topics.ts`, `src/session.ts`,
  `src/conversations.ts`, `src/daemon.ts`, `src/attach-invocation.ts`.
- Read the notes' Harvest/Open drift list and RV-010's design-touching
  dispositions; confirm each against the code.
- Attribute the phaseless fix commit `8e0534e` and dispose VH-1's skipped
  skew sub-check.

## Synthesis

**The slice delivered what it designed; the paper around it lags.** All six
phases are `completed`. On host, `just check` passes 2062 tests with eslint at
zero warnings, `just ert` 38/38, `just smoke` 4/4. `slice verify-vt 3` passes
21/21 after F-5's title fixes, and the user ran VH-1 on 2026-10-24.

Invariants held, checked in code at `7e50232`:

- **The index cannot lag the store.** `openSession` passes
  `conversationCreated: indexConversation` to `Harness.open`, and runs the
  backfill after `root()` and before `resume()` (`src/session.ts`). The hook
  reads documents only. Root's entry comes from the hook alone (PHASE-01 VT-2).
- **One owner per concern.** `IndexDocument` is named only in
  `src/topics.ts`, and in tests that open the document directly; a test
  enforces this. `src/daemon.ts` imports `Conversations` and never
  `topics.ts`. One `request` path serves `--list`, `--topics`, `--set-topic`
  and `resolveHere`.
- **Additive wire shapes.** New keys and the new `topics` reply only. All
  three skew shapes print the restart hint (PHASE-04 VT-3, VT-4).

What did not hold is the description:

- Governance still forbids two things the slice shipped (F-1).
- The design misses five behaviours that RV-010's fixes and the phase reviews
  added (F-2), plus four client and file-map details (F-3).
- The registry misses the module `--here` actually uses (F-4).

None of these is a code defect. Reconcile owns all three.

**Tradeoffs consciously accepted.**

- F-6: `8e0534e` stays outside every phase delta rather than being
  misattributed. All its paths are declared targets, and RV-010 is its
  evidence.
- F-7: the skew sub-check of VH-1 was conditional and is covered by test.

**Standing risks.**

- Topic opens are serialised daemon-wide (RV-010 F-6). This is correct at
  personal scale, but it is a global queue for one rare race. A busy daemon
  would want a per-topic queue.
- `--here` matches on exact path equality (RV-010 F-10, documented). A topic
  directory set through a symlink never matches.
- D2 (per-conversation project context) is still not built. A topic with its
  own directory runs tools there but gets the daemon's project context (scope
  Risks).
- `doctrine check gate` is dead in this repo until CHR-001 lands (F-8).
- Open from this slice: IMP-006 (no reply timeout), IMP-010 (pager
  duplication), ISS-001 (interactive attach throws on a non-event JSON line).

**Not findings.** `~/satan-corpus/prompts/env/host.txt` says the working
directory is the daemon's launch dir, but it is the conversation's. The file
is outside this repo, user-authored, and the user's to fix (notes § Harvest/Open).

## Reconciliation Brief

### Per-slice (direct edit)

- **F-2 → design.md sec-2** Backfill step 2: also merge a missing `parent`
  into an existing entry whose record carries one (`needsBackfill`).
- **F-2 → design.md sec-3** Attaching by topic: replace "needs no lock" with
  topic opens serialised daemon-wide (`serially(openTopic)`), so concurrent
  attaches to an empty topic start one conversation. The topic-cwd-race
  sentence (old directory on a concurrent change) still stands. Fix
  `attach: no topic <name>` → `no topic X` (unprefixed, as sec-4).
- **F-2 → design.md sec-4** table: the attach-by-topic row adds
  `new must be true`. The `topic` row adds
  `cwd must not contain a control character`.
- **F-3 → design.md sec-5** flag table: add `--set-topic NAME --here`.
  `--here` step 1: the nearest ancestor holding `.git` (`gitRootOf`,
  `src/project-context.ts`), not `git rev-parse`.
- **F-3 → design.md sec-6** table: add `src/project-context.ts` (`gitRootOf`)
  and `test/project-context.test.ts`. `src/topics.ts`'s write is
  `writeTopicRecord` (plus `storedTopic`); `setTopic` is the `Conversations`
  method. Drop `test/session.test.ts` from the test row.

### Registry (selector verb, not prose)

- **F-4:** `doctrine slice selector add 3 src/project-context.ts`
  (design-target), and `doctrine slice selector rm 3 test/session.test.ts`.
  Mirror in sec-6 (above). Re-run `slice conformance 3`: expect no
  undeclared `src/` path and no undelivered target.

### Decisions (direct edit, appended amendment — a DEC is not a REV target)

- **F-1 → DEC-007:** the `list` frame now takes `topic` and `topics`. The
  `list: unknown key topic` refusal is retired; a different unknown key (e.g.
  `page`) keeps the shipped shape. New first-line `topic` frame and new
  `topics` reply (DEC-016). The widening rule held.
- **F-1 → DEC-008:** the exclusivity set adds `--topic`, `--topics`,
  `--set-topic`, `--dir`/`--no-dir`, `--here`, per design sec-5 (DEC-017).
- **F-1 → DEC-010:** `--here` moves from refused to host-only, resolved
  against the daemon-reported profile (DEC-014). Labels and paging stay
  refused.

### Governance/spec (REV)

- None. The repo has no ADR, POL, STD or SPEC (design triage).

### Not brief items

- F-5 fixed in the audit (test titles). F-6 tolerated, F-7 aligned. F-8
  already owned by CHR-001. `host.txt` is the user's corpus.
