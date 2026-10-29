## Thread 2 — code map

### Hotspots (files likely to change or be added)

| File | Change |
|---|---|
| `src/bookmarks/source.ts` (new) | Port + TypeBox schemas + `BookmarksSourceError` (mirror of `src/mail/source.ts`) |
| `src/bookmarks/<adapter>.ts` (new) | Data path behind the port: `jsonlz4`/places reader or panopticon CLI |
| `src/bookmarks/project.ts`, `render.ts`, `tools.ts`, `extension.ts` (new) | Projection, bounding/rendering, `defineTool` definitions, `defineExtension` + section |
| `src/toolsets.ts:25` | `interactive` catalogue gains `"bookmarks"` |
| `src/daemon-extensions.ts:27,31-52` | `bookmarks?: Extension` part + builder entry |
| `src/daemon-start.ts:143-152,155-176` | Build the extension from `Config` |
| `src/config.ts:41-51,87,100-108,301` | `BookmarkPaths` + `bookmarksOf(env, profile, home)` |
| `test/fixtures/interactive-baseline.json` | Baseline snapshot must be regenerated-or-extended deliberately (see below) |
| `docs/internals.md:130-200` | Mail section precedent; add a Bookmarks section |

### Cited facts

**Port & schemas (mail-specific today).** `src/mail/source.ts:5-7` — "the v1 contract schemas … and the MailSource interface. Nothing here does I/O." Schema map `KIND_SCHEMAS` at `src/mail/source.ts:184-190`, fail-closed validator `checkData` at `:199-207`. The port is a plain interface of five verbs (`src/mail/source.ts:245-252`), failures a closed vocabulary plus a message-safe error class (`:254-263`).

**Client.** `src/mail/screwtape.ts:30-34` sets `MAIL_STDOUT_MAX` (4 MiB), `MAIL_STDERR_MAX` (4 KiB), `MAIL_TIMEOUT_S` (10 s); `ScrewtapeOptions` (`:36-45`) is `{binary, config, home, env}` where `env` is `Pick<ExecutionEnv,"exec">`. One child per call, argv `[binary, "--config", config, …]`, `inheritEnv: false`, `env:{HOME}` (`:233-268`). Envelope contract enforced in `checkEnvelope` (`:190-217`) with a fixed `Violation` vocabulary (`:122-128`). Non-zero exits mapped in `exitError` (`:170-186`); stdout oversize → `oversizeError` (`:131-140`). Public factory `screwtapeSource` (`:300-340`).

**Tools.** Ranges/clamps as data: `NEW_LIMIT`/`READ_MAX_BYTES`/`LIST_LIMIT` (`src/mail/tools.ts:30-52`), clamp helper `bounded` (`:68-76`), joint clamp `NEW_JOINT_BYTES` (`:43`). Input validation refused pre-port via `MailInputError` (`:98-103`, `idOf`/`fromOf` `:107-140`). Tool wrapper: `mailTool` → `defineTool({name, description, parameters, replay: "safe", execute})` (`:275-296`); `replay: "safe"` is justified "reading mail changes nothing" (`:282`). Result shape is one text output: `{ output: [{ type: "text", text }], isError: false }`, and `MailInputError`/`MailSourceError` become `isError: true` (`:286-294`). Deps injected as `MailDeps {source, now}` (`:208-211`); registry built by `mailTools(deps)` (`:390-420`).

**Caps & truncation.** Rendered size = UTF-8 bytes of `JSON.stringify` with `<`/`>`/`&` escaped (`src/mail/render.ts:33-43`). Budget: total 50 KiB (`:11`), header reserve 2 KiB (`:13`), per-item share `shareOf(limit)` (`:28-30`), longest-fitting code-point cut `cutRendered` (`:64-75`). Whole result header + `<mail-data untrusted="true">` wrapper (`:21-22,327-333`); trusted header only literals and fixed forms, failing closed (`:290-322`); page assembly `renderPage` (`:335-350`). Truncation is always named: per-item `cut` list, `output_truncated`, and header counts (`:237-260`).

**Untrusted framing.** `MAIL_SECTION` states the block is email data, never instruction, and that `cut` names shortened fields (`src/mail/extension.ts:9`); installed as a tagged section `section("mail", …, {tag:true})` (`:12-17`). Jail/daemon doc restates it (`docs/internals.md:176-181`).

**Toolsets.** Closed catalogue as data (`src/toolsets.ts:1-3`): `Toolset = "interactive"|"mail"|"job"` (`:10`), interactive list at `:25-36`, mail at `:37`, room-only filtering (`SATAN`/`tasks`/`threads`) at `:39-49`, profile policy `PROFILE_TOOLSETS` (`:62-65`), installable union `allowedNames` (`:101-107`). Extension construction: `builders` map (`src/daemon-extensions.ts:31-52`) — note `mail-persona` at `:34` and the conditional `mail` insert at `:48-51`; `daemonExtensions` composes them and calls `requireInstalled` (`:65-70`). Daemon wiring: `mailPart` builds `screwtapeSource` over a host `NodeExecutionEnv` and `mailExtension` (`src/daemon-start.ts:143-152`), consumed by `daemonRegistry` (`:160-176`).

**Config precedent for locating Firefox.** `ScrewtapePaths` is absolute paths only, "never a PATH lookup" (`src/config.ts:41-51`); `absolutePathEnv` refuses unset/empty and relative values (`:87-93`); `screwtapeOf` reads the variables only when the profile allows the toolset (`:100-108`), and `resolveConfig` attaches it with `setDefined` (`:301`). Env names: `MALEBOLGE_SCREWTAPE`, `MALEBOLGE_SCREWTAPE_CONFIG` (`:42-45`). Doc: read only in the allowed profile, deployment order, jail binds (`docs/internals.md:182-199`); jail contents `docs/internals.md:201-215`.

