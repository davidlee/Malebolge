# Notes SL-008: Bookmark read tools: SATAN finds and relates Firefox bookmarks

Durable per-slice scratchpad — tracked in git. The place to lift anything from a
disposable phase sheet (`.doctrine/state/.../phase-NN.md`) that must survive
`rm -rf` before the slice close-out audit harvests it.

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-29 · ready (plan approved by operator: "ah. approve.") · 1384894

### Produced
- Slice scoped, researched (`research/research.md`, round 1), design run
  dr-01a18592… locked (rev 40) after RV-019; `design.md` materialised (8 sections).
- Plan: `plan.toml` / `plan.md`, 7 phases; operator approved it with the
  planner's settled choices (plan.md), 2026-10-29.
- minted: DEC-052 — read the daily jsonlz4 backup; DEC-053 — RSK-002 carve-out
  with field caps; DEC-054 — shared `src/untrusted-block.ts`; DEC-055 — optional
  env, explicit refusal; CHR-006 — operator rollout (env + jail bind); IDE-008,
  IMP-023 — originating backlog items.
- No code yet.

### Learned
- mem.fact.malebolge.firefox-bookmark-data — where tags live, locked DB, backup format.

### Further review
RV-019 concluded (pi + GPT passes, 21 findings answered, operator settled
Q1–Q3). No further design pass needed: the findings narrowed to wording and
module placement, and what remains is recipe-level — the LZ4 decoder's exact
behaviour and Firefox's guid form — which the plan's red/green tests and the
VA check on the live backup settle faster than another review. The next
review belongs to the plan.

### Open
- RV-019 — concluded; design locked on the operator's sign-off.
- Next: `/phase-plan` PHASE-01 (shared-module move; SL-007 overlap — second to
  execute rebases).
- SL-007 overlap on `src/mail/render.ts` (DEC-054) — second to execute rebases.
- New ASM (bookmark dir from configured path, jail-bound) and DEC-029 / RSK-002 /
  SL-005 / IMP-023 notes — due at reconcile (design sec-8).

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

## Review passes
- PHASE-01 · pi `implement` (deepseek-flash), 2 runs in one session: T1 red ($0.020), T2+T3 green/refactor ($0.044). Clean: followed spec, flagged the extra project.ts edit itself. Miss: none; noted `npx biome` broken in sandbox, used PATH biome. Gateway restart window: probe answered, no runs lost.
