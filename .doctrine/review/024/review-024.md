# Review RV-024 — reconciliation of SL-008

Adversarial-review ledger. Structured findings live in the sister
ledger toml; this prose companion carries the reviewer's framing.

## Brief

Conformance audit of SL-008 (bookmark read tools) on the primary checkout,
`main` at 8ce8fa2. Subject: SL-008's phase commits 8c755fe · c210362 · 6396a65 ·
4d3ddb0 · 0043565 · b88faf8 · 1d24b99 and the docs fix c045e59 (other sessions'
commits interleave; they are not this slice's). Not dispatched: no candidate
branch.

Lines of attack:

1. **Path conformance.** Bootstrap the source-delta registry if empty, then read
   undeclared / undelivered against design sec-6 and the selector registry.
2. **Code vs locked design.** Read `src/bookmarks/*.ts`, `src/untrusted-block.ts`,
   `src/ranges.ts` against sec-2 (file choice, decoder refusals, schema, caps,
   error text free of file content), sec-3 (parameters, ranges, AND matching,
   folder boundary, order, refusals before the source), sec-4 (shared module,
   whole-line fill, fail-closed header, section text), sec-5 (config, wiring,
   catalog position).
3. **Silent choices.** Every Autonomy-log decision that changes observable
   behaviour must end up in the design.
4. **Evidence.** Host gate green; VA-1 and VH-1 recorded; RV-019 F-12 / F-21
   probes held.
5. **Rollout and governance.** Design sec-5 / CHR-006 against what was deployed;
   the sec-8 reconcile obligations.

Invariants held: untrusted framing (nothing from a bookmark reaches the header);
every bound in code and stated when it bites; the bookmark directory is
configured, never discovered, and is the only path the jail binds.

## Synthesis

**Closure story.** The implementation matches the locked design. Reading the
seven bookmark and shared modules against sec-2..sec-5 found no behavioural
divergence: the decoder bounds every read and copy and refuses before
allocation; the source maps every failure to a closed reason with fixed text and
at most the file name's date; the schema is fail-closed with the guid pattern;
caps are applied once in the projection and named in `cut`; the header takes
only counts, code literals and a validated date; filters are refused before the
source is read; `bookmarks` sits immediately before `satan` in
`CATALOG.interactive` on both profiles. Evidence: `just check` green at 8ce8fa2
(104 files, 3542 tests, 98.5 % lines); VA-1 (446 places, 306 tagged, 0 guid
misses) and VH-1 (operator, 2026-10-29) recorded in notes § Review passes;
per-phase host mutants all red.

Every finding is drift between the record and the code, not a code defect —
except F-4, a doc-comment nit fixed in the audit. F-1: the source-delta registry
had not been recorded as phases landed; bootstrapped here, it shows 11 in-scope
paths the selectors miss. F-2: the rollout split changed in execution (satan's
launcher sets the env and binds), and docs caught up but design and CHR-006 did
not. F-3: the Autonomy log made well-reasoned choices the design never named.
F-6: the planned sec-8 governance writes.

**Standing risks.**

- CHR-006 is half done: deployed on Sleipnir via the dev-checkout override, but
  satan 95e40a8 is unpushed and the ~/flakes lock pins cacfd5d, so a
  non-override `home-switch` loses the bookmark bind. Operator acts: push satan,
  `nix flake update satan` in ~/flakes.
- SL-007 (at `plan`) must build on `src/untrusted-block.ts` / `src/ranges.ts`;
  its design already cites them (design.md:472, 532, 791), so the DEC-054
  rebase rule is satisfied on paper.
- Tag counts are case-sensitive while the tag filter is not (F-3). Latent:
  0 case-only collisions in the live backup. Matters first in IDE-008 step 2.
- `doctrine check gate` fails (no `just gate` recipe); `just check` is the gate
  in use. Already owned by CHR-001.

**Tradeoffs accepted.** F-5's out-of-scope `threads` doc rows are kept: correct
and adjacent to the edited row.

**Route for a reader.** Data path: `backupSource` (`src/bookmarks/backup.ts`) →
`decodeMozLz4` (`mozlz4.ts`) → `isBackupTree` → `project` (`project.ts`) →
tools match and order (`tools.ts`) → `renderSearch`/`renderTags`/`renderFolders`
(`render.ts`) → `renderBlock` (`src/untrusted-block.ts`). The load-bearing
behaviour is the trusted header: `headerOf` only ever joins `count`-checked
numbers, code-literal tool and clamp names, and a date checked by
`isCalendarDate`; the forgery and escaping tests in `test/bookmarks/render.test.ts`
pin it. Decisions behind it: `doctrine show DEC-053` (why bookmark metadata may
enter interactive under RSK-002) and `doctrine show DEC-054` (the shared block).

## Reconciliation Brief

Findings are terminal; the writes below are `/reconcile`'s.

### Registry (selector verb, not prose)

- **F-1** — `doctrine slice selector add 8 --intent design-target` for
  `src/ranges.ts`, `src/mail/tools.ts`, `src/mail/project.ts`, `biome.json`,
  `test/structure.test.ts`, `test/ranges.test.ts`,
  `test/untrusted-block.test.ts`, `test/mail/render.test.ts`,
  `test/config.test.ts`, `test/threads-tools.test.ts`. For
  `.doctrine/slice/008/notes.md`, try `--intent scope-relevant`; if conformance
  still lists it, leave it and say so at close (slice bookkeeping committed with
  each phase). Then re-run `doctrine slice conformance 8`; target 0 undeclared /
  0 undelivered.

### Per-slice (direct edit)

- **design.md sec-6** (F-1, mirror): add rows for `src/mail/project.ts`
  (imports `cutRendered` from `src/untrusted-block.ts`), `biome.json` (excludes
  `test/bookmarks/fixtures/**` so fixtures stay byte-exact), and the shared
  modules' tests (`test/untrusted-block.test.ts`, `test/ranges.test.ts`,
  `test/mail/render.test.ts`, `test/config.test.ts`,
  `test/threads-tools.test.ts`).
