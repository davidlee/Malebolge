## Thread 2 — code map

### Hotspots

| file | why it changes | key symbols (with line) |
|---|---|---|
| src/protocol.ts | `TopicMessage.model`, `TopicSummary.model`, `TOPIC_KEYS`, strict topic-field parser | `TopicMessage`:71, `TopicSummary`:100, `ConversationsMessage`:91, `TOPIC_KEYS`:141, `topicField`:300, `topicFrame`:320 |
| src/topics.ts | `TopicRecord.model`, `TopicChange.model`, `KEYS`, merge/clear, `writeCreated` | `TopicRecord`:51, `TopicChange`:54, `KEYS`:209, `without`:212, `written`:220, `merged`:232, `writeTopicRecord`:246, `writeCreated`:135 |
| src/conversations.ts | topic write validation + creation defaults + page/`marks` | `ConversationDefaults`:51, `TopicWrite`:54, `marksOf`:98/`pageOf`:111, `toolsetInit`:165, `create`:189, `openTopic`:224, `toolsetChange`:282, `conversations`:291 |
| src/daemon.ts | `topic` frame handler, replies | `listReply`:192, `topicsReply`:201, `FIRST_LINE`:241, `topic:`:251 |
| src/daemon-start.ts | catalog check at start; where `Models` exists; `defaults` | `StartDeps.models`:46, `requireKnownModel`:55, `modelsFor`:118, `models`:210, `defaults`:215, `conversations(...)`:255 |
| src/models.ts | `parseModel`/`ModelRef`/catalog | `GATEWAY_PROVIDER`:30, `ModelRef`:32, `DEFAULT_MODEL`:37, `parseModel`:39, `gatewayModel`:99, `parseGatewayCatalog`:148, `loadGatewayModels`:305 |
| src/request.ts | `--set-topic` frame build; skew keys | `SKEWED_KEYS`:93, `requestFrameOf`:118, `set-topic` case:126 |
| src/attach-invocation.ts | flags, exclusivity, `SetTopicInvocation` | `OPTIONS`:46, `flagsOf`:105, `checkAlone`:127, `writeOf`:295, `toolsetOf`:310, `attachInvocationOf`:314, set-topic branch:323 |
| src/render.ts | `--list`/`--topics` line formats | `markText`:313, `lineOf`:317, `conversations`:348, `topics`:351 |
| emacs/malebolge.el | chooser, argv, (no `--topics` reader) | `malebolge--attach-arguments`:255, `malebolge--list-conversations`:268, `malebolge--candidate-id`:316, `malebolge--conversation-candidates`:324, `malebolge--choose-target`:334 |
| src/threads/tools.ts, admission.ts, extension.ts | thread_start/fork creation | `createStarted`:161, `createForked`:224, `admitStart`:182, `ThreadDeps.defaults`:24 |

### Cited facts

**Q1 — topic write path**

1. `TopicMessage` (`type,name,cwd?,toolset?`): `src/protocol.ts:71-78`; strict keys `["type","name","cwd","toolset"]` at `src/protocol.ts:141`; each field parsed by `topicField` (`src/protocol.ts:300-313`), which rejects control characters because `--topics` prints TAB-separated lines (`src/protocol.ts:306`); assembled in `topicFrame` `src/protocol.ts:320-339`; `default` reserved at `src/protocol.ts:326-328`.
2. Daemon frame dispatch: `FIRST_LINE` map `src/daemon.ts:241-253`; `topic` row `src/daemon.ts:251-252` → `conversations.setTopic(frame)` → `topicsReply`.
3. `TopicRecord` `src/topics.ts:51`; `TopicChange` `src/topics.ts:54-57`; `KEYS = ["cwd","toolset"]` `src/topics.ts:209`; `merged` iterates `KEYS` and calls `written` `src/topics.ts:232-238`; `written` treats `undefined`/`null`/value `src/topics.ts:220-229`; `without` deletes a cleared key `src/topics.ts:212-217`. Generic-over-keys: the loop, `written`/`without` (typed `keyof TopicRecord`) and the merge rule. Per-key: the `KEYS` tuple, `TopicChange` members, and each value's type (`written` only accepts `string | null | undefined`, `src/topics.ts:223` — a `ModelRef` *object* stored in the record would need this widened).
4. `writeTopicRecord` refuses `default`, then one commit: `src/topics.ts:246-261`.
5. Toolset-vs-policy validation happens **in `setTopic`'s change builder**, not in the frame parser: `toolsetChange` → `requireAllowed(toolset, profile, ...)` at `src/conversations.ts:282-289`, wired at `src/conversations.ts:337-341`; `requireAllowed` itself `src/toolsets.ts:116-129`. Comment `src/protocol.ts:318` and `src/conversations.ts:287` state the frame never judges a toolset name. (A policy refusal is a plain `Error`, so it reaches the client as `{"type":"error"}` via `answer`/`fail` `src/daemon.ts:215-227`.)
6. Reply: `TopicSummary` `src/protocol.ts:100-104`, `TopicsMessage` `src/protocol.ts:110-114`, built by `topicsReply` `src/daemon.ts:201-208` (profile + records), rendered `src/render.ts:351-354`.
7. Three cases for `model` slot in exactly as `toolset`: add `model` to `TOPIC_KEYS` (`src/protocol.ts:141`), a `topicField(message,"model")` call (`src/protocol.ts:335-338` pattern), `model` in `TopicChange`/`TopicRecord` (`src/topics.ts:51-57`), `"model"` in `KEYS` (`src/topics.ts:209`), `model` in `TopicWrite` (`src/conversations.ts:54-59`) and a `model` entry in the `setTopic` merge (`src/conversations.ts:337-341`). `TopicSummary.model` at `src/protocol.ts:100-104`.
8. Merge safety for later keys is pinned: `src/topics.ts:11-12`, test `test/topics.test.ts:290`.