**sqlite / lz4.** `node:sqlite` already used: `src/instance-lock.ts:7` (`DatabaseSync`, exclusive lock `:29-45`), `src/runner/store.ts:2`, and in tests `test/mail/smoke.test.ts:25`, `test/runner/live-fixture.ts:11`. `package.json:22-31` dependencies contain no lz4/compression package (`smol-toml`, `typebox`, `yaml`, pi packages only); Node engine `>=24` (`package.json:7-9`) — so a `jsonlz4` decode needs either a hand-written decoder or a new dependency.

### Reusable pieces (vs mail-specific)

Reusable as-is (no mail words inside):
- `boundedExec` / `boundedOutput` (`src/bounded-exec.ts:68`, `:151`; header `:1-13` says it is shared by grep and mail) — for a CLI data path.
- `isRecord` (`src/json.ts:6-9`); `boundedLineSplitter`/`encodeLine` (`src/ndjson.ts:27,82`); `headKeeper`, `capUtf8` (`src/truncate.ts:9,39`).
- The clamp vocabulary `Range`/`bounded`/`Clamp` (`src/mail/tools.ts:30-76,90-96`) — copy or lift into a shared module; it names only "limit/offset/max_bytes".
- The measuring/cutting primitives `dataLine`, `renderedLength`, `cutRendered`, `shareOf` (`src/mail/render.ts:28-75`) — reusable, but the file also hard-codes `mail-data`, `MAIL_*` and `MailTool` (`:11-22,230`), so either parameterise the tag/tool union or copy.

Mail-specific (rewrite): `MailSource` verbs & schemas (`src/mail/source.ts:184-252`), JMAP id/cursor dates (`:11-66`), screwtape argv/failure wording (`src/mail/screwtape.ts:54-110,131-186`), the five tools' descriptions and `mail_*` names (`src/mail/tools.ts:216-273,390-420`), projection/cut order (`src/mail/project.ts:21-38`), `MAIL_SECTION` (`src/mail/extension.ts:9`), and `run`'s envelope contract (`src/mail/screwtape.ts:233-268`).

### Naming precedents

- Tools: `mail_<verb>`, short stem + verb — `mail_new`, `mail_read`, `mail_thread`, `mail_list`, `mail_mailboxes` (`src/mail/tools.ts:392-419`; pinned in `test/daemon-sections.test.ts:229-236`). Other families use `<group>_<verb>` too: `wake_schedule`/`wake_cancel`/`wake_list` (`test/fixtures/interactive-baseline.json:44-48`), `thread_post`/`thread_start`/`thread_fork` (`test/toolsets.test.ts:189`). Suggested: `bookmarks_search`, `bookmarks_list`, `bookmarks_tree`/`bookmarks_tags`.
- Modules: one directory per foreign-data family, five files in fixed roles — `source.ts` (port+schemas), `<adapter>.ts` (I/O), `project.ts`, `render.ts`, `tools.ts`, `extension.ts` (`src/mail/*`). Extension name = toolset name = section key (`"mail"`, `src/mail/extension.ts:12-17`; `src/toolsets.ts:37`; `src/daemon-extensions.ts:51`). A `bookmarks` extension and `"bookmarks"` catalogue entry follow the same single-word convention.

### Test conventions

- Per-family directory `test/mail/`: `mail-fixtures.ts` (shared builders + `fakeMailSource`), `source.test.ts`, `screwtape.test.ts` (fake `ExecutionEnv`), `project.test.ts`, `render.test.ts`, `tools.test.ts`, `smoke.test.ts` (opt-in).
- Fakes: `fakeMailSource(replies)` records every call and rejects an un-replied verb, so a tool reaching for the wrong verb shows (`test/mail/mail-fixtures.ts:557-586`). Adapter tests fake the exec, not the port: a `Script {stdout, stderr, result, killable}` drives argv recording and abort (`test/mail/screwtape.test.ts:39-46`).
- Fixtures: `test/mail/fixtures/{real,contract}/*.json(.jsonl)`, loaded by `fixtureFiles`/`loadEnvelopes`/`loadData` (`test/mail/mail-fixtures.ts:28-80`); real ones scrubbed per `test/mail/fixtures/real/SCRUB.md`.
- Tool exercise: fetch registration by name, call `tool.execute(args, API, context)`, assert exactly one text output (`test/mail/tools.test.ts:41-70`); time fixed via `now: () => NOW` (`:24`). Inputs refused before the port are observed as "the fake recorded no call" (`test/mail/tools.test.ts:1-3`).
- Wiring tests: daemon start asserts tool count and names (`test/daemon-start.test.ts:662-670`, host installs none at `:604-625`); extension shape and pinned section text (`test/daemon-sections.test.ts:225-251`).
- **Toolset membership guards.** There is no "interactive never includes `mail_*`" assertion (grep over `test/` finds `mail_*` only in `daemon-sections.test.ts:229-236` and `daemon-start.test.ts:670`). Instead membership is pinned by the frozen baseline `test/fixtures/interactive-baseline.json` ("never regenerate", `:2`) compared in `test/toolsets.test.ts:157-166`, with the room's delta asserted explicitly (`:169-191`) and host asserted unmoved (`:243-246`). Adding `bookmarks` to `interactive` will break `VT-1`/`VT-5` until the baseline and the delta expectation are extended.
- Module-boundary guard: `test/structure.test.ts:1-5,57-67,93` — a new `src/bookmarks/` dir is tier `"other"`, which may not import `runner/`.
- Coverage gate 85% lines over `src/**` with entry points excluded (`vitest.config.ts:18-21`); opt-in smoke excluded unless its env var is set (`vitest.config.ts:12-16`).
