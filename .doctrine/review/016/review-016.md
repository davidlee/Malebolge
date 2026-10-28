# Review RV-016 — reconciliation of SL-005

Adversarial-review ledger. Structured findings live in the sister
ledger toml; this prose companion carries the reviewer's framing.

## Brief

<!-- Pre-reading + lines of attack: what this review is probing, the invariants
     it must hold the subject to, and where the bodies are likely buried. Seeded
     at `review new`; the reviewer fills it before raising findings. -->

Mode: **conformance** (self-audit). Surface: the primary tree on `main`
at `a6a5a03` (not dispatched; phases landed by `/super-orchestrator`).

Lines of attack:

1. **Path conformance.** `doctrine slice conformance SL-005`: 22 undeclared,
   1 undelivered (`src/wake/heartbeat.ts`), 73 conformant.
2. **Gate.** `nix develop -c just check`: fmt, lint, typecheck, 87 files /
   3234 tests green, coverage 98.58% lines. `doctrine slice verify-vt 005`.
3. **Design drift flagged during execution.** The notes' autonomy log flags
   four items "for audit": the exit-2 diagnostic field (sec-5), the leading
   `-` in JMAP ids (sec-4), the env close (sec-5), and VH-1's `since` defect.
4. **VH-1 adjudication** (notes § VH-1): what was fixed before audit, what is
   by design, what remains untested live.
5. **Invariants held:** mail never in `interactive` (DEC-029, satan:RFC-020
   D5); every conversation carries an explicit toolset; every mail result
   within `MAIL_MAX_BYTES`; raw stderr never reaches the model; argv only,
   `--config` first, `inheritEnv: false`.

## Synthesis

**Closure story.** SL-005 delivered both tracks as designed: a closed
toolset catalog (`interactive`, `mail`, `job`) with the name fixed per
conversation and its list re-derived at startup, and five `mail_*` read
tools over screwtape's v1 CLI contract behind a `MailSource` port. The gate
is green (3234 tests, 98.58% lines, zero lint warnings); every plan VT
passes `verify-vt` after F-8's one-line fix; the opt-in smoke ran against
the real binary; VH-1 ran in the live room. Path conformance shows no scope
creep: every undeclared touch is in scope or infrastructure (F-6).

No blocker or major finding. The ten findings are:

- four design-text corrections where the code is right and the design is
  wrong or incomplete (F-1 exit-2 field and missing outcomes, F-2 the
  leading `-` argument, F-3 the env close, F-7 the jail deployment);
- one selector-registry correction (F-6);
- two VH-1 defects already fixed before audit, so aligned (F-4 `since`,
  F-5 mirror window);
- one verification-attribution fix applied here (F-8);
- two tolerated gaps (F-9 VH-1 client, F-10 runner refusal tested at the
  unit).

**Standing risks.**

- `held_back` is untested live (no future-dated message in the store); the
  unit tests and mutants cover it.
- An envelope over 4 MiB stalls `mail_new` at limit 1 (accepted in design;
  screwtape IMP-002 is the fix).
- `~/satan-corpus/prompts/mail.txt` is installed but uncommitted in the
  operator's repo; a room start refuses without it.
- A real JMAP id starting with `-` would be refused (F-2); none seen.

**Tradeoffs consciously accepted.** Forks and task-owned conversations
refuse startup rather than inherit (IMP-017); no per-conversation byte
budget (IMP-015); no startRunner seam (F-10).

**Route for a reader.** Selection: `src/toolsets.ts` (catalog) →
`src/conversations.ts` `toolsetInit` (inside the creating commit) →
`src/session.ts` reconcile (backfill, refusals, re-derivation); tests
`test/toolsets.test.ts`, `test/conversations.test.ts`,
`test/session.test.ts`. Mail: `src/mail/tools.ts` → `source.ts` port →
`screwtape.ts` adapter over `src/bounded-exec.ts`; bounds in `project.ts`
and `render.ts`, pinned by `test/mail/render.test.ts`'s property loop.

## Reconciliation Brief

### Per-slice (direct edit)

- **F-6 (load-bearing: selector registry).**
  `doctrine slice selector add SL-005` design-target: `src/render.ts`,
  `src/daemon-main.ts`, `test/**`; scope-relevant: `package.json`,
  `package-lock.json`, `flake.nix`, `biome.json`, `vitest.config.ts`,
  `.doctrine/slice/005/**`. `doctrine slice selector rm SL-005
  src/wake/heartbeat.ts` (re-add scope-relevant if wanted). Mirror in
  design.md sec-6: rows for `src/render.ts` (listing field) and
  `src/daemon-main.ts` (startup log), an infrastructure row (typebox
  declared, biome in the flake, smoke excluded in vitest config, fixtures
  excluded in biome), and `src/wake/*` as verified no-change.
- **F-1** design.md sec-5 outcome mapping: `<code>` is the `reason` field of
  the first stderr line whose `level` is `"error"`; add rows `spawn_error` →
  `screwtape could not run` and unterminated last stdout line → `screwtape
  contract violation: unterminated line`. Port bullet: failures surface as
  `MailSourceError { failure }`.
- **F-2** design.md sec-4 Inputs: ids match the JMAP Id form and do not start
  with `-`; drop "so no value can start with `-`" as a consequence of the
  regex.
- **F-3** design.md sec-5 Spawn: replace "The env is closed with the daemon"
  with the env holding no resources and an in-flight child ending via its
  call's abort signal when the harness closes.
- **F-7** design.md sec-5 Location: the room runs jailed; satan's
  `mkJailedMalebolge` must carry the screwtape binary and config and bind the
  store directory read-write; `MALEBOLGE_SCREWTAPE` is the unwrapped binary.
  Cite docs/internals.md for the detail.

### Governance/spec (REV)

None. No ADR, policy, standard or spec in this repo governs the slice;
satan:RFC-020 D5 holds as implemented.

## Reconciliation Outcome

### Direct edits applied (operator: "agreed")
- design.md sec-4 Inputs: ids match the JMAP Id form and must not start with `-`; the form admits one (F-2).
- design.md sec-5 Location: the jail (`mkJailedMalebolge` binds) and the unwrapped binary, pointing at docs/internals.md (F-7).
- design.md sec-5 Spawn: the env holds no resources and has no close; abort ends an in-flight child (F-3).
- design.md sec-5 Outcome mapping: exit 2's code is the `reason` of the first error-level stderr line; rows for `spawn_error` and an unterminated stdout line; Port names `MailSourceError { failure }` (F-1).
- Selector registry (F-6, load-bearing): design-target added for `src/render.ts`, `src/daemon-main.ts`, the nine undeclared test paths, `package.json`, `package-lock.json`, `flake.nix`, `biome.json`, `vitest.config.ts`, `.doctrine/slice/005/**`; `src/wake/heartbeat.ts` moved to scope-relevant. A blanket `test/**` design-target was tried and reverted: it took the matches from the specific test selectors, so they read as undelivered. `doctrine slice conformance SL-005`: 0 undeclared, 0 undelivered, 95 conformant.
- design.md sec-6 mirror: `src/wake/*` verified no-change; rows for `src/render.ts`/`src/daemon-main.ts`, the infrastructure files, and the extra test files (F-6).

### REVs completed
- None: the brief named no governance or spec item.

### Withdrawn / tolerated
- F-9 (VH-1 in the line client; IMP-018) and F-10 (runner refusal tested at `requireInstalled`): tolerated, rationale in the dispositions.
- F-4, F-5: aligned, fixed before audit (a6a5a03). F-8: fixed in the audit.

Reconcile pass complete — handoff to /close.
