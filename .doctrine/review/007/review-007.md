# Review RV-007 — reconciliation of SL-002

Adversarial-review ledger. Structured findings live in the sister
ledger toml; this prose companion carries the reviewer's framing.

## Brief

<!-- Pre-reading + lines of attack: what this review is probing, the invariants
     it must hold the subject to, and where the bodies are likely buried. Seeded
     at `review new`; the reviewer fills it before raising findings. -->

**Mode.** Conformance audit of a self-driven slice (raiser and responder are the
same agent), against the locked design (`design.md`, rev 37), the four phase
sheets, `plan.toml`, DEC-007..DEC-010, and the two prior passes (RV-005, RV-006).
Surface reviewed: the primary checkout at `a21cbb3`, four phases `completed`.

The subject is a *removal-shaped* slice in reverse — it adds a frame, a flag and an
Emacs path — so the invariants this audit holds it to are:

1. **Nothing binds or persists on a listing.** A `list` first line answers one
   framed reply and closes; no conversation, no cursor, no durable state.
2. **One shipped message vocabulary.** `FrameRefused` names the frame it refused;
   every shipped `attach: …` string stays byte-identical; the bound-connection
   refusal stays unprefixed.
3. **One transport, one output path.** The listing shares `connectOrExplain`,
   `lineSplitter` and the renderer; ids reach stdout and nothing else does; prose
   reaches stderr and nothing else does.
4. **The client's failure contract is coded, not a stack trace** — and the wait it
   claims is a wait it actually bounds.
5. **The docs say what ships.** The page limit, the waits, the truncation text and
   the skew rule are claims about code; they are checked against code and against a
   live client, not against the design's prose.
6. **The registry tells the truth** — `slice conformance` reads the selector
   registry, so a declared-but-undelivered path is a finding, not a statistic.

Lines of attack, in the order they were worked:

- Run the algebra first (`slice conformance`, `slice verify-vt`, `check gate`),
  then the gate itself and the two Emacs suites, then diff-read the four commits
  against the sections that prescribe them.
- Treat every number in README/internals as a hypothesis; verify the ones a user
  would rely on against a live fake daemon (`--list` against 50 ids, a pre-`list`
  daemon, no daemon, and a daemon that never answers).
- Read DEC-007..DEC-010 as *governance*, not background: an accepted decision that
  the implementation has moved past is drift even when the design is right.
- Re-derive the container's known-red set rather than trusting the notes for it.


## Synthesis

**The slice delivered what it designed, and the code is the part that holds.** All
four phases are `completed` and `verify-vt 2` is green on every VT of every phase
(16/16). The 16 `design-target` paths the registry declares are the 16 the four
commits touched, with one stale declaration (F-4) and no undeclared edits. The work
is one coherent mechanism: a second first-line frame that reads one descending page
of ownerless conversations and closes cleanly; a client mode that prints ids to
stdout and prose to stderr through the one renderer; an Emacs picker behind a prefix
argument in the fixed order list → prompt → draft check → detach → attach; and two
documents that describe all of it.

The audit found **no code defect**. Every invariant in the Brief held when checked
against code and against a live client:

- Nothing binds or persists on a listing. `finish` is the only daemon-side close,
  `fail` delegates to it, and the connection's queue drops every later line
  (`src/daemon.ts:265-275`). Verified in the suite and by reading the seam.
- The message vocabulary is one. `FrameRefused` names its frame; the bound-connection
  refusal stays unprefixed in both branches; `attach`'s shipped refusals are pinned
  byte-identical by an exact-message table.
- One transport, one output path, two streams. `listConversations` shares
  `connectOrExplain`, `lineSplitter` and the renderer, ignores the snapshot a
  pre-`list` daemon sends first, and never re-sorts what the daemon sent.
- The failure contract is coded: `NOT_LISTED` reaches `attach-main`'s exit-1 path,
  and the two failure cases behave as designed — a pre-`list` daemon produces the
  restart hint with an empty stdout, and no daemon produces one line in 1.06 s.
- The docs' factual claims are true. Page limit, connect budget, truncation text,
  the two exit codes and the root escape hatch were all verified against a live
  client, not against the design's prose.

**What the audit did find is drift in the prose layer, in three directions.** The
design prescribes a signature that cannot meet its own requirement (F-2). An
accepted decision still describes the previous pass's mechanism — merged stderr, a
ten-second bound — while the design leans on an unrecorded five-second bound in
Emacs for the very guarantee it claims (F-1). And two documents state things that
are one line too strong or one test too thin (F-3, F-8). None of this is a behaviour
bug; all of it is the kind of thing that makes a future agent implement the wrong
seam, which is exactly what the reconciliation brief exists to prevent.

