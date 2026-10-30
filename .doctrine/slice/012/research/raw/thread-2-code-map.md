## Thread 2 — code map

### Hotspots
- `src/mail/tools.ts` — the tool factory and every input check a plan tool must copy (`mailTool`, `idOf`, `kindOf`, `reportText`).
- `src/mail/extension.ts` — the `mail` extension's deps/sections; a plan store becomes a new `MailDeps` member or a sibling extension.
- `src/mail/policy.ts` — home of the only closed vocabulary today (`REPORT_KINDS`); a closed action set belongs beside it.
- `src/mail/project.ts` — drops `message_id` from every projection (identity must come from screwtape, not the agent).
- `src/mail/source.ts` — `ReadSchema.message_id` / `mailbox_ids` are the fields malebolge must resolve; `MailSource` needs no new verb.
- `src/mail/screwtape.ts` — `read <id>` is the only per-message fetch; no by-Message-ID lookup exists.
- `src/toolsets.ts` / `test/toolsets.test.ts` — catalogue count and guard tests pin exactly six mail tools.
- `src/config.ts` — where a plans path would be configured (mirroring `bookmarkBackupsOf`).
- `emacs/malebolge.el` + `test/malebolge-ert.el` — the renderer/executor and its ERT suite; neither knows Gnus.
- `README.md`, `docs/internals.md` — both still say "five `mail_*` tools".

### Cited facts

**1. Mail tool anatomy**
1. `mailTools(deps)` returns registrations in fixed order: `mail_new`, `mail_read`, `mail_thread`, `mail_list`, `mail_mailboxes`, `mail_report` — `src/mail/tools.ts:594`.
2. Registration goes through one factory, `mailTool(deps, spec)`, which appends `MAIL_DESCRIPTION_SUFFIX` to each description, sets `replay: "safe"` and converts `MailInputError`/`MailSourceError` into an error result — `src/mail/tools.ts:345`, suffix at `:242`, `replay` at `:351`.
3. Every error result is prefixed exactly once with `"malebolge: "` in `errorResult` — `src/mail/tools.ts:334`, `:239`.
4. `MailDeps` is the injected surface: `source`, `now`, `cache`, `reported`, `log`, `refusal` — `src/mail/tools.ts:229`. No I/O in the module (comment at `:1-10`).
5. `mail_report`'s parameters are `{ id, kind }`, `kind` an enum from `REPORT_KINDS` — `src/mail/tools.ts:295`.
6. Its closed vocabulary is `REPORT_KINDS = ["instructions_to_agent","phishing","impersonation","malware","other"]` in `src/mail/policy.ts:18`, guarded by `isReportKind` (`src/mail/tools.ts:127`) and `kindOf`, whose message never repeats the refused value (`:132`).
7. Its side effect is one journal line through the injected `log` plus an insert into the in-memory `reported` map, then the literal text `"reported"` — `src/mail/tools.ts:575-591`; the line format is `mail_report conversation=… id=… kind=… jev=…` at `:315`.
8. `mail_report` never calls the port and never classifies (comment + structure at `src/mail/tools.ts:568-573`); `jev` comes from the classification cache or the literal `none` (`:330`).
9. Volume cap precedent: `REPORTED_MAX = 1000`, refusing a new id when the set is full, re-reporting a held one allowed — `src/mail/tools.ts:69`, `:579`.
10. The extension installs the tools and one tagged prompt section — `src/mail/extension.ts:61`, `MAIL_SECTION` at `:12`.
11. Registered at startup from `daemon-start.ts` with `cache: classificationCache()`, `reported: new Map()`, `log` (the stderr `Log`), and a `refusal` computed once — `src/daemon-start.ts:192-205`; `Log` is `(text: string) => void` (`src/satan-tools.ts:36`) writing to stderr with the `malebolge: ` prefix (`src/daemon-main.ts:10-11`).
12. `mail_report` is tested in its own section: a `report()` helper captures lines and the map, then asserts exactly one line (with cached jev and `none`), that later tools withhold the id, each refusal case (prefixed, nothing logged, set unchanged, no port call), that the refusal never repeats the value, no classify call, re-report replaces kind, and the `REPORTED_MAX` boundary — `test/mail/tools.test.ts:1859-1876`, `:1885-1996`, `:1996-2025`.

