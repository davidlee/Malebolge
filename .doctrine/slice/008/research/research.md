# SL-008 research — bookmark read tools

## Header

- Round 1, 2026-10-29. Baseline: `baseline.toml` (stamped by
  `doctrine slice research 8`).
- Producers:
  - **Firefox thread** — orchestrator (Opus), run directly against copies of
    the operator's profile files in the session scratchpad. Only schema and
    bookmark tables read; history rows never queried; nothing sent to a model.
  - **Thread 1 governance** — quotient pi `research` profile (deepseek-flash),
    over staged `doctrine show` output (`.doctrine/state/slice/8/governance.md`).
    Raw: `raw/governance.md`.
  - **Thread 2 code map** — quotient pi `research` profile. Raw: `raw/code-map.md`.
- Operator decisions in session (2026-10-29): tools join the **interactive**
  toolset (OQ-2); new tools live outside elisp; "add sqlite to the flake if
  needed"; WebExtension API lacks tags (operator recollection, concurs).

## Verification legend

✓ = verified by the orchestrator (read or grep of the cited site, or a run).
Unmarked = researcher claim, cited, not checked. Design load-bears ✓ rows only.

## Thread 0 — Firefox data (orchestrator, all ✓ by run)

| # | Finding |
|---|---|
| F1 ✓ | `places.sqlite` `user_version` 87. Roots by GUID: `root________`, `menu________`, `toolbar_____`, `tags________` (id 4), `unfiled_____`, `mobile______`. |
| F2 ✓ | **Tags are folders under `tags________`**; each tag entry is a type-1 row whose `fk` → `moz_places`. Live: 386 tags, 721 tag entries, 447 bookmarks, 67 folders, 305 bookmarked URLs tagged (~68%). Tags are load-bearing for the use cases. |
| F3 ✓ | Live `places.sqlite` opened read-only while Firefox runs: **`database is locked`** (Firefox holds an exclusive lock). `?immutable=1` opens but ignores the WAL (stale, and may read a torn page if Firefox writes mid-read). Copying `places.sqlite` + `places.sqlite-wal` and opening the copy works. |
| F4 ✓ | `bookmarkbackups/*.jsonlz4`: `mozLz40\0` magic, u32 LE decompressed size, one raw LZ4 block. A ~20-line pure-JS decoder decoded the latest file. Written daily (filenames `bookmarks-<date>_<count>_<hash>`; 2026-10-28 and -29 present). |
| F5 ✓ | Backup JSON is a tree: containers carry `guid,title,index,dateAdded,lastModified,id,typeCode,type,root,children`; places carry `guid,title,index,dateAdded,lastModified,id,typeCode,iconUri,type,uri,tags,charset`. **`tags` is a comma-joined string.** Roots: `bookmarksMenuFolder, toolbarFolder, unfiledBookmarksFolder, mobileFolder` (the tags root is folded into per-bookmark `tags`). Latest: 446 places, 306 tagged — vs live 447 (≤1 day stale). |
| F6 | WebExtension `bookmarks` API exposes no tags (operator + orchestrator recollection; MDN `BookmarkTreeNode` has no tags field). Not run-verified; does not need to be, since F2 already rules the extension out as the *sole* source. |
| F7 ✓ | `node:sqlite` is available in the toolchain Node 24.21 (SQLite 3.53.3) and already used by malebolge (`src/instance-lock.ts:7`). No flake addition needed for either path. |
| F8 ✓ | The profile dir also holds `logins.json`, `key4.db`, cookies and full history in `places.sqlite`. |

## Thread 1 — governance applicability

Full list: `raw/governance.md`. Rows design leans on:

### Binding

- **DEC-024 / DEC-025** — tools exist only through a named toolset fixed at
  creation; bookmark tools enter via `CATALOG.interactive`.
- **DEC-026** — bounds: rendered-byte budget, trusted header, truncation
  stated, never silent.
- **DEC-027** — read tools stateless and replay-safe; no cursor or cache
  state in the tools. (A source-side memo keyed by file identity is not
  tool state — design to confirm.)
- **DEC-028** — reuse `src/bounded-exec.ts` if a child process is used;
  configured absolute paths, no `PATH` lookup, fail-closed validation.
- **DEC-029 ✓** — a toolset is the complete ordered extension list
  (`src/toolsets.ts:24-38`). Its text "an interactive conversation's prompt
  and tool order are unchanged" becomes false → amend. Per DEC-029(6) ✓, the
  catalog change reaches every stored interactive conversation at the next
  restart, logged (`docs/internals.md:120-125`).
- **DEC-030** — usage guidance in tool descriptions, untrusted-data rule as
  one test-pinned code section; persona prose stays in the corpus.
- **DEC-032 ✓** — interactive is the only talk set (`src/toolsets.ts:66-75`).
- **RSK-002** — framing is a code property pinned by test.
- **SL-005** — template: port + fake, bounds in code, framing, docs.

### Checked, not applicable

DEC-001…023 and DEC-031, 033–046 (attach, wire frames, threads), EVD-001/002,
SL-007 (different port/toolset). Reasons per row in `raw/governance.md`.

### Revision candidates

- **DEC-029** — amend the interactive list and the "unchanged" sentence.
- **RSK-002** — record a carve-out for bookmark metadata (see X1).
- **SL-005** context ("Not in the interactive tool set") — note that its
  rationale is about mail bodies, so it is not read as a general ban.
- **IMP-023** — state bookmark metadata is outside its scope, and that a
  digest tool must not join `interactive` by drift.
- **Docs** — `docs/internals.md` toolset tables + a Bookmarks section;
  README tool inventory.