**Standing risks, accepted or owned.**

- *The listing's reply is unbounded* (IMP-006). Measured today: a daemon that
  accepts the frame and answers nothing holds the CLI indefinitely. Emacs is safe
  because of its own five-second bound; a script is not. Accepted for this slice,
  owned by IMP-006.
- *A piped stdout can be cut* (IMP-007). `attach-main` exits immediately after the
  await. At `LIST_PAGE`'s 50 short ids this never bites (measured: 50/50 lines
  arrive), and it is the shipped client idiom, so the fix is its own change.
- *Documented constants have no test behind them* (F-8 → IMP-008).
- *The container's eleven runner reds* stay red (F-6, tolerated).

**Tradeoffs consciously accepted by the design, re-affirmed here.** Bare numeric
ids (labels are RFC-002 step 4); one buffer pair with a switch rather than a buffer
per conversation; no version handshake, only a message-shaped skew rule (satan
ISS-055 retires it); and a reachable-by-id escape hatch instead of a pager.

**F-5's fix, recorded.** The duplicate backlog item is resolved: IMP-005 (filed in
PHASE-01) closed as a duplicate of CHR-001 (filed by RV-004 F-8), with IMP-005's
Detail and Options folded into CHR-001's prose first, so one chore owns it and
nothing was lost. `doctrine supersede` was tried and correctly refused a
cross-family supersession.

**Depth note.** The audit ran the algebra (`slice conformance`, `verify-vt`,
`check gate`), the gate's components, `just ert` (38/38) and `just smoke` (4/4),
diff-read all four commits against the sections that prescribe them, re-derived the
container's red set with `GIT_GUARD=off`, and drove the shipped CLI against four
fake daemons (a 50-id page, a pre-`list` daemon, no daemon, a silent daemon). It
read DEC-007..DEC-010 as governance rather than background, which is what turned
F-1 from an observation into a finding.

## Reconciliation Brief

Findings are terminal; the writes below are `/reconcile`'s. Every item names the
surface that will actually be touched.

### Per-slice (direct edit)

- **design.md sec-5** (F-1): in the step-1 paragraph, name the bound that makes the
  "does not freeze the editor silently" claim true — `malebolge--list-timeout`
  (5.0 s, `emacs/malebolge.el:220`) with `malebolge--await-listing`, which deletes
  the client and signals `user-error` — and note that the client's own reply bound
  is IMP-006's. The current sentence reads as if `LIST_WAIT` bounded the reply.
- **design.md sec-4** (F-2): the `listConversations` signature gains
  `errors: Writable` (between `output` and `wait`), with a clause on why: the module
  stays off `process.*`, and `attach-main` supplies `process.stdout` and
  `process.stderr` so a dead daemon's notice never lands on stdout.
- **README.md:142-145** (F-3): a failed listing prints the client's one error line
  and, for a daemon that predates `list`, the restart hint; it exits 1 and never
  prints a stack trace. (The code is right — `failListing` mirrors attach's skew
  path — so only the sentence changes.)

### Registry (selector verb, not prose)

- **`doctrine slice selector add SL-002 --intent scope-relevant test/fixtures.ts`**
  (F-4): the slice never edited that file, and the shared fake-daemon fixture is
  IMP-003, so the `design-target` intent is a stale declaration. Then re-run
  `doctrine slice conformance SL-002`; the target shape is 0 undeclared /
  0 undelivered / 16 conformant. There is no design §6 selector mirror in this
  project's template, so no prose edit accompanies this.

### Governance/spec (REV)

- **DEC-009** (F-1): a REV amendment, since its Choice still says "stderr merged,
  bounded by the client's own 10 s connect wait". The amendment records: stderr kept
  in its own buffer (the truncation prose must not become a picker candidate,
  RV-005 F-12); the listing's connect wait is `LIST_WAIT` (1 s) and the reply itself
  is unbounded — measured 2026-10-24 against a silent daemon, ≥20 s — so IMP-006
  owns the client-side bound; and Emacs's five-second `malebolge--list-timeout` is
  the defence that keeps the picker responsive. DEC-008 already carries the
  parallel amendment for its own wait, and design sec-4 points at it.

### Not brief items

- `plan.toml` PHASE-02 EX-2 repeats the four-parameter `listConversations`
  signature. Plan criteria are immutable-append and off the reconcile write surface,
  so it stays as written; the design is the reconcilable artefact.
- IMP-005 (F-5), IMP-008 (F-8) and CHR-001 are backlog state, already reconciled
  in this pass.