**2. Argument validation, id/refusal rendering, untrusted framing**
13. Validation is hand-written over untyped `JsonRecord`, not TypeBox inside `execute`: `isRecord(raw)` refusal then per-param helpers — `src/mail/tools.ts:352-375`.
14. `idOf` refuses a non-string, a leading `-` (option injection into screwtape) and anything outside the JMAP Id form — `src/mail/tools.ts:115-125`; the pattern is `JMAP_ID` in `src/mail/source.ts:11`, with `isJmapId` at `:14`.
15. TypeBox schemas are used only for the model-facing parameter declaration (`NEW_PARAMETERS` etc.), with `Type.Object`/`Type.String({enum})` — `src/mail/tools.ts:301`, `:250-292`; one schema carries a pattern (`src/mail/source.ts:68`).
16. Bounds are clamped and reported via `bounded(...)` + `report(clamps, …)` from `src/ranges.ts` (`src/mail/tools.ts:66-82`), rendered into the header by `clampsLine` — `src/untrusted-block.ts:100`.
17. Result framing: `renderPage` → `renderResult` → `renderBlock(MAIL_TAG, header, lines)` — `src/mail/render.ts:281`, `:276`, tag `mail-data` at `:25`; block text at `src/untrusted-block.ts:127-133` with `RESULT_MAX_BYTES` 50 KiB (`:13`).
18. Each data line is `dataLine(value)` = escaped `JSON.stringify` (`src/untrusted-block.ts:42`), and byte accounting is on rendered size (`:1-9`).
19. The header is trusted, fixed-form text: `itemsLine`, `missingQuestionLines` (refuses a question name not in the policy table), `nextLine` (refuses a non-canonical cursor), `caught_up`, `clamps`, `thread`, `shown`, `known_gaps` — `src/mail/render.ts:195`, `:215`, `:228`, `:248-273`.
20. The tag-length budget charges only `LONGEST_TAG = "bookmark-data"` — `src/untrusted-block.ts:18-20`, `:34`; a longer plan tag would invalidate that reserve (inference).
21. Withheld items keep no sender text: `projectWithheld` is chosen in `itemOf` before the shown projector runs — `src/mail/tools.ts:415-435`.

**3. Ids the agent sees; source resolution**
22. `SummarySchema` carries `id`, `thread_id`, `mailbox_ids`, `is_seen`, `is_flagged`, `has_attachment` and a cursor — `src/mail/source.ts:87-98`.
23. Only `ReadSchema` carries `message_id: Array<string>`, plus `in_reply_to`/`references` — `src/mail/source.ts:134-136`.
24. The projection drops `message_id`, `in_reply_to`, `references`, `cid` and `disposition` — `src/mail/project.ts:831-846`, and they are on the never-shown list at `:952`, `:1023`; asserted at `test/mail/project.test.ts:130` and `test/mail/tools.test.ts:1175-1201`.
25. `mailbox_ids` survives as a *fill* field on every item kind — `src/mail/project.ts:515-518`, `test/mail/project.test.ts:963-968`.
26. So the agent knows screwtape ids and mailbox ids but never a Message-ID; the Message-ID must be resolved by malebolge (inference from 22–24).
27. `MailSource` verbs: `mailboxes`, `list`, `read`, `readAfter`, `thread`, `classify` — `src/mail/source.ts:307-320`; errors are `MailSourceError` with a fixed `MailFailure` set (`:324-334`).
28. screwtape argv: `mailboxes` (`src/mail/screwtape.ts:637`), `list --limit --offset [filters]` (`:87-100`), `read <id> --max-bytes` (`:101`), `read --after …` (`:104-118`), `thread <id> --limit` (`:119`), `classify` (`:449`). No lookup-by-Message-ID verb exists.
29. `read <id>` returns `message_id` and `mailbox_ids`, so one message's headers/mailboxes by id are available — `src/mail/screwtape.ts:101-102` with the schema at `src/mail/source.ts:134`, `:94`; verified against `test/mail/fixtures/contract/read.json:1`.
30. `classify` reads each id with the read verb first, at `CLASSIFY_READ_BYTES = 16_384` — `src/mail/screwtape.ts:46`, `:404-412`.
31. Mailboxes are shown with `id`, `name`, `parent_id`, `role`, `sort_order`, counts — `src/mail/project.ts:521-534`; `role` is the server's (e.g. trash/archive) — `src/mail/source.ts:81-89`.
32. Withholding: `reported` beats `unclassified` beats `missing_question` beats `hostile` — `src/mail/policy.ts:37-62`, table at `:8-11`.
33. Classifications are cached per id and consulted once per tool call (`classificationsOf`) — `src/mail/tools.ts:379-400`, `MailDeps.cache` at `:229`.