- New **ASM**: the daemon reads the chosen bookmark source from a configured
  absolute path the jail binds.

## Thread 2 — code map

Full map: `raw/code-map.md`.

### Hotspots

- New `src/bookmarks/` in mail's roles: `source.ts` (port + schemas),
  adapter, `project.ts`, `render.ts`, `tools.ts`, `extension.ts`.
- `src/toolsets.ts:25` ✓ — `"bookmarks"` into `CATALOG.interactive`.
- `src/daemon-extensions.ts:27,31-52`, `src/daemon-start.ts:143-176` — build
  and wire the extension from config.
- `src/config.ts:41-51,87-108,301` ✓ (shape) — path config precedent
  (`ScrewtapePaths`, `absolutePathEnv`, read only when the profile allows the
  toolset).
- `test/fixtures/interactive-baseline.json` ✓ ("never regenerate", `:2`) and
  `test/toolsets.test.ts:157-170` ✓ — VT-1 compares the interactive snapshot
  to the frozen baseline, excluding `threads` by name. Bookmarks needs the
  same treatment (exclude-by-name, plus an explicit delta test like VT-5).
- `docs/internals.md`, `README.md`.

### Reusable pieces

- Framing ✓: `MAIL_SECTION` (`src/mail/extension.ts:9`) and the
  `<mail-data untrusted="true">` wrapper (`src/mail/render.ts:21-22`) —
  mail-worded; the budget/cut primitives in `src/mail/render.ts:28-75`
  (`dataLine`, `renderedLength`, `cutRendered`, `shareOf`) and the clamp
  vocabulary in `src/mail/tools.ts:30-96` carry no mail semantics.
- `src/bounded-exec.ts`, `src/json.ts`, `src/truncate.ts`.

### Naming precedents

`<family>_<verb>` tools (`mail_read`, `wake_list`, `thread_post`); extension
name = catalog name = section key (`"mail"`).

### Test conventions

`test/mail/`: `mail-fixtures.ts` with a recording fake source; adapter tests
fake I/O, not the port; scrubbed real fixtures (`fixtures/real/SCRUB.md`);
tools exercised via `tool.execute` asserting one text output; wiring tests in
`test/daemon-start.test.ts`, `test/daemon-sections.test.ts`; structure guard
`test/structure.test.ts`; coverage gate 85% lines.

## Cross-thread findings

- **X1 — RSK-002 vs interactive placement (✓ RSK-002 text).** RSK-002 defines
  Q1 as "anything that has read Q0 … presumed contaminated for its lifetime",
  with Q0 = "raw mail and page text". Bookmark titles are mostly page titles,
  so read literally, interactive becomes Q1 — and interactive is the one talk
  set. The operator's OQ-2 decision needs a recorded carve-out: bookmark
  metadata (title, URL, tags, folder) is not Q0 page text; it is short,
  largely operator-curated (tags and folders are wholly the operator's), and
  framed as untrusted. Mitigating context (inference, not checked): interactive
  already has host bash and file reads, so it is not a clean room today.
- **X2 — Data path, decided by tags and the jail.**
  - (c) panopticon extension: no tags (F2, F6). Out as the source; keep it for
    IDE-008 step 2/3 (live folder writes, capture).
  - (b) copy `places.sqlite` + WAL: fresh, but needs the profile's live files
    bound into the jail, exposing full history (F8), and couples to Firefox's
    internal schema (F1).
  - (a) newest `bookmarkbackups/*.jsonlz4`: tags present (F5), stable export
    format, ≤1 day stale, ~20-line decoder (F4), and the jail bind is the
    `bookmarkbackups/` directory alone — no history, logins or keys (F8;
    jail property "its only secret is the gateway key file",
    `docs/internals.md:208-209` ✓).
  - Leaning (a). Freshness gap is a day; Firefox writes a backup on idle
    daily, and the backup timestamp goes in the result header so staleness is
    stated, not hidden.
- **X3 — Step 2 writes are harder than assumed.** The extension cannot write
  tags (F6) and the live DB is locked (F3). Tag edits in IDE-008 step 2 mean
  either a generated backup the operator restores (Library → Restore, which
  replaces the whole tree) or a write while Firefox is closed. Folder moves
  and renames can go through the extension. Record on IDE-008.
- **X4 — Framing reuse vs mail wording.** The reusable budget primitives sit
  in `src/mail/render.ts` beside mail-specific tags; DRY says lift the
  measuring/cut/clamp primitives into a shared module rather than copy them.
  That touches SL-005/SL-007 code — design to weigh against SL-007 being in
  flight on the same files.
- **X5 — Prompt coupling.** The interactive persona is corpus prose
  (`prompts/interactive.txt`); per DEC-030 tool guidance goes in tool
  descriptions and the framing section, so no corpus change is required.
  Confirm in design.

## Design-input deltas

1. OQ-1 → (a) jsonlz4 backup, unless the operator wants same-day freshness
   enough to bind live profile files (b).
2. OQ-2 settled (interactive) — needs an RSK-002 carve-out record (DEC) and
   a DEC-029 amend.
3. OQ-3 dissolves under (a): malebolge reads a file directly; no external
   program, so DEC-028's exec rules don't apply; no panopticon change.
4. OQ-4 → bind `<profile>/bookmarkbackups` read-only; configured as an
   absolute path (`MALEBOLGE_BOOKMARK_BACKUPS` or similar), read only when the
   profile allows interactive.
5. New: lift shared render/clamp primitives out of `src/mail/` (X4).
6. New: baseline test treatment for an added interactive extension.
7. Step-2 constraint (X3) recorded against IDE-008.
