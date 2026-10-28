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