**4. Catalogue and guards; the mail prompt**
34. Catalogue: `mail: ["mail-persona", "conversation", "mail"]` — `src/toolsets.ts:52`; `Toolset` is a closed type (`:9`).
35. Guard test VT-2 asserts the mail list exactly and that it holds no `coding-tools`, `grep`, `satan`, `tasks`, `threads`, `bookmarks` — `test/toolsets.test.ts:243-254`.
36. Guard test VT-3 pins the registered mail tools to exactly the six names in order — `test/toolsets.test.ts:256-269`.
37. Profile policy refuses mail on host entirely — `src/toolsets.ts:81`, `test/toolsets.test.ts:322-325`.
38. The mail persona is `system/scaffold.txt` + `prompts/mail.txt`, no environment file — `src/persona.ts:36-38`; built as extension name `mail-persona` (`src/daemon-extensions.ts:37`, `src/persona.ts:61`).
39. The persona files come from `corpusRoot` = `$SATAN_CORPUS_ROOT` or `~/satan-corpus` — `src/config.ts:337`. No "You write nothing" text exists anywhere in this repo (grepped; only `test/malebolge-ert.el:211`, `:254` match, and those are about drafts), so that sentence lives in the external corpus `prompts/mail.txt`, which is not in this checkout (inference from 38–39).

**5. Daemon state on disk and where a plan file could live**
40. State root: `$XDG_STATE_HOME/satan` (default `~/.local/state/satan`); per-profile `durable/<profile>`; `session.sqlite` and `daemon.lock` there — `src/config.ts:332-340`.
41. Runtime: `$XDG_RUNTIME_DIR/satan`, socket `durable/<profile>/durable.sock` — `src/config.ts:333`, `:342`; MCP socket at `:340`.
42. The daemon only ever `mkdirSync`s; nothing in `src/` writes a file (grep: only `src/instance-lock.ts:24`, `src/daemon-start.ts:131`, `:377`). There is no file-backed daemon state at all.
43. Conversation/topic index lives inside the SQLite store, read via `readIndex(session.snapshot)` — `src/topics.ts:203`, `:163`; the daemon's one writer is the startup reconcile (`docs/internals.md:126-133`).
44. Precedent for a configured absolute path that may not exist yet: `MALEBOLGE_BOOKMARK_BACKUPS` via `bookmarkBackupsOf`, "never checked for existence" — `src/config.ts:132-143`.
45. Precedent for an unconfigured-but-installed source that refuses each call — `src/toolsets.ts` comment `:64-67` and `bookmarksPart` fallback in `src/daemon-start.ts:209-211`.
46. SATAN read roots are not modelled in code: the mail toolset holds no SATAN/coding/grep tool (34–35), so a mail conversation cannot read any path; tools run with `SATAN_CWD` = the profile cwd/room home (`src/conversation-context.ts:68-81`, `src/daemon-env.ts:143`) (inference: "outside every SATAN read root" has no code-level enforcement point; it is a design constraint on where plans are stored).
47. Candidate homes: a new `<stateRoot>/plans` beside `durable/` (parallel to 40), or a configured `MALEBOLGE_MAIL_PLANS`-style path modelled on 44. The store dir itself is bound read-write into the jail for screwtape (`docs/internals.md:199-204`), which argues against putting plans there (inference).

