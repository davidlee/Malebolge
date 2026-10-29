<!-- doctrine:section sec-1 -->
## 1. Overview

A topic gains a model, a ref string such as `gateway/openai-david/gpt-6.1-terra`.
It is judged against the gateway catalog when written and when used, and
applied to conversations created afterwards (DEC-025's rule, extended). Root
and plain `new` keep the daemon default (`MALEBOLGE_MODEL`); `default` carries
no model (DEC-015). The Emacs chooser shows each conversation's topic and
model, and `new` asks for a topic. Scope: `slice-010.md`. Evidence:
`research/research.md`.

```
 startDaemon ── loadGatewayModels ──► catalog: ModelCatalog { require, refs }
      │                                   │
      ├──► conversations(session, defaults, profile, catalog)
      │       setTopic ── modelChange ── catalog.require          (write-time)
      │       create / openTopic ── topicInit ─┐
      │       list ── summaries {topic, model} │
      ├──► threads deps { …, catalog }         │
      │       createStarted ── topicInit ──────┤
      │                                        ▼
      │                 creationModel({ topic?, fallback }, catalog.require)
      │                 → configure(tx, id, { model })      (creating commit)
      └──► serve({ …, modelRefs: catalog.refs })   list {models:true} → models reply
```

<!-- doctrine:section sec-2 -->
## 2. The model catalog port (DEC-082, DEC-088)

`src/models.ts` gains:

```ts
/** What conversation code knows of the gateway catalog. */
export interface ModelCatalog {
  /** The ref parsed, or an `UnknownModel` naming it: `unknown model <ref>`. */
  require(ref: string): ModelRef;
  /** Every chat model's ref, `provider/modelId`, sorted. */
  refs(): string[];
}
export function modelCatalog(models: Models): ModelCatalog;
export function refOf(model: ModelRef): string; // provider/modelId, parseModel's inverse
```

- `require` is today's `requireKnownModel` (`src/daemon-start.ts:55`), moved
  and taking a string: `parseModel`, then `getModelOfType("chat", …)`.
  Either refusal, an unparseable ref (no slash) or one the catalog lacks,
  throws `UnknownModel` naming the ref, so one class covers both.
  `UnknownModel` is a new `Error` subclass in `src/models.ts`, as other
  modules keep theirs (e.g. `FrameRefused`, `src/protocol.ts:117`).
- `refs` enumerates the chat models (pi-ai `Models.getModelsOfType("chat")`;
  confirm the name at phase-plan).
- `startDaemon` builds one catalog from `modelsFor`'s result. Its start check
  of `MALEBOLGE_MODEL` becomes `catalog.require(refOf(config.model))`, so
  there is one checker; `modelsFor` keeps returning `Models` for
  `openBoundSession`.
- This refines DEC-082: the "one requireModel function" is the `require`
  method of a two-method port, because DEC-088 needs the refs from the same
  source. Tests stub the port with a literal object.

<!-- doctrine:section sec-3 -->
## 3. Topic model: store, wire, CLI (DEC-086)

Mirrors toolset at every step.

| layer | change |
|---|---|
| store `src/topics.ts` | `TopicRecord.model?: string`; `TopicChange.model?: string \| null`; `KEYS = ["cwd", "toolset", "model"]` — the generic `merged`/`written`/`without` need no change (value is a string) |
| judge `src/conversations.ts` | `modelChange(write, catalog)` beside `toolsetChange`: absent/null pass through, a string must pass `catalog.require` and is stored as given; a refusal writes nothing |
| frame `src/protocol.ts` | `TopicMessage.model?: string \| null`, `TOPIC_KEYS` gains `model`, parsed by `topicField` (rejects control chars, as `--topics` is TAB-separated) |
| reply | `TopicSummary.model?: string`; `topicsOf` unchanged (it spreads the record) |
| CLI `src/attach-invocation.ts` | `--model REF`, `--no-model`; `modelOf = writeOf(model, noModel, "model")`; `set-topic`'s allowed set and `checkHereAlone` gain both; `requireSetTopic` refuses them without `--set-topic` (`model needs set-topic`); `SetTopicInvocation.model` |
| request `src/request.ts` | `requestFrameOf`'s set-topic case sends `model`; `SKEWED_KEYS` gains `model` and `models` |
| render `src/render.ts` | `--topics`: `name<TAB>cwd<TAB>toolset<TAB>model`, unset fields empty |
| usage `src/attach-main.ts` | names the two flags |

`default` stays refused by both the parser and `writeTopicRecord`.

<!-- doctrine:section sec-4 -->
## 4. Creation: creationModel and topicInit (DEC-083, DEC-084, DEC-085)

One pure function owns precedence and refusal:

```ts
/** Where a new conversation's model may come from, highest precedence first. */
export interface ModelSources {
  /** The topic's stored model, if it has one. */
  topic?: string;
  /** The daemon default. */
  fallback: ModelRef;
}
/** The model a new conversation takes; a source the catalog lacks is refused. */
export function creationModel(sources: ModelSources, require: ModelCatalog["require"]): ModelRef;
```

- `topic` set: `require(topic)`. It throws `unknown model <ref>` and the
  creating commit fails: nothing is created (DEC-083). No fallback.
- `topic` unset: `fallback`, already checked at start.
- Future: `requested?` (a `thread_start`/fork argument) slots above `topic`;
  a fallback-on-unknown policy changes only this function.

`writeCreated` returns the topic's record alongside the toolset it chose, so
the record is read once, in the creating commit. `toolsetInit` becomes
`topicInit(profile, topic, catalog, fallback, thread?)`, which after writing
the entry configures both:

```ts
await configure(tx, id, {
  extensions: selectionOf(toolsetList(toolset, profile)),
  model: creationModel({ topic: record?.model, fallback }, catalog.require),
});
```

pi-durable runs `init` after the `agent` change in the creating commit, so this
`model` overrides the defaults' model that `create` set.

| path | today | after |
|---|---|---|
| `attach --topic NAME` (empty topic), `--topic NAME --new` | defaults' model | topic's model, else default |
| plain `new` | default (topic `default`) | unchanged: `default` has no record |
| `thread_start` (`src/threads/tools.ts:169`) | defaults' model | topic's model, else default (amends DEC-034) |
| `thread_fork` | parent's agent copied by pi-durable | unchanged, no code; a test pins it |
| runner job conversations (`src/runner/conversations.ts`) | created with no model, configured from the runner's `policy.model` (`src/runner/run.ts:363`) | unchanged: not created through `topicInit` |
| root | defaults on every open | unchanged |
| heartbeat (`ensureHeartbeat`, wake topic, no conversation yet) | defaults' model | topic's model, else default; an unknown stored model logs `wake: no heartbeat: unknown model <ref> in topic <name>` and the start continues |

The heartbeat row is the one place a refusal does not fail its caller:
`startRoomTasks` (`src/daemon-start.ts:102`) catches `UnknownModel` only around
`ensureHeartbeat`, logs, and the daemon serves without a heartbeat (DEC-083:
the daemon still starts). Every other heartbeat failure still aborts the start.

<!-- doctrine:section sec-5 -->
## 5. Listing: summaries and models (DEC-087, DEC-088)

**Summaries.** `ConversationsMessage` gains
`summaries?: Record<string, ConversationSummary>` with
`ConversationSummary = { topic: string; model?: string }`. `ConversationPage`
carries it; `listReply` copies it, always present: it always sends the map
(`{}` for an empty page; additive under DEC-007). It is optional on the wire
only so a new client tolerates an old daemon; a new daemon always sends it.

- Filled in the listing commit: `topic` from the index entry, which every
  listed id has, `model` from `tx.doc(AgentDoc, id).model`
  through `refOf` (absent when unset).
- `scanPage` already reads the index in its commit; `topicPage` moves its read
  into one commit so the agent documents and the index describe the same
  moment. At most `LIST_PAGE` (50) agent reads per page.
- `marks` stays as is.

**`--list` lines.** `id<TAB>topic<TAB>model[<TAB>mark]`: topic and model always
present (empty when unknown, including against a daemon without `summaries`),
the mark only for threads. Root's line names `default`. One `lineOf` builds
it.

**Models.** `ListQuery` gains `{ kind: "models" }`, asked by
`{"type":"list","models":true}`; `topic`, `topics` and `models` are mutually
exclusive in `listQuery`. `--models` stands alone (`checkAlone`), and prints
one ref per line. An old daemon refuses `models` as an unknown key → the
restart hint (`SKEWED_KEYS`).

- Daemon: answers `{ type: "models", models: string[] }`.
  `ServeOptions.modelRefs: () => string[]` (the catalog's `refs`) is copied
  onto `Connection` as `orientation` is, a function field; the first-line
  table's `list` row (DEC-016) answers `{kind:"models"}` from
  `state.modelRefs()` before reaching `Conversations`. `answer`'s reply union
  gains `ModelsMessage`. `PageQuery` excludes `models` as well as `topics`, so
  `Conversations.list` never sees it.
- Client: `ReplyMessage` gains `ModelsMessage`; `requestFrameOf` gains a
  `models` case; `replyTypeOf` maps `list`→`conversations`, `models`→`models`,
  else `topics`.

<!-- doctrine:section sec-6 -->
## 6. Emacs (DEC-089, DEC-091)

- **One bounded client call.** `malebolge--list-conversations` becomes
  `malebolge--client (args)`, returning `(:stdout :stderr)` for any argv under
  `malebolge--list-timeout`. All four calls (`--list`, `--topics`, `--models`,
  `--set-topic …`) use it. It signals a verb-neutral `user-error` naming the
  args on a non-zero exit (with the client's output) and on timeout (saying the
  outcome is unknown; no retry), so callers check nothing.
- **Chooser lines.** `malebolge--candidate-id` accepts
  `ID<TAB>TOPIC<TAB>MODEL` with an optional `<TAB>MARK`; topic and model may be
  empty, a mark may not. Lines are offered whole, as today.
- **`new` asks for a topic.** After choosing `new`: `completing-read "Topic: "`
  over the names from `--topics`, `require-match`, default `default`. Topics
  are created with `--set-topic`; attach never creates one (DEC-016).
  `default` → `--new --emacs`; a name → `--topic NAME --new --emacs`. The
  attach target grows a `(new . TOPIC)` shape so `malebolge--attach-arguments`
  stays the one argv builder. `malebolge--target-label` reads `(new . TOPIC)`
  as `a new conversation in TOPIC`.
- **`malebolge-set-topic-model`.** Interactive: a topic name (from `--topics`,
  excluding `default`, require-match), then a model completed from `--models`
  plus `none`. Runs `--set-topic NAME --model REF` (or `--no-model`) through
  `malebolge--client`; success → a message naming topic and model.

<!-- doctrine:section sec-7 -->
## 7. Code impact

| path | change |
|---|---|
| `src/models.ts` | `ModelCatalog`, `modelCatalog`, `UnknownModel`, `refOf`, `ModelSources`, `creationModel` |
| `src/daemon-start.ts` | build the catalog; start check through it; pass to `conversations`, thread deps, `serve`; the heartbeat call catches `UnknownModel` and logs |
| `src/topics.ts` | `model` in `TopicRecord`/`TopicChange`/`KEYS`; `writeCreated` returns the record |
| `src/conversations.ts` | `modelChange`; `topicInit` (from `toolsetInit`); `conversations(…, catalog)`; summaries in `scanPage`/`topicPage`; `PageQuery`; `TopicWrite.model?: string \| null` |
| `src/threads/tools.ts`, `src/threads/extension.ts` | `createStarted` through `topicInit`; deps carry the catalog |
| `src/protocol.ts` | `TopicMessage`/`TopicSummary.model`, `ConversationSummary`, `summaries`, `models` query and reply |
| `src/daemon.ts` | `listReply` summaries; models reply; `ServeOptions.modelRefs`, `Connection.modelRefs`, `answer` union |
| `src/attach-invocation.ts`, `src/attach-main.ts` | `--model`, `--no-model`, `--models`; a `models` mode in `RequestInvocation` and its exhaustive switches (`hereOf`, …) |
| `src/request.ts` | `ReplyMessage`, `requestFrameOf`, `replyTypeOf`; `SKEWED_KEYS` gains `model` and `models` |
| `src/render.ts` | `--list` and `--topics` lines; models lines |
| `emacs/malebolge.el` | `malebolge--client`, candidate regex, topic on `new`, `malebolge-set-topic-model`, `malebolge--target-label` |
| tests | `test/models.test.ts`, `topics.test.ts`, `conversations.test.ts`, `daemon.test.ts`, `request.test.ts`, `attach-invocation.test.ts`, `render.test.ts`, `threads-*.test.ts`, `malebolge-ert.el`, `emacs-attach-smoke.ts`; a catalog fixture with a slashed id |

Sequencing with SL-009: SL-010 lands first. `topicInit` is the creation seam
SL-009's `pair` calls; SL-009 then splits its `thread` hook and moves `answer`
with the `models` reply (SL-009 follow-ups, ISS-004).

<!-- doctrine:section sec-8 -->
## 8. Verification

- **VT, catalog:** `require` accepts a known slashed ref, refuses an unknown or
  unparseable one with `UnknownModel` naming it; `refs` lists chat models;
  `refOf(parseModel(r)) === r` for a slashed id.
- **VT, creationModel:** topic set and known → it; set and unknown → throws
  `UnknownModel`;
  unset → fallback.
- **VT, topic write:** set, clear, unchanged round-trip through store, wire and
  reopen; an unknown model is refused and nothing is written; `default` refused;
  `model` with a control character is refused by the frame parser.
- **VT, creation:** `--topic` and `--topic --new` in a topic with a model carry
  it; without one, the default; a stored model the catalog lacks refuses
  creation and creates nothing; an existing conversation keeps its model after
  the topic changes; a started thread takes its topic's model; a fork keeps
  its parent's; root keeps the default; a wake topic with an unknown stored
  model and no conversation: the daemon starts, logs, creates no heartbeat
  (`test/daemon-start.test.ts` VT-3 f stays: other heartbeat failures still
  fail the start).
- **VT, listing:** summaries carry topic and model for both `all` and `topic`
  pages; `--list` and `--topics` line shapes; `--models` output; flag
  exclusivity; old-daemon skew hint for `model` and `models`; a `--models`
  request accepts the models reply. The pinned reply-shape test
  (`test/daemon.test.ts`, EX-4) widens to include `summaries`, deliberately;
  `--list` against a reply without `summaries` prints empty topic and model
  fields.
- **VT, Emacs (ERT + smoke):** candidate parsing of the new line shape;
  `new` with a topic builds `--topic NAME --new`; `default` builds `--new`;
  set-topic-model argv and refusal path; set-topic-model offers `--models`
  lines plus `none`; set-topic-model against a client that never exits
  signals within the bound.
- **VH:** set a topic to `gateway/openai-david/gpt-6.1-terra` from Emacs, create a
  conversation in it from the chooser, see the model on its chooser line and a
  reply from that model.

