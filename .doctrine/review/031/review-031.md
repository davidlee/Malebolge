# Review RV-031 — reconciliation of SL-011

Adversarial-review ledger. Structured findings live in the sister
ledger toml; this prose companion carries the reviewer's framing.

## Brief

<!-- Pre-reading + lines of attack: what this review is probing, the invariants
     it must hold the subject to, and where the bodies are likely buried. Seeded
     at `review new`; the reviewer fills it before raising findings. -->

Mode: conformance (self-audit; one agent drives raiser and responder via `--as`).
Surface: the primary tree at `main` 6c2f699 (not dispatched; /super-orchestrator
with pi workers in the main worktree).

Lines of attack:

1. `slice conformance SL-011`: every undeclared path and undelivered selector.
2. Plan VT/VA/VH criteria: `slice verify-vt` (all VTs), the VA greps re-run,
   VH-1's waiver and what it leaves unexercised.
3. The gate: `just check` at HEAD; the 4186→4182 test count dip at PHASE-04
   (01ef085). Were only bridge-toolset cases dropped?
4. Design prose against code: notes § Autonomy log lines marked "flag for
   audit" (helper names, `liveToolset` form, the bridge-entry skip, the pair
   event shape).
5. Work outside the plan: operator-directed pi prompt changes (6eaa43e,
   ffb8d61, e9698dc). Are they accurate to the code? Are they in the design? Do
   governance (DEC-040, DEC-072, DEC-098) and backlog (CHR-008, IMP-030) still
   tell the truth?
6. Docs (PHASE-08 EX-1, VA-1): README and internals against current behaviour.

Invariants held: DEC-099..107 as locked in design.md (0c2c9f2); DEC-025
(no mode change); mail stays off the bridge.

## Synthesis

**Closure story.** SL-011 delivers what the locked design commits to. pair
binds an existing interactive conversation by id, or the one attached
conversation. It refuses unknown, non-decimal and non-interactive targets,
an over-long project, and no or several attached clients, and it writes
nothing on a refusal. A new pair replaces the old pairing: the old connection
closes `superseded by a new pairing`, the seq continues, and a stale line is
refused. The `bridge` toolset is retired, and startup reconcile rewrites
stored `bridge` records once. Every room interactive conversation carries the
untrusted framing, forks included. A bridge turn opens its own thread origin.
pi pairs a named conversation.

Evidence:
- `slice verify-vt`: all 19 VTs across PHASE-01..07 pass.
- `just check` at 6c2f699: 115 files, 4198 tests, green.
- The plan's VA greps (PHASE-02, PHASE-04) are empty, as specified.
- Conformance: 31 paths conformant, 0 undelivered.

**What diverged, and how it lands.** No behaviour defect was found. The
findings are record drift:
- The design's prose names three shapes the code refined without changing
  behaviour, and one test home (F-1).
- Three operator-directed pi prompt commits land outside the design and the
  selectors (F-2). One comment-only touch is undeclared (F-3).
- The docs, a code comment and CHR-008 misdescribed the posture-text status
  (F-4, fixed in this audit's commit).
- DEC-098 says less than the mechanism does (F-6).

`/reconcile` writes these (brief below).

**Standing risks.**
- SATAN's and pi's environment texts disagree on comparing files (F-5,
  IMP-030, awaiting the operator).
- VH-1 was waived. Live two-client refusal, mail refusal and two-session
  replacement have only VT evidence (F-8).
- Design-recorded residuals stand: a superseded connection's in-flight line
  may act once (sec-4). Abort downgrades buffered bridge turns (DEC-079/090).

**Tradeoffs consciously accepted.**
- The conformance registry carries SL-012's interleaved paths (F-7).
- PHASE-08 VA-1 is read by intent over its literal regex (F-9).
- bridge_post's new description clause has no VT, by the operator's
  no-prompt-phrase-tests rule. Verified by reading src/bridge/extension.ts:60.

**Outside this slice.** `doctrine check gate` cannot run because the
justfile has no `gate` recipe. CHR-001 already owns that. `just check` was
used as the gate.

## Reconciliation Brief

### Per-slice (direct edit)
- F-2 (load-bearing): `doctrine slice selector add` a design-target selector
  for `pi-bridge/posture.ts`. Mirror it in SL-011 design.md:
  - sec-7: replace "The `malebolge-bridge` command and env are unchanged"
    with: the command is unchanged; pi's prompt (`PI_BRIDGE_ENVIRONMENT`)
    names the command, its exit codes, the commit-named shared-reference rule
    and own-side checks; `PI_POSTURE_TEXT` carries the operator's consult and
    delegate texts. Cite 6eaa43e, ffb8d61, e9698dc and DEC-072.
  - sec-8: add a `pi-bridge/posture.ts` row.
- F-3 (load-bearing): `doctrine slice selector add` a design-target selector
  for `src/wake/tools.ts`. Mirror it in a sec-8 row: a stale comment
  corrected when the toolset was retired.
- F-1: SL-011 design.md:
  - sec-3: `liveToolset` is `t === "bridge" ? "interactive" : t`. Drop the
    RETIRED table from the sketch, with the reason: no narrowing without a
    cast.
  - sec-4 Target: replace `attachedTarget(host)` with `pairTarget(host,
    frame)`, which runs the project-length and id checks before the commit,
    and `openPairOn(host, id, frame, token)`, which runs the commit.
  - sec-4 Attached set: `() => socket.attached()`.
  - sec-6: a `satan.bridge` entry with no readable `data.kind` opens no
    origin, like a note.
  - sec-9 table: the section and fork cases live in
    test/daemon-sections.test.ts.
- design sec-10 (carried, not an audit finding): SL-009 design.md's pairing,
  bridge-mode and `<project>-bridge` sections gain a pointer to SL-011
  (superseded by DEC-099, 100, 104). Its outbox section notes that seq
  continues across pairings (DEC-106 refines DEC-066).

### Governance/spec (REV)
- F-6: DEC-098, choice. Change "only bridge_post crosses" to: only
  bridge_post crosses, and from pi also the `malebolge-bridge` command
  (DEC-075). Amend the record (knowledge edit, or a REV if the record is
  governed by one).

### Not for reconcile
- F-4: fixed in the audit commit (docs, comment, CHR-008 body).
- F-5: IMP-030 (backlog, operator decision).
- F-7, F-8: tolerated. F-9, F-10: aligned.