**6. The Emacs client and OQ-1**
48. `malebolge.el` is a comint transcript over the `malebolge-attach` CLI, started with `make-comint-in-buffer` — `emacs/malebolge.el:4-7`, `:436-440`; the transcript mode is read-only and refuses comint input (`:196-207`, `:244-250`).
49. Frames are newline-terminated JSON written with `process-send-string` — `emacs/malebolge.el:222-231`.
50. The client can run one-shot CLI calls through `malebolge--client` with a bounded wait (`malebolge--list-timeout` 5 s) — `emacs/malebolge.el:256`, `:276-320`; used for `--list`, `--topics`, `--models`, `--set-topic`.
51. CLI flags are a closed `parseArgs` set (`--conversation/--topic/--new/--cwd/--dir/--set-topic/--toolset/--model/--emacs/--list/--topics/--models/--no-*`) — `src/attach-invocation.ts:48-72`; a `--plans` verb would extend this table (inference).
52. The daemon→client stream is `AgentEvent | AttachedMessage | ConversationsMessage | ModelsMessage | TopicsMessage | ErrorMessage` — `src/protocol.ts:6-12`, `src/render.ts:20-28`.
53. The attach client renders every event to *text* before Emacs sees it (`events become text`, `createRenderer(...).toPrintable`) — `src/attach.ts:1-2`, `:176-191`; Emacs then only font-locks the text by label regex: `[tool]`, `[status]`, `[thread]`, `[wake]`, reap — `emacs/malebolge.el:133-146`, `:153-182`.
54. Therefore a plan arriving via the attach stream today would arrive as prose, not structure: OQ-1 via the stream needs either a new `Printable` event type plus an Emacs parser (`src/render.ts:20-28`, `emacs/malebolge.el:133`) or a file the elisp reads itself (inference from 51–53).
55. ERT suite: `test/malebolge-ert.el`, run by `just ert` under `emacs --batch` plus a byte-compile with `byte-compile-error-on-warn` — `justfile:19-23`; 48 `ert-deftest`s (`test/malebolge-ert.el:167` onward).
56. ERT fixture style: a fake process is substituted for `make-comint-in-buffer`, stdin is captured to a temp file, `malebolge-test--with-session` binds `transcript` and `draft` and waits via `accept-process-output` — `test/malebolge-ert.el:99-149`; frames decoded with `json-parse-string` at `:91-94`.
57. End-to-end smoke (`just smoke`) runs Emacs → `malebolge-attach --emacs` → fake daemon — `justfile:25-26`, `test/emacs-attach-smoke.ts` (680 lines).
58. No Gnus code exists anywhere in the repo (grepped `gnus|Gnus` across `*.el`, `*.ts`, `*.md`: no hits); `malebolge.el` requires only `comint`, `json`, `subr-x` — `emacs/malebolge.el:50-52`.

**7. Test layout and fixtures**
59. Vitest collects `test/**/*.test.ts` only — `vitest.config.ts:8`; coverage gate 85% lines over `src/**` and `pi-bridge/**` — `vitest.config.ts:11-15`.
60. Mail tests: `test/mail/{tools,render,project,policy,screwtape,source,classifications,smoke}.test.ts` plus `mail-fixtures.ts`.
61. `fakeMailDeps(overrides)` is the single place a mail test gets dependencies, "so a new member is added here" — `test/mail/mail-fixtures.ts:608-620`; `fakeMailSource(replies)` records every verb+query and fails on an unexpected verb — `:624-663`.
62. Fixtures: `test/mail/fixtures/contract/*` (synthetic envelopes, incl. `read.json`, `read-after-2-lines.jsonl`, `mailboxes.json`) and `test/mail/fixtures/real/*` (scrubbed real reads) — `test/mail/fixtures/SOURCE.md`, `SCRUB.md` (unverified line numbers).
63. Real-screwtape smoke is opt-in: excluded unless `MALEBOLGE_MAIL_SMOKE=1` — `vitest.config.ts:9-13`, `test/mail/smoke.test.ts:1-14`; it copies the store and uses only read verbs.
64. The screwtape adapter is tested over a fake `ExecutionEnv` recording argv and exec options, with fixtures as raw stdout text — `test/mail/screwtape.test.ts:1-56`.
65. Ergonomic helper for tools: `run(source, name, args, ctx, deps)` finds the registration and asserts exactly one text output — `test/mail/tools.test.ts:99-116`; the stub `api` provides only `env` and `conversationId` (`:80-83`).

**8. Append-only / JSONL writers**
66. None exist. There is no `appendFile`/`appendFileSync`/write stream anywhere in `src/` or `pi-bridge/` (grep: zero hits); the only writes are `mkdirSync` (`src/instance-lock.ts:24`, `src/daemon-start.ts:131`, `:377`).
67. `mail_report`'s "journal" is a callback to stderr, not a file — `src/daemon-start.ts:200` passing `log`, `src/daemon-main.ts:10-11`.
68. The nearest append-shaped primitive is the NDJSON framing/splitter (`boundedLineSplitter`, `encodeLine`) — `src/ndjson.ts:1-60`, used by sockets only.
69. Test-only writers exist (`writeFileSync` in the smoke test) — `test/mail/smoke.test.ts:19-25` — but nothing reusable in product code.

