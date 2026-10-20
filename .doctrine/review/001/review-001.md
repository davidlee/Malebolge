# Review RV-001 — code-review of IMP-002

Adversarial-review ledger. Structured findings live in the sister
ledger toml; this prose companion carries the reviewer's framing.

## Brief

Requested frame: coupling, cohesion and function/file-level structure — *not*
style — to inform what should move where in future. So the review weighs two
things a line-level review would not: whether the tree expresses the boundaries
the code already obeys, and whether this repository can state the reasons its
own structure exists.

Lines of attack, in the order the evidence was gathered:

1. **The seam, computed not assumed.** An import census over all 26 non-entry
   modules (fan-in and fan-out, resolved from specifiers) to establish the
   dependency direction, the real contract set, and whether any arrow runs the
   wrong way. Claims like "the runner is a separate program" are only worth the
   arrow that proves them.
2. **Function and file shape.** A TypeScript-AST census of all 879 functions
   (length, branch count) before reading any file, so "too long" and "too
   complex" are measured rather than presumed. This is where the review
   expected to find its blockers.
3. **Cohesion per module**: what each file *knows*, judged against its stated
   purpose (its header), not against an ideal size. The largest files were
   opened in full.
4. **The governance claim.** The code cites invariants constantly (`I13`,
   `EX-8`, `satan:DEC-055`, `EVD-008`, `R1`, … — doc-local labels of the SATAN slice
   and spec corpus, `satan:SL-023`–`satan:SL-026` and `satan:SPEC-004`).
   Checked whether any of them resolve
   in this repository, and what `docs/` and `.doctrine/` actually hold.
5. **The duplication axis**: independent spellings of one concept — exported
   names, error-message extraction, request-id and branch-name literals,
   environment helpers — because duplication is what makes a future move
   expensive.
6. **Test shape as evidence of structure**: whether the test tree mirrors the
   boundaries the source leaves implicit, and whether units are reachable
   without a world.

Deliberate non-targets: formatting and lint (tooling owns them), the
`package.json`/flake packaging, and the live spike scripts — the latter are
wired into `justfile` on purpose, and calling them litter would be a
manufactured finding.

## Synthesis

**Overall: solid.**

**Synopsis.** Structurally, this is the best-proportioned codebase of its size
I have reviewed: the pathologies the review expected are absent, and the ones
present are about *legibility of structure*, not the structure itself.

What earns the verdict. Function-level discipline is not a matter of taste
here — it is measured: 879 functions, the longest 82 lines, the highest branch
count under 12. File-level cohesion is deliberate and documented: `vocab.ts` is
data only and says so; `jobs.ts` is rules-as-data, including the restart
recovery table as an ordered array of matchers rather than a nest of
conditionals; `classify.ts` decides meaning while `git.ts` collects facts;
`ending.ts` is 59 lines because the `collecting` payload has exactly one
correct shape. Coupling is *injected*, everywhere, through narrow capability
shapes (`Pick<JobStore, "transition">`, a `Meter`, a `GitChannel`, a
`SourceReader`) — which is why almost every mechanism module is testable
without a room, a model or a database. The two genuine architectural
boundaries are enforced rather than intended: `room.ts` owns the door and
`test/runner/room.test.ts` fails if another file names it; `project-context.ts`
owns the policy and injects the acquisition, so one pipeline serves a daemon
reading node fs and a runner reading a room shell. And the runner's hard parts
are hard *for reasons that are written down at the point of difficulty* — the
ordering note at the head of `run.ts` is genuinely useful prose, not a comment.

What the 👍 does not cover. Three things, in cost order. First, the seam
between the two programs exists and runs one way, but lives only in the
convention of who has been importing what; the test tree states it and the
source tree does not (F-1). Second, the runner — four fifths of the source —
is accounted for here only as product behaviour; its rules are cited by label
against a foreign corpus, so a reviewer cannot check that a change preserves
`I15` without leaving the repo (F-2). Third, `run.ts` is the one module whose
cohesion rests on a heading rather than a boundary, and it is the one module no
test can reach without booting a world (F-3). The remainder are names and
spellings to tidy (F-4..F-7); none of them will get worse by waiting, and none
of them is worth doing before F-1 and F-2, because a move made before the seam
is named is a guess.

The tradeoffs consciously accepted, and not raised: the 19.1k lines of test
against 10.4k of source is the right ratio for a crash-recovery state machine —
the fixtures are per-layer worlds (`room`, `env`, `harness`, `run`) that compose
rather than one shared mega-fixture, and the live scripts are `justfile`
targets, not accidents. `context.ts` reaching 13 modules is a named global with
a documented reason ("work here is never cancelled from above"), not a leak.
`skills.ts` re-implementing pi 1.3.0's frontmatter and listing rules is a
deliberate port with the upstream file named in the comment — the exposure is
upstream drift, and the comment is the right mitigation.

**What moves where** (the question the review was asked; elaborated in
IMP-002): `src/` should say what it already means — a shared kernel
(`json`, `fields`, `message-of`, `truncate`, `xml`, `ndjson`, `unix-socket`,
`context`, `models`, plus `parseModel` out of `config.ts`), the pi extension
surface both hosts install (`persona`, `skills`, `cwd`, `project-context`,
`grep`, `satan-tools`), the interactive program (`daemon*`, `session`,
`protocol`, `render`, `attach*`, `Config`), and the runner, split by mechanism
rather than by accident: pure rules (`vocab`, `jobs`, `classify`, `ceilings`,
`policy`), ports (`room`, `env`, `git`, `exec`, `store`, `unix-socket`), use
cases (`run`, `rejoin`, `recover`, `collect`, `prepare`, `pause`). Sequence
matters more than the shape: name the seam and its structural test (F-1), record
the runner's mechanism (F-2), and only then re-cut `run.ts` (F-3) — because the
admission/settlement boundary is a design question, and the design is currently
in another repository.

**Haiku.** Boundaries drawn in prose /
the arrow knows the way home /
write the reason down.