**Q2 — model parsing/checking**

9. `parseModel` is in **src/models.ts:39-45**, not config.ts: splits at the **first** `/` (`indexOf("/")`, line 40), so `gateway/openai-david/gpt-6.1-terra` → `{provider:"gateway", modelId:"openai-david/gpt-6.1-terra"}` (lines 44). Error text `model must be provider/model, got …` (line 42).
10. `ModelRef` `src/models.ts:32-35` (same shape as pi-durable's `ModelRef`, `node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts:10-13`); `DEFAULT_MODEL = "gateway/deepseek-flash"` `src/models.ts:37`; used by `resolveConfig` at `src/config.ts:290` (import `src/config.ts:18`).
11. `requireKnownModel` `src/daemon-start.ts:55-61`: `models.getModelOfType("chat", provider, modelId) === undefined` → `unknown model <provider>/<modelId>`; called from `modelsFor` `src/daemon-start.ts:118-122`.
12. `parseGatewayCatalog` `src/models.ts:148-167` (single provider, `openai-completions`, non-empty models) → `gatewayModel` `src/models.ts:99-123`, which **overwrites the catalog's provider name with the literal `"gateway"`** (`src/models.ts:108`) and ignores the JSON provider key (`soleProvider` `src/models.ts:126-134`). `loadGatewayModels` `src/models.ts:305-321` reads key file + catalog, `createModels()`, `setProvider`.
13. **`Models` is not reachable where topic frames are handled.** `serve()` only receives `conversations`, `beforeInput`, `orientation` (`src/daemon.ts:27-35`); `Conversations` has no models member (`src/conversations.ts:61-78`); `conversations(session, defaults, profile)` closes over `session` = `{harness, root}` (`src/session.ts:48-51`), and `Models` only enters `Harness.open` (`src/session.ts:188`, `models: options.models`). The live object is the local `models` in `startDaemon` (`src/daemon-start.ts:210`, from `modelsFor`), passed to `openBoundSession` (`src/daemon-start.ts:247-250`).
14. Threading needed: pass `models` into `conversations(...)` at `src/daemon-start.ts:255` (and extend the `Conversations` deps/type at `src/conversations.ts:291-295`), or expose it on `Session` (`src/session.ts:48-51`) and read it in `setTopic`. `StartDeps.models` (`src/daemon-start.ts:44-52`) is the test seam so tests can inject a faux catalog. Moving `requireKnownModel` to `src/models.ts` is allowed by the import rules: root tier modules may import root modules (`test/structure.test.ts:100-105`).

**Q3 — conversation creation**

15. `ConversationDefaults = AgentChange & { cwd: string }` `src/conversations.ts:51`; built once as `{ model: config.model, cwd: environment.cwd }` `src/daemon-start.ts:215` with the comment "root's on every open, every other conversation's at creation" (`:214`).
16. `create` applies it as `agent: { ...defaults, cwd }` on `createConversation` `src/conversations.ts:189-199`; called by `open` for `new` `src/conversations.ts:317-322` and by `openTopic` `src/conversations.ts:238-239`.
17. `openTopic` reads the topic (`indexOfTopic` → `isKnownTopic`, `src/conversations.ts:202-208`), picks cwd via `topicCwd` (`src/conversations.ts:214-221`), serialized by `serially` (`src/conversations.ts:242-252`, used `:298-301`).
18. `toolsetInit` is the init: it awaits `writeCreated(...)` **inside the creating commit** with a `choose(record)` callback that reads `record?.toolset ?? policy.default`, checks policy, then `configure(tx, id, { extensions: … })` — `src/conversations.ts:165-186`. `writeCreated` reads the index in the same commit and returns the toolset it wrote — `src/topics.ts:135-150`.
19. Where the topic's model would land: `ConversationInit` runs **after** the `agent` change in the creating commit (`node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts:417-420`, `:423-425`), and `configure` accepts `model?: ModelRef | null` (`.../types.d.ts:382-391`). So the model belongs in the same `configure`/returned-value path as the extensions: `toolsetInit` would need `writeCreated` to return the topic's model too (`src/topics.ts:142-149` only returns `DaemonToolset`), or a sibling `configure(tx, id, { model })` beside `src/conversations.ts:184`.
20. Root: `root.configure(options.agent, context)` on every open `src/session.ts:199` (doc `src/session.ts:57-60`), i.e. root takes `defaults` and never a topic model — matches Non-Goals.

**Q4 — threads and forks**

21. `ThreadDeps.defaults` is documented as "Model and cwd a started thread takes; cwd yields to its topic's" `src/threads/extension.ts:21-29`; bound early with `defaults` at `src/daemon-start.ts:236`.
22. thread_start: `admitStart` resolves `childTopic` (call's topic else caller's) and refuses unknown topics `src/threads/admission.ts:182-193`; `createStarted` then reads cwd from the topic (`topicCwd(admitted.index, …)`, `src/threads/tools.ts:168`), `configure(tx, child, { ...deps.defaults, cwd })` (`src/threads/tools.ts:169`) — **the defaults' model goes in here verbatim** — then `toolsetInit(...)` with the talk-set `require` (`src/threads/tools.ts:170-180`).
23. thread_fork: `tx.forkConversation(caller, latest.id, …)` `src/threads/tools.ts:235-237`; no configure call, so the fork keeps whatever pi-durable copies from the parent; the comment says "The index hook copies the caller's topic and toolset" `src/threads/tools.ts:222-223`.
24. `indexConversation` copies the parent entry's `topic`, `parent`, `toolset` and **throws when the parent has no toolset** `src/topics.ts:105-127` (test `test/topics.test.ts:94`). Note `IndexEntry` (`src/topics.ts:36-41`) carries **no model**, so a fork's model is only inheritable from the conversation's stored agent, never from the index.

**Q5 — list reply, `marks`, Emacs**

25. `ConversationsMessage` `src/protocol.ts:91-97` (`conversations`, `truncated`, optional `marks`), built by `listReply` `src/daemon.ts:192-198` (key omitted when undefined, `:196-197`), from `ConversationPage` `src/conversations.ts:87-92`.
26. `marks` is built in **src/conversations.ts**: `marksOf` `:98-108`, `pageOf` `:111-117`; the `all` page reads the index in the same commit as the scan (`scanPage` `:255-271`), the topic page from the pre-read index (`topicPage` `:274-279`).
27. CLI rendering: `lineOf` prints `id` or `id<TAB>mark` (`src/render.ts:317-318`), `markText` `:313-314`, `conversations` handler `:348-349`, `topics` handler prints `name<TAB>cwd<TAB>toolset` `:351-354`. `--topics` shape pinned at `test/render.test.ts:237-251`, `--list` at `test/render.test.ts:218-235`.
28. Emacs parsing: `malebolge--candidate-id` accepts `\`\([0-9]+\)\(\?:TAB[^TAB]+\)?\`` `emacs/malebolge.el:316-322`; `malebolge--conversation-candidates` keeps those lines whole `:324-332`; `malebolge--choose-target` appends `"new"` and returns the id or `"new"` `:334-352`. So a third tab field would currently **fail** `candidate-id`'s anchor (only one optional TAB group, `:321`) and drop every line from the chooser.
29. `new` → argv: `malebolge--attach-arguments` `emacs/malebolge.el:255-260` (`nil`→`("--emacs")`, `"new"`→`("--new" "--emacs")`, else `("--conversation" id "--emacs")`); used by `malebolge--start-transcript` (`:390+`), chosen target from `malebolge-attach` `:423-430`.
30. There is **no** `--topics` reader in Emacs: `grep -c topics emacs/malebolge.el` = 0; the only listing is `malebolge--list-conversations` running `--list` (`:268-301`). A "set a topic's model" command needs both a `--topics` invocation and a `--set-topic` caller.
31. Carrying each id's topic: extend `ConversationsMessage` additively (DEC-007 pattern already used for `marks`, `src/protocol.ts:95-96`, `src/daemon.ts:196-197`), fill it in `marksOf`'s neighbourhood from `index.conversations[id].topic` (`src/conversations.ts:98-108`), render a further TAB field in `lineOf` (`src/render.ts:317`), and widen `malebolge--candidate-id` to allow a second optional TAB group (`emacs/malebolge.el:321`). Note `--list` also feeds `malebolge--candidate-id` from `--conversation` argv, so the parse change is shared.

**Q6 — CLI flags**

32. `AttachArgs` `src/attach-invocation.ts:29-43`, `OPTIONS` `:46-60` (`"set-topic"`, `toolset`, `"no-toolset"`), parse `:63-102`, `flagsOf` `:105-121`.
33. `checkAlone(subject, allowed, given)` `src/attach-invocation.ts:127-138`; `set-topic` allows `["dir","no-dir","here","toolset","no-toolset"]` `:324`; `topics` allows nothing `:319-321`; `list` allows `["topic","here"]` `:335`; `checkHereAlone` allows `toolset`/`no-toolset` beside `here` `:361-370`.
34. Three-case write helper `writeOf(value, clear, name)` `src/attach-invocation.ts:295-303` → `${name} and no-${name} are exclusive` `:297`; `directoryOf` `:306-307`, `toolsetOf` `:310-311`. `requireSetTopic` refuses `--toolset`/`--no-toolset` without `--set-topic` (`toolset needs set-topic`) `:250-257`.
35. `SetTopicInvocation` `src/attach-invocation.ts:195-203`; frame built in `requestFrameOf`'s `set-topic` case `src/request.ts:126-136`; skew keys `["topic","topics","toolset"]` `src/request.ts:93`.
36. Naming precedent for `--model`/`--no-model`: mirror `toolset`/`no-toolset` exactly — `AttachArgs.model`/`noModel`, `OPTIONS.model`/`"no-model"`, `flagsOf` entry, add to `set-topic`'s `allowed`, add to `requireSetTopic` (`model needs set-topic`), `modelOf = writeOf(model, noModel, "model")`, `SetTopicInvocation.model`, and the `requestFrameOf` key. Usage string: `src/attach-main.ts:18-22`.

**Q7 — existing tests**

37. Topic record/keys: `test/topics.test.ts:242` "sets, clears and leaves a topic's toolset…", `:229` listing with toolset, `:216` topics list, `:282` reserved `default`, `:290` merge keeps a later key.
38. `setTopic` validation and defaults: `test/conversations.test.ts:590` create/leave, `:600` dir set/clear, `:609` "refuses a toolset the … profile's policy does not allow, writing nothing", `:628` stores an allowed toolset, `:681` topics listing, `:693` toolset round-trip after reopen; `DEFAULTS = { model: FAUX_MODEL, cwd: "/daemon-default" }` `test/conversations.test.ts:78`.
39. Daemon wire: `test/daemon.test.ts:929` "creates a topic idempotently, sets its directory, and clears it (EX-5)" (the template for a model-frame test), `:752` list reply, `:806` marks passthrough, `:816` shipped list shape (`Object.keys(...)` — a new key must be added there), `:772` first-line frames refused when bound.
40. CLI: `test/attach-invocation.test.ts:119-172` the big `it.each` invocation table (toolset rows at `:145-165`), `:173-194` `--toolset` refusal `it.each`, `:201+` `checkAlone` exclusivity, `:382-430` `--set-topic --here` keeps the toolset (VT-2 analogue).
41. Models: `test/models.test.ts:83` catalog parse, `:88` models offered under provider `gateway`, `:200-224` `loadGatewayModels`; `requireKnownModel` has **no** direct test (no `unknown model` string in `test/`); `parseModel` only exercised indirectly via `test/config.test.ts:93,110`.
42. Threads: `test/threads-fork.test.ts:309`; topic/fork inheritance `test/topics.test.ts:83,94`; start admission in `test/threads-admission.test.ts`.
43. Emacs: ERT `test/malebolge-ert.el:743` (`attach-arguments` per target), `:758` numeric-only candidates, `:768` marked lines whole + malformed rejected, `:783` prompt offers `("9" "7" "new")`; stub plumbing `malebolge-test--with-target-choice` `:705-712`, `malebolge-test--offered` `:699`; smoke `test/emacs-attach-smoke.ts:134-160` (fake `list` reply `LISTED`), `:489-520` targeted attach (`--conversation CHOSEN` argv + frames).
44. Reusable fixtures: `test/harness-fixture.ts:41` `FAUX_MODEL`, `:52` `fauxModels`, `:188` `indexOf`, `:231` `createConversation`, `:267` `startThread`, `:370` `serveTest`; `test/conversations.test.ts:100-140` `catalogOf`/`openRoomStore`; `test/gateway-catalog.json` (only `deepseek-flash`).

### Naming precedents

`TopicRecord`/`TopicChange`/`NamedTopic`; `KEYS`/`written`/`without`/`merged`; `toolsetChange` → a `modelChange`; `requireAllowed` → a `requireKnownModel` used the same way; `toolsetInit`, `writeCreated`, `topicCwd`; `--toolset`/`--no-toolset` → `--model`/`--no-model`; `toolsetOf`/`directoryOf` → `modelOf`; `SetTopicInvocation.toolset`; `TopicSummary.toolset` and the positional TAB field in `render.ts`; `marks` as the additive-key precedent for a per-id map (`marksOf`, `pageOf`); `malebolge--candidate-id`, `malebolge--conversation-candidates`.

### Surprises / risks

- **The model-ref provider is `gateway`, not `llm-gateway`.** `GATEWAY_PROVIDER = "gateway"` (`src/models.ts:30`) is stamped onto every catalog model (`src/models.ts:108`) and the catalog's own provider key (`llm-gateway` in `.doctrine/state/slice/010/gateway-models.json`) is discarded (`src/models.ts:126-134`). So `llm-gateway/openai-david/gpt-6.1-terra` parses but fails `requireKnownModel` (`src/daemon-start.ts:55-61`); the working ref is `gateway/openai-david/gpt-6.1-terra`. (`DEFAULT_MODEL` agrees: `src/models.ts:37`.)
- `parseModel` splits on the **first** slash, so a slashed modelId is preserved as `modelId` — the format is safe, but only with the `gateway/` prefix.
- **`Models` is not reachable from the frame handlers** (fact 13): validation at write time needs threading through `conversations(...)` (`src/daemon-start.ts:255`) — a constructor-signature change, touching `test/conversations.test.ts`'s ~30 `conversations(session, DEFAULTS, profile)` calls.
- `written`'s value type is `string | null | undefined` (`src/topics.ts:223`): storing a parsed `ModelRef` in `TopicRecord` would need that widened; storing the ref **string** does not.
- **OQ-2 is already answered by code**: `default` can never carry a model — `writeTopicRecord` throws (`src/topics.ts:251-254`) and the frame parser refuses it (`src/protocol.ts:326-328`).
- `marks` is only absent-when-empty; adding a per-id `topics` map changes the pinned shape test `test/daemon.test.ts:816` and the renderer tests (`test/render.test.ts:218-251`).
- `malebolge--candidate-id`'s regex admits at most one TAB group (`emacs/malebolge.el:321`), so a third field silently empties the chooser; and Emacs has **no** `--topics` invocation at all.
- `ConversationDefaults` is *not* re-applied to non-root conversations on open (only root, `src/session.ts:199`), which is exactly what makes "topic model applies to new conversations only" cheap — but `thread_start` passes `{...deps.defaults, cwd}` (`src/threads/tools.ts:169`) and will silently keep the daemon default unless that path is changed too (OQ-3).
- `requireKnownModel` is untested today; a topic-write model check would be its first real test surface, and `test/gateway-catalog.json` holds no slashed id, so a fixture with one is needed.
- `checkAlone`/`flagsOf` are hand-maintained maps (`src/attach-invocation.ts:105-121`, `:324`): forgetting `"model"` in `set-topic`'s `allowed` yields a confusing `set-topic and model are exclusive`.