### Naming precedents
- Tool names: `mail_<verb>`, lowercase, verb-not-noun (`mail_new`, `mail_read`, `mail_report`) — `src/mail/tools.ts:594-650`. A proposal tool reads `mail_propose` (slice text, `slice-012.md` scope 1).
- Closed vocabularies: an `as const` array plus a type plus an `is…`/`…Of` guard that refuses with the allowed list — `src/mail/policy.ts:18-26`, `src/mail/tools.ts:127-137`. Follow `REPORT_KINDS`/`ReportKind` → e.g. `PLAN_ACTIONS`/`PlanAction`.
- Errors: `MailInputError`, message `${tool}: ${param} must be …`, never echoing the value — `src/mail/tools.ts:106-137`; every model-visible error prefixed via `MAIL_ERROR_PREFIX` (`:239`).
- Deps: one `MailDeps` interface with injected port, clock, cache, sets and `log`; the fake is `fakeMailDeps` — `src/mail/tools.ts:229`, `test/mail/mail-fixtures.ts:608`.
- Module names in `src/mail/`: single lowercase noun, no suffix (`policy.ts`, `project.ts`, `render.ts`, `source.ts`) — a store would be `src/mail/plans.ts`.
- Untrusted tag: `<family>-data` with `untrusted="true"` (`mail-data`, `bookmark-data`) — `src/mail/render.ts:25`, `src/untrusted-block.ts:20`; a plan block would be `mail-plan-data` but must be charged in `LONGEST_TAG` (`src/untrusted-block.ts:18-20`) (inference).
- Elisp: file `emacs/malebolge.el`, feature `malebolge`, public `malebolge-<thing>`, private `malebolge--<thing>`, buffers `*malebolge*` / `*malebolge-draft*`, modes `malebolge-<x>-mode` — `emacs/malebolge.el:103-104`, `:188-196`, `provide` at `:607`.
- Tests: vitest `describe("VT-n <subject> (SL-00n PHASE-nn)")` — `test/mail/tools.test.ts:1885`; ERT names are `malebolge-<behaviour>` sentences — `test/malebolge-ert.el:167`, `:436`.
- Fixtures: `test/mail/fixtures/{contract,real}` with `SOURCE.md`/`SCRUB.md` provenance — `test/mail/fixtures/` listing.

### Gaps
- **No Message-ID in the agent's view and no way to resolve one back**: projections drop `message_id` (`src/mail/project.ts:831-846`) and no screwtape verb searches by Message-ID (`src/mail/screwtape.ts:87-119`). malebolge must resolve each proposed id with `read <id>` and carry `message_id` + `mailbox_ids` into the plan itself — the plan format has no schema anywhere yet.
- **No mailbox→Gnus group mapping**: mailboxes carry `id`/`name`/`role` only (`src/mail/source.ts:81-89`, `src/mail/project.ts:521-534`); OQ-2 has no config key (unlike `MALEBOLGE_BOOKMARK_BACKUPS`, `src/config.ts:138-142`).
- **No plan store**: no file writer at all (66), no plans path in `Config` (`src/config.ts:56-84`), no notion of "outside every SATAN read root" in code (46).
- **No append-only/JSONL writer to reuse** (66–69); the act log's home and format (OQ-6) has no precedent beyond `ndjson.ts` framing.
- **No Gnus code**: nothing in `emacs/` requires or calls Gnus (58); locating an article by Message-ID in nnimap and marking/moving a set (OQ-3) is entirely new.
- **No structured channel to Emacs**: the attach stream is pre-rendered text (`src/attach.ts:1-2`, `emacs/malebolge.el:133-146`), so OQ-1 has no ready mechanism; the CLI flag set is closed (`src/attach-invocation.ts:48-72`).
- **No plan lifecycle / batch model** (OQ-4, OQ-5): nothing in `src/mail/` accumulates state across tool calls except the in-memory `reported` map and classification cache (`src/mail/tools.ts:229`), both cleared on restart (`REPORT_PROPOSAL` precedent at `:69`).
- **Cap precedent exists only for reports** (`REPORTED_MAX`, `src/mail/tools.ts:69`); no per-plan line cap or per-conversation plan cap.
- **Doc drift to fix while touching the catalogue**: `README.md:351` and `docs/internals.md:84`, `:137` still say five tools and never mention `mail_report`; `src/mail/tools.ts:1` says six.
- **The mail persona (the "you write nothing" premise) is not in this repo** (`src/persona.ts:36-38`, `src/config.ts:337`): its text cannot be edited from this checkout (39).
- **Tag budget assumes `bookmark-data` is longest** (`src/untrusted-block.ts:18-20`): adding a longer plan tag silently breaks the reserve unless `LONGEST_TAG` changes.
- **`replay` semantics undecided for a writing mail tool**: today all mail tools are `"safe"` (`src/mail/tools.ts:351`); side-effecting tools elsewhere use `"unsafe"` (`src/threads/tools.ts:489`, `src/bridge/extension.ts:64`) — a plan write must pick one and say why.
