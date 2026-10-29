# Notes SL-008: Bookmark read tools: SATAN finds and relates Firefox bookmarks

Durable per-slice scratchpad — tracked in git. The place to lift anything from a
disposable phase sheet (`.doctrine/state/.../phase-NN.md`) that must survive
`rm -rf` before the slice close-out audit harvests it.

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-29 · close · 40a06f6

### Produced
- Design locked (RV-019); plan approved; minted DEC-052..055, CHR-006.
- Implementation run (/super-orchestrator, pi workers, ≈$0.70): PHASE-01 8c755fe ·
  02 c210362 · 03 6396a65 · 04 4d3ddb0 · 05 0043565 · 06 b88faf8 · 07 1d24b99;
  docs fix c045e59. Evidence: § Review passes; envelope decisions: § Autonomy log.
- Operator rollout out of repo: satan 95e40a8, ~/flakes 08c0f37d (CHR-006).
- Audit RV-024: 6 findings terminal, brief in review-024.md; source-delta registry
  bootstrapped (seven `record-delta --commit` rows); F-4 fixed in the audit.

### Learned
- mem.fact.malebolge.firefox-bookmark-data — where tags live, locked DB, backup format.
- mem.fact.malebolge.room-daemon-env-via-jail — daemon env/binds come from the jail launcher.
- mem.pattern.malebolge.negative-controls-that-bite — parse-error quoting, overcommit, deep nesting.
- mem.fact.malebolge.orchestrated-phases-skip-delta-registry — orchestrated phases leave conformance empty.

### Open
- Reconciled (RV-024 § Reconciliation Outcome, 40a06f6); slice closed `done`.
- CHR-006 — operator act: `nix flake update satan` in ~/flakes.
- IDE-008 — steps 2–3 (reorganisation plans, capture-on-demand) for later slices.
- RV-019 — design ledger concluded but 21 findings sit `answered`, unverified by
  the raiser; did not block close.
- CHR-001 — `doctrine check gate` has no `just gate` recipe; `just check` is the gate.

## Implementation run
<!-- written by the /super-orchestrator seat, 2026-10-29; charters point here -->

- **Driver**: /super-orchestrator seat → `sub-orchestrator` charters (1–3 phases) → quotient pi workers. Main worktree. Halts before audit.
- **Host gate**: `just check` from the session shell (just, biome, node on PATH; eslint/tsc/vitest via npx). Baseline 2026-10-29: 96 files / 3351 tests green.
- **quotient forms**: `read` (repo read-only, network on) and `write` both run every gate recipe (`fmt-check`, `lint`, `typecheck`, full `vitest run`) green, failures identical to host (none). No form change needed. Absent in the sandbox: `nix`, `lz4`, `python3` — any step needing them runs on the host (sub-orchestrator), not in pi. `fmt-check` prints 4 benign biome warnings for broken `.quotient/` symlinks (exit 0).
- **Known sandbox-only failures**: none in the suite. `npx biome` fails in pi (missing `@biomejs/cli-linux-x64` native binary); use the PATH `biome`, which `just fmt-check` / `just format` call.
- **Operator ruling — PHASE-02 fixture** (2026-10-29, reply "Commit as is"): the 857-byte backup from the scratchpad profile (Mozilla defaults only: 4 default places under "Mozilla Firefox", empty roots; per-profile values are 5 random guids and the profile creation time) is committed unchanged. Seat-staged copies, outside the repo:
  - raw: `/tmp/claude-1000/-home-david-dev-malebolge/a8892a87-af84-4b6b-b861-883e908db592/scratchpad/fixture/scratchpad.jsonlz4` (source: `~/.config/mozilla/firefox/<scratchpad profile>/bookmarkbackups/bookmarks-2026-03-25_10_….jsonlz4`)
  - independent decode (2518 bytes): `…/scratchpad/fixture/scratchpad.json`, produced once by
    `nix shell --impure --expr '(import (builtins.getFlake "nixpkgs") {}).python3.withPackages (p: [p.lz4])' -c python3 -I -c 'import lz4.block; b=open("scratchpad.jsonlz4","rb").read(); assert b[:8]==b"mozLz40\0"; open("scratchpad.json","wb").write(lz4.block.decompress(b[8:]))'`
  - The sub-orchestrator copies both into `test/bookmarks/fixtures/` (pi cannot see the scratchpad). SOURCE.md names the profile as "scratchpad", not its directory id.
