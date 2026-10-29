# Review RV-025 — reconciliation of SL-010

Adversarial-review ledger. Structured findings live in the sister
ledger toml; this prose companion carries the reviewer's framing.

## Brief

**Mode:** conformance (self-audit; raiser and responder driven with `--as`).
**Surface reviewed:** main worktree, phase commits 8aa02d9 c4542f8 866a88c 78856d0 77ac080 a873454 2538398 (PHASE-01..07, one commit each; parents recorded via `slice record-delta --start/--end`). Not a dispatched slice.

Lines of attack:
1. Path conformance — `doctrine slice conformance 10` after bootstrapping the empty registry (sub-orchestrators skipped `record-delta`).
2. Design conformance — each design.md sec-2..sec-6 statement against the diff (pi `review` first pass, adjudicated here), and every "flag for audit" line in notes.md § Autonomy log.
3. Behaviour change against design text — Emacs `new` against a daemon predating `--topics`; EX-8's UnknownModel→refusal on `thread_start`.
4. Verification evidence — VT criteria green on the host gate (`just check`, `just ert`, `doctrine check gate`); PHASE-07 VH-1 run against a substituted model ref.
5. Governance surface — DECs amended by DEC-082..091 (DEC-034, DEC-039, DEC-016, DEC-017), IMP-018 absorbed, research drift.
6. Hand-run rough edges (IMP-026) — which, if any, are SL-010 conformance gaps.

Invariants held: one checker (`catalog.require`); a refusal writes nothing; unknown topic model refuses creation with no fallback (DEC-083) except the heartbeat, which logs and continues; old clients/daemons degrade per DEC-007 (additive) and the skew hint.

## Synthesis

**Verdict.** SL-010 conforms to its locked design in behaviour. Every divergence is notation, documentation, or a design statement the implementation had to sharpen; none changes a contract, and no blocker or major was found. 19 findings: 7 design-wrong (reconcile writes), 2 fix-now (done at audit), 2 follow-up (IMP-026, CHR-001), 4 tolerated, 4 aligned.

**Evidence.**
- Path conformance (`doctrine slice conformance 10`, registry bootstrapped at audit, F-1): 35 conformant, 0 undelivered, 3 undeclared — README.md and docs/internals.md (F-2, a selector omission) and the slice's notes.md (F-3, tolerated).
- Gate, host, 2026-10-29: `just check` green (107 files / 3800 tests; fmt, lint, typecheck); `just ert` 48/48, byte-compile clean. `doctrine check gate` unavailable: no `just gate` recipe (F-17, CHR-001). After the F-16 comment edits: `just fmt-check`, `just lint` clean.
- Design sweep: a Sonnet subagent compared design sec-2..sec-6 with the seven-commit diff (the pi worker ran out of API balance mid-run). Its five leads were adjudicated here: one doc and three comments confirmed stale (F-16), one judged not a finding (`summariesOf` skips an id with no index entry; every listed id has one by construction), one judged not a finding (the client-error label names the program, not the configured command).
- Verification: VT criteria pinned per phase with negative controls (notes.md run logs); VH-1 passed by the operator against a substituted ref (F-10).

**Route through the system.** `startDaemon` builds one `ModelCatalog` (`src/models.ts`) → `conversations(..., catalog)` judges a topic write (`modelChange`) and every creation (`topicInit` → `creationModel`) in the creating commit → `serve` answers `list {models:true}` from `catalog.refs`. Important behaviour: an unknown stored topic model refuses creation with no fallback (DEC-083) — on attach paths as an error, on `thread_start` as a tool refusal (F-7), and on the wake heartbeat as a log line while the daemon still starts. Tests bearing on it: `test/conversations.test.ts` (creation VTs), `test/threads-tools.test.ts` (EX-8 refusal), `test/daemon-start.test.ts` (heartbeat catch; VT-3 f unchanged).

**Standing risks.**
- `Topic:` RET defaults to `default` (F-11) and the connect status names only the id (IMP-026 item 2): together they let a conversation land in the wrong topic unnoticed. Design-conformant; IMP-026 owns the UX change, which would amend DEC-089.
- A failing model turn is silent (IMP-026 item 1); it predates SL-010 but is more likely now that topics select arbitrary gateway refs.
- The catalog is read at daemon start; a gateway catalog change needs a restart (and, on this host, a home-manager switch).

**Tradeoffs accepted.** Emacs `new` errors against a daemon without the topics query rather than silently falling back (F-9, the design's "callers check nothing"). VH-1's ref substitution (F-10). Notes.md as a standing undeclared cell (F-3).

Sources worth reading: `doctrine show DEC-083` (refusal rule the creation paths and F-7 rest on), `doctrine show DEC-089` (the Emacs `new` topic prompt and its default, F-11), `doctrine show IMP-026` (the hand-run rough edges, F-12).

## Reconciliation Brief

### Per-slice (direct edit)
- **slice selectors (F-2, load-bearing):** `doctrine slice selector add 10 README.md docs/internals.md` with intent `design-target`. Mirror: design sec-7 code-impact table gains a row `README.md`, `docs/internals.md` — the new flags, the models list query, the --topics/--list line shapes.
- **design.md sec-2 (F-4):** the `ModelCatalog` code block declares function-typed properties (`require: (ref: string) => ModelRef; refs: () => string[]`), with one line: callers pass `catalog.require` unbound (lint `unbound-method`).
- **design.md sec-2 (F-14):** replace "`require` is today's `requireKnownModel` (`src/daemon-start.ts:55`), moved" with "`require` replaced `requireKnownModel` (deleted from `src/daemon-start.ts`)".
- **design.md sec-4 (F-5):** `ModelSources.topic?: string | undefined` in the code block.
- **design.md sec-4 (F-7):** the `thread_start` row / refusal paragraph: an unknown topic model surfaces as `thread_start`'s refusal result (isError, naming the model) through the thread tools' `attempted` mapping, as a `Refusal` does; nothing is created (DEC-083).

### Governance/spec (REV)
- **DEC-016, DEC-017 (F-15):** record "amended by DEC-086 (topic `model` key, --set-topic --model/--no-model, fourth --topics field)".
- **DEC-034 (F-15):** record "amended by DEC-084 (a started thread takes its topic's model)".
- **DEC-039 (F-15):** record "amended by DEC-087 (--list lines: id, topic, model, then the mark)".
- **DEC-082 (F-15, F-4):** refinement note — drop "Pending the user's section review of sec-2"; write the port with function-typed properties.

### Close-time (for /close, not a reconcile write)
- **IMP-018 (F-19):** resolve, delivered by SL-010 PHASE-07.
- Off-surface, recorded only: plan PHASE-07 VH-1 passed against `gateway/chatgpt/gpt-6.1-terra` (F-10) — plan criteria are immutable; no edit.