- **design.md sec-5** (F-2): rewrite "Operator rollout": satan's
  `mkJailedMalebolge` takes an optional `bookmarkBackups` path and both sets
  `MALEBOLGE_BOOKMARK_BACKUPS` inside the jail and binds that directory
  read-only (the jail sets the daemon's env); ~/flakes
  (`features/satan/malebolge.nix`) passes the absolute path. Same correction to
  the sec-8 follow-up bullet.
- **design.md sec-2** (F-3): placesRoot adds no segment and is not a folder; a
  container with no or unknown `root` is named by its title. JSON.parse failure
  and any check/walk throw → `invalid`; `corrupt` is the frame only;
  `no_backup` text does not name the directory. Decoder "~30 lines" → "~40-line
  body plus refusals".
- **design.md sec-3** (F-3): an empty `tag` / `folder` filters nothing, like a
  blank `query`; ties sort by code unit; `bookmarks_tags` counts exact
  (case-sensitive) tags while the `tag` filter is case-insensitive — a known,
  latent inconsistency (0 case-only collisions, live backup 2026-10-29).
- **design.md sec-4** (F-3): header line order for search and listings, with
  `next_offset` on the first line of a listing; `stale` = whole days to `now`'s
  local calendar date, none for a future-dated backup; a non-empty window that
  fits no item is refused (`bookmark page fits no item`).

### Backlog (direct edit)

- **CHR-006** (F-2): body to the as-made split (satan launcher: env + bind;
  ~/flakes: path), record the deployment on Sleipnir, and name the remaining
  operator acts: push satan 95e40a8, `nix flake update satan` in ~/flakes. Keep
  it open until they land; retitle if the title's "in ~/flakes" misleads.

### Governance/spec (REV)

- **DEC-029** (F-6): REV modify choice (2): interactive gains `bookmarks`
  immediately before `satan` on room and host; "prompt and tool order are
  unchanged" is historical (true at DEC-029's adoption). Leave `threads` to
  SL-006's reconcile, or note the omission if it is still open.
- **RSK-002** (F-6): REV modify controls: add DEC-053 (bookmark metadata in
  interactive, framed untrusted, with per-field caps).
- **IMP-023** (F-6): note that bookmark metadata is outside its scope; a digest
  tool never joins `interactive` via the bookmark tools.
- **SL-005** (F-6): context note — "not in the interactive tool set" concerns
  mail bodies; DEC-053 covers bookmark metadata. Write through whatever surface
  a closed slice allows (direct note edit if permitted).
- **ASM (new)** (F-6): the daemon reads the bookmark backups directory from a
  configured absolute path (`MALEBOLGE_BOOKMARK_BACKUPS`) that the jail binds
  read-only; never discovered, never the profile directory. Capture with
  `/knowledge`, linked to SL-008 and DEC-055.

## Reconciliation Outcome

Operator assent: "done" (2026-10-29), in reply to the proposal listing every
edit below.

### Direct edits applied

- **design.md sec-2** (F-3): placesRoot adds no segment and is not a folder;
  unknown/no `root` → named by title; `no_backup` names no directory; `corrupt`
  is the frame only, JSON/check/walk throws → `invalid`; decoder size "a ~40-line
  body plus its refusals".
- **design.md sec-3** (F-3): empty `tag`/`folder` filters nothing; code-unit
  ordering; tag counts case-sensitive vs case-insensitive filter, recorded as a
  latent inconsistency (0 pairs live) for IDE-008 step 2.
- **design.md sec-4** (F-3): search header lines in the shown order; listing
  header order with `next_offset` on the first line; `stale` by local calendar
  date, none for a future-dated backup; a non-empty window that fits no item is
  refused.
- **design.md sec-5, sec-8** (F-2): rollout as made — satan's launcher sets the
  env var and binds; `~/flakes` passes the path.
- **design.md sec-6** (F-1, mirror): rows for `src/mail/project.ts`, `biome.json`
  and the shared-module, config and threads-harness tests.
- **SL-005 `slice-005.md` Context** (F-6): the "not in the interactive tool set"
  bullet now notes it concerns mail bodies; bookmark metadata is DEC-053's.
- **CHR-006 body** (F-2): "As made" section; satan 95e40a8 is pushed; the one
  remaining operator act is `nix flake update satan` in ~/flakes (lock pins
  cacfd5d). Title unchanged (no backlog retitle verb). Stays open.
- **IMP-023 body** (F-6): scope note — bookmark metadata is outside it.

### Selector registry (F-1)

- `doctrine slice selector add 8 --intent design-target` for the ten paths in
  the brief. `slice conformance 8` now reads **1 undeclared / 0 undelivered /
  37 conformant**. The one undeclared path is `.doctrine/slice/008/notes.md`: a
  `scope-relevant` selector does not clear it (tried, then removed), and it is
  slice bookkeeping, not a design target. Left as is, by intent.

### Knowledge and backlog records (not REV surfaces)

No brief item targets a SPEC/PRD/REQ/ADR/POL/STD, so no REV was opened
(precedent: RV-007 outcome — decisions and assumptions are amended through
their own verbs).

- **DEC-029** (F-6): body appended via `knowledge edit --body-mode append`:
  `bookmarks` before `satan` on both profiles under DEC-053; the "order
  unchanged" sentence is historical; `threads` left to SL-006.
- **RSK-002** (F-6): `risk set --controls` adds the seventh control (bookmark
  metadata framed untrusted with per-field caps, DEC-053); likelihood/impact
  unchanged.
- **ASM-010** (F-6, new): the daemon reads the bookmark backups directory only
  from a configured absolute path the jail binds read-only; confidence high,
  validated by VH-1. Linked `references (concerns) SL-008`; DEC-055/DEC-052
  cited in its body (`governed_by` admits only ADR/POL/STD).

### Not reconciled on purpose

- F-4 was fixed in the audit; F-5 is aligned.
- `plan.toml` criteria untouched (immutable-append).

Reconcile pass complete — handoff to /close.