- **PHASE-04 VA** (live backup `~/.config/mozilla/firefox/ez06zp0k.default/bookmarkbackups/`): private data. Run on the host by a Claude agent, never pi (pi sends what it reads to an external model). Report counts only, never titles/URLs; confirm every guid matches `^[A-Za-z0-9_-]{12}$`.
- **Other writers**: a concurrent session works SL-006/007/009 (`src/threads/`, `.doctrine/slice/006|007|009`, `.doctrine/knowledge/**`, `.doctrine/backlog/**`). Commit only SL-008 paths and the phase's source files, by path. SL-007 may touch `src/mail/render.ts` / `src/mail/tools.ts`: if its changes appear there mid-PHASE-01, halt and escalate (DEC-054: second to land rebases).
- **PHASE-07 VH**: needs the operator's rollout (CHR-006, out of repo) — leave it open, don't attempt.
- **Background tasks** are enabled (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` unset): spawns run in the background and wake the parent by notification.

## Autonomy log
<!-- one line per envelope decision: phase · what · why · tier (decided / deferred / escalated) -->
- PHASE-01 · `src/mail/project.ts` import of `cutRendered` repointed to `../untrusted-block.ts` (file not named in the plan) · no re-exports from mail, one home per symbol · decided
- PHASE-01 · `Clamp<N extends string = string>`; mail's `HeaderFacts.clamps` takes the default, tools use `Clamp<MailBound>` · keeps mail tests' `Clamp[]` compiling unchanged (EX-5) · decided
- PHASE-01 · `renderResult` kept as mail's one-line use of `renderBlock("mail-data", …)`; failure text now `mail-data result is over N bytes` · EX-3; no test pins the old text · decided
- PHASE-01 · `src/mail/extension.ts` MAIL_SECTION prose still names `<mail-data untrusted="true">` · it is the prompt rule describing the block, not a copy of the wrapper (EX-3 read as wrapper text); design keeps MAIL_SECTION in mail · decided
- PHASE-01 · `MAIL_MAX_BYTES` renamed inside three `it(...)` titles in test/mail/render.test.ts · titles are not assertions; the rename is EX-5's · decided
- PHASE-02 · `biome.json` excludes `test/bookmarks/fixtures/**` (file not named in the plan) · `biome format --write` reformatted the committed decoder output; fixtures must stay byte-exact (EX-2) · decided
- PHASE-02 · added a spy test: `Buffer.alloc`/`allocUnsafe` not called on too_large · the 0xFFFFFFFF header test passes even alloc-first (Linux overcommit), so it did not guard "before any allocation" (EX-1); negative control run red · decided
- PHASE-02 · decoder file 80 lines, not ~30 · ~40-line decode body; the rest is header comment, error class, fixed messages and 12 refusal sites (EX-4 "plus its refusals") · decided
- PHASE-03 · the tree's top container (`placesRoot`) adds no path segment and is not listed in `folders`; a container with no or an unknown `root` key is named by its title · design sec-2 names only the four roots; listing "" as a folder would be noise · decided
- PHASE-03 · `project()` returns `Projection` {bookmarks, folders}; `Snapshot` (= Projection + date) is PHASE-04's, in backup.ts · keeps project.ts free of the port; backup.ts → project.ts value import, project.ts → backup.ts type-only · decided
- PHASE-03 · `isBackupTree` also requires the top node to be a container · fail-closed; projection needs a container · decided
- PHASE-03 · Backup* types hand-written, not `Static` · `Static` of the Cyclic Ref yields `unknown[]`/`any[]` children; the `value is BackupContainer` guard is the tie · decided
- PHASE-03 · for PHASE-04: `Value.Check` and `walk` recurse, and `JSON.parse` of a deeply nested body may throw RangeError (stack); the source must map any throw from parse/check to `invalid`/`corrupt`, never let it escape · deferred to PHASE-04 brief
- PHASE-04 · caps tested at full size with sparse files and a FileHandle-prototype `stat` spy; `backupSource(dir)` keeps the design signature (no injectable caps) · no test seam in the port · decided
- PHASE-04 · JSON parse failure → `invalid` (not `corrupt`); `corrupt` is the mozlz4 frame only; any non-MozLz4Error decode throw → `corrupt`; any check/project throw (deep-nesting RangeError from `Value.Check`) → `invalid` · design sec-2 puts JSON.parse under "Validation"; carry-over from PHASE-03 · decided
- PHASE-04 · `no_backup` text is fixed and does not name the directory; only the readdir failure (`unreadable`) names it · EX-3 names the dir for unreadable only · decided
- PHASE-04 · a matching name that is a directory, or any open/stat/read/close failure on the chosen file → `unreadable` naming its date · fail-closed, fixed text · decided
- PHASE-04 · VT-3 marker shortened to 6 chars and the invalid-JSON case puts it at the bad token · V8's SyntaxError quotes only ~10 chars near the error, so the 11-char marker let a leaking mutant pass; mutant now red · decided
- PHASE-05 · render API takes the Snapshot: `renderSearch(snapshot, matches, limit, request)`, `renderTags(snapshot, tags, request)`, `renderFolders(snapshot, request)` with `PageRequest` {offset, clamps, now}; `BookmarkBound` and `TagCount` live in render.ts · date and cutCount come from one snapshot, never a second argument; matching/sorting/tag counts stay PHASE-06's · decided
- PHASE-05 · tags/folders first line `bookmarks_<tool>: shown N of M[, next_offset: X]`, mirroring search's `matched: M, next_offset: X`; search line order items, matched, source, stale, clamps; listings shown, source, stale, cut by caps, clamps · design sec-4 names the lines, not their order or where next_offset sits · decided
- PHASE-05 · stale days = whole days from the backup date to `now`'s LOCAL calendar date; a backup dated after now prints no line · Firefox names backups by local date · decided
- PHASE-05 · header fails closed with fixed text: `header: source is not a backup date` (reuses backup.ts `isCalendarDate`, now exported), `header: now is not a time`, shared `count` for every number incl. limit · one date check, not two · decided
- PHASE-05 · a non-empty window that fits no item throws `bookmark page fits no item` rather than sending next_offset = offset · EX-3's ≥1-item rule made fail-closed; unreachable with projected bookmarks (VT-4: worst item 2279 B) · decided
- PHASE-06 · `BookmarkDeps.now` is `() => number` (converted to a Date for `PageRequest`) · the clock shape MailDeps and daemon-start already pass; PHASE-07 wires one `now` · decided
- PHASE-06 · `tag` / `folder` filter caps are the projection's `TAG_MAX_BYTES` / `FOLDER_MAX_BYTES` (64 / 256) by reference · a filter longer than the field cap could never match; one number, one home · decided
- PHASE-06 · a whitespace-only query, an empty tag or an empty folder filters nothing (as an absent one) · design names "absent or blank" for query only; empty tag/folder would otherwise match nothing or everything by accident · decided
- PHASE-06 · tag counts are exact (case-sensitive) distinct tags, a bookmark counted once per tag; folder and tag ties sort by code unit, not localeCompare · deterministic across locales; design says "then tag" / "path asc" without a collation · decided
- PHASE-06 · `bookmark()` / `snapshot()` test builders moved from render.test.ts to bookmark-fixtures.ts · shared by tools.test.ts; no parallel builders · decided
- PHASE-06 · extension test pins BOOKMARKS_SECTION and the section key/tag, not the rendered section (mail precedent; rendering needs a full PromptInput) · PHASE-07 VT-3 pins it in the rendered system prompt · decided
- PHASE-07 · VT-4 drives a resumed turn through `startDaemon` on a host world (VT-3 c pattern) and asserts the fixture's date in the header · proves the daemon read config.bookmarkBackups, not a test-side fake · decided
- PHASE-07 · no `DaemonHandle.bookmarkTools` and no daemon-main log line · always 3, uninformative; the tool's own refusal tells the operator · decided
- PHASE-07 · docs toolset tables also gain the missing `threads` (README, internals) and the internals note says tasks+threads are room-only, bookmarks on both · pre-existing gap beside the edited row (SL-006) · decided
- PHASE-07 · VH-1 left open: operator rollout CHR-006 is out of repo; steps written in docs/internals.md § Bookmarks · charter · deferred

## Review passes
- PHASE-01 · pi `implement` (deepseek-flash), 2 runs in one session: T1 red ($0.020), T2+T3 green/refactor ($0.044). Clean: followed spec, flagged the extra project.ts edit itself. Miss: none; noted `npx biome` broken in sandbox, used PATH biome. Gateway restart window: probe answered, no runs lost.
- PHASE-02 · pi `implement` (deepseek-flash), 3 runs: T1 red tests + helpers ($0.047; checked its vectors with a throwaway reference decoder; flagged biome reformatting the fixture and restored it byte-exact), T2 green ($0.018; correct, 156 lines, over-factored), T3 refactor to 80 lines + alloc-spy negative control ($0.025; ran the control red). Misses: none functional.
- PHASE-03 · pi `implement` (deepseek-flash), 2 runs: T1 red stubs + builders + 31 tests ($0.101; ran its own mutants: quote-blind cut, title-for-root), T2 green+refactor ($0.054). Miss (fixed on host): a place directly under the tree argument created a `""` entry in `folders`; test tightened red first, `walk` now caps each path once. Host mutant on tag caps: 3 red.
- PHASE-04 · pi `implement` (deepseek-flash), 2 runs in one session: T1 red stubs + fixtures + 24 tests ($0.053; ran a stat-trusting negative control red; probed deep nesting: `Value.Check` throws RangeError, JSON.parse does not), T2 green+refactor + a dir-as-backup test ($0.027). Miss (fixed on host): VT-3's invalid-JSON leak case could not catch a leak (V8 quotes ~10 chars; marker 11 chars, placed at end) — host mutant `String(e)` survived; fixed, mutant red. Host mutant removing the check/project catch: deep-nesting test red. Comment cited DEC-026 (mail) for the port; corrected.
- PHASE-04 VA-1 (host only, counts only; script in session scratchpad, not committed): newest live backup dated 2026-10-29 read through `backupSource` → success; 446 places, 306 tagged (research F5: ≈446 / ≈306), 65 folders, 3 bookmarks with a cut field; 0 guid misses against `^[A-Za-z0-9_-]{12}$` (RV-019 F-21 assumption holds).
- PHASE-05 · pi `implement` (deepseek-flash), 1 run: stubs + 26 tests red, green, refactor, negative controls 1/2/4 red ($0.073). Clean; followed the byte-exact header spec. Host refactor: listing tool name typed as a literal union, duplicate offset parameter dropped. Host mutants, all red: no `<` escaping in shared `dataLine` (VT-3), a newline title appended to the header (forgery test), stale `>=`, cut-by-caps always, next_offset `<=`.
- PHASE-05 · RV-019 F-12 probe (VT-4, EX-4): every field at cap with worst-case escapes plus a 100 KB unschema'd field, read through the real backupSource → 1 item, data line 2279 B (design estimate ~2.3 KiB; ITEMS_MAX_BYTES 49152), cut = title,url,tags,folder; guids of 13 and 100000 chars → invalid. Bound holds.
- PHASE-06 · pi `implement` (deepseek-flash), 2 runs in one session: T1 stubs + 38 red tests + builder move ($0.068), T2 green + refactor + negative controls a/b/c red (4/3/6 tests) ($0.055). Clean. Host: filter caps aliased to the projection caps, "urls" → "URLs"; host mutants all red (segment boundary dropped, added order reversed, `every` → `some`). `just check` 104 files / 3531 tests green.
- PHASE-07 · pi `implement` (deepseek-flash), 3 runs: docs (README, internals) concurrent with T1 red tests (13 red for the right reasons, $0.074 + $0.022), T2 green + refactor + negative controls a-d red ($0.034). Miss: T1 left one existing section-order test (`renders directly after cwd`) unupdated; T2 fixed it. Host mutants red: bookmarks after SATAN (VT-2 order), always `unconfiguredSource()` (VT-4 configured). Host: docs tables gained the missing `threads`. `just check` 104 files / 3542 tests green.
- PHASE-07 · operator rollout (CHR-006), 2026-10-29, seat-made at the operator's request, uncommitted in both repos at time of writing: `~/dev/satan/flake.nix` — `bookmarkJailOptions` (set-env `MALEBOLGE_BOOKMARK_BACKUPS` + `readonly` of that dir only) and an optional `bookmarkBackups ? null` argument to `mkJailedMalebolge` (probe unchanged); `~/flakes/features/satan/malebolge.nix` — passes the default profile's bookmarkbackups path. Deployed via `just home-switch` (dev-checkout override picks up local satan) + room restart 18:06; launcher carries env + bind, startup logged the toolset change per conversation. Drift for audit: README/docs/internals.md rollout steps say "env in ~/flakes, bind in satan"; now satan's launcher does both and ~/flakes supplies only the path.
- PHASE-07 · **VH-1 passed** — operator, 2026-10-29: "yeah they're working pretty good VH-1 pass".
