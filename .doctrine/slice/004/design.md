<!-- doctrine:section sec-1 -->
## Purpose and boundary

Each conversation's tools and system prompt learn which conversation they
belong to. The room's `~/db/q` (a bash frontend to satan's psql memory) builds
its `mem.origin` row from `SATAN_*` environment variables, and `q spawn` pulls
memory for the current thread and topic. One daemon runs many conversations in
one process, so the values are set per conversation, where each execution
environment is built — never on the daemon's process.

```
EnvTarget{conversationId, cwd, read}          PromptInput{conversationId, read}
        │                                               │
        └──────► contextOf(read, id) ◄──────────────────┘   one index read (DEC-018)
                        │ {id, entry?}
          ┌─────────────┴──────────────┐
  conversationVars(...)          conversationLine(...)
          │ shellEnv (DEC-020)         │ section `conversation` (DEC-019)
  NodeExecutionEnv / RemoteExecutionEnv      system prompt
```

Out of scope (scope Non-Goals): `~/db/q` and its SQL; the "run `q spawn`"
reminder in `~/satan-corpus/prompts/env/room.txt` (satan's corpus); other
harnesses' variables; task-owned conversations (IDE-002); the runner's
patch-job env (`src/runner/tenancy.ts:35`); satan's MCP tools
(`src/satan-tools.ts`), which run no command, so `q`'s attribution never
reaches them (RV-012 F-8).

<!-- doctrine:section sec-2 -->
## The variables

The contract `~/db/q` reads (as pasted by the user, 2026-10-24). `q` reads
each as `${VAR:-}` and stores `nullif(…, '')`, so an empty value is NULL in
`mem.origin`: an honest gap, never a guess. All six are always set; a missing
value is the empty string (DEC-021).

| variable | value | empty when |
|---|---|---|
| `SATAN_HARNESS` | `malebolge` | never |
| `SATAN_PROFILE` | the daemon's `config.execution.profile`: `host` or `room` | never |
| `SATAN_CONVERSATION` | the conversation id, decimal | never |
| `SATAN_CWD` | the conversation's working directory: `target.cwd ??` the env's default (launch dir or room home) (DEC-022) | never |
| `SATAN_TOPIC` | the index entry's `topic` | no index entry (task-owned, DEC-012) |
| `SATAN_PARENT_CONVERSATION` | the index entry's `parent`, decimal | not a fork, or no entry |

Root always has an entry in `default` (DEC-015), so a miss means a task-owned
conversation, which malebolge does not create today.

**Masking (RV-012 F-1).** Both envs merge the daemon's inherited environment
under `shellEnv`: host `{...process.env, ...shellEnv, ...options.env}`
(`pi-durable/dist/env/node.js:205-212`), room the pi-env daemon's environment,
started through the room user's login shell (`pi-env/dist/ssh.js:421`). pi-env
drops `undefined` values (`remote-env.js:767-769`), so only a value can
override an inherited one. Setting all six, empty when absent, overrides any
inherited `SATAN_*` of these names on both profiles, and `shellEnv` is one
`Record<string, string>` for both. A comment at `conversationVars` says why no key may be omitted: dropping empty ones would reopen RV-012 F-1 in the room.

The six names live once, in `conversation-context.ts`. The daemon also reads
other `SATAN_*` variables of its own (`SATAN_CORPUS_ROOT`, `SATAN_MCP_SOCKET`,
`src/config.ts:144,147`); those are daemon configuration, disjoint from the
six, and inherited by tools as today (RV-012 F-2).

<!-- doctrine:section sec-3 -->
## Tool environment

`SessionOptions.env` (`src/session.ts:28`) widens from `(state: {cwd?}) =>
ExecutionEnv` to pi-durable's own hook type, `(target: EnvTarget) =>
Promise<ExecutionEnv>` (`harness/types.d.ts:566`, async allowed).

`daemonEnv` (`src/daemon-env.ts`) already holds the execution, hence the
profile. Both arms resolve one shared step, then build their env with
`shellEnv` (DEC-020):

```ts
// daemon-env.ts
async function conversationEnv(profile, defaultCwd, target) {
  const cwd = target.cwd ?? defaultCwd;
  const vars = conversationVars(profile, cwd, await contextOf(target.read, target.conversationId));
  return { cwd, vars };
}
// host
env: async (target) => { const { cwd, vars } = await conversationEnv("host", launchDir, target);
                         return new NodeExecutionEnv({ cwd, shellEnv: vars }); }
// room
env: async (target) => { const { cwd, vars } = await conversationEnv("room", home, target);
                         return observedEnv(connection, observer, { id: "pi-env:daemon-room", cwd, reword, shellEnv: vars }); }
```

- `observedEnv` (`src/room/connection.ts:178`) gains optional `shellEnv`,
  passed to `RemoteExecutionEnv`. The env id stays `pi-env:daemon-room` for
  every conversation (RFC-002). The id names the file namespace — "equal ids
  see the same files at the same paths, whatever their cwd"
  (`pi-durable/dist/env/index.d.ts:166`) — which per-conversation variables do
  not change (RV-012 F-4).
- pi-durable's bash tool execs with `{env: {}, inheritEnv: true}`
  (`tools/bash.js:36-37`), so every bash call inherits `shellEnv`; a caller's
  explicit per-exec `env` still wins in both merges.
- Cost (RV-012 F-3): one index snapshot read per env build. pi-durable builds
  an env per task attempt and per nested `executeTool` (`harness/scheduler.js:1984`,
  `harness/tool.js:309`), and already reads the agent document at each build;
  this adds one more in-process document read. No memoisation unless measured.

<!-- doctrine:section sec-4 -->
## System prompt

A new extension `conversationExtension`, one untagged section `conversation`
(DEC-019), registered in `daemonExtensions` right after `cwdExtension`
(`src/daemon-extensions.ts:24-31`):

```
Conversation: 12 (topic: satan-db)
Conversation: 12                      ← no index entry
```

It renders from `PromptInput.conversationId` and `PromptInput.read` through
the same `contextOf` (`harness/types.d.ts:277-287`). The text is stable within
a conversation: a conversation's topic never changes after creation (SL-003
objectives 3–4; no verb moves a conversation between topics), so the section
costs no prompt-cache churn beyond `cwd`'s: pi-durable re-sends a section
only when its text differs from `shown` (`harness/prompt.js:100-104`).

Section keys share one namespace across extensions, duplicates last-wins
(`harness/prompt.js:100-104`). No other extension declares `conversation`
(RV-012 F-6).

The "run `~/db/q spawn` at session start" reminder belongs in the room's
environment prompt (`~/satan-corpus/prompts/env/room.txt`), owned by satan; it
can name `$SATAN_CONVERSATION` and `$SATAN_TOPIC` knowing they are set.

<!-- doctrine:section sec-5 -->
## Code impact

| file | change |
|---|---|
| `src/conversation-context.ts` (new) | `ConversationContext {id, entry?}`; `contextOf(read, id)` — the one index read, an own-key lookup over `readIndex`; pure `conversationVars(profile, cwd, context)` — all six names, empty when absent; `conversationLine(context)`; `conversationExtension` |
| `src/session.ts` | `SessionOptions.env` takes `EnvTarget`, may be async |
| `src/daemon-env.ts` | `DaemonEnv.env` takes `EnvTarget`; host and room arms share `conversationEnv` and pass `shellEnv` |
| `src/room/connection.ts` | `observedEnv` passes an optional `shellEnv` to `RemoteExecutionEnv` |
| `src/daemon-extensions.ts` | `conversationExtension` after `cwdExtension` |
| `test/conversation-context.test.ts` (new) | the mapping table; `contextOf` on an indexed, a forked and an unindexed conversation |
| `test/daemon-env.test.ts` | host: a bash exec sees its own conversation's variables, overrides an inherited `SATAN_TOPIC` with empty; room: `RemoteExecutionEnv` gets the `shellEnv` and keeps its id |
| `test/harness-fixture.ts` | `openTestHarness`'s hook (`:66`) takes `EnvTarget` and can build the daemon's env, so VT-3 runs through the real `daemonEnv` (RV-012 F-9) |
| `test/daemon-sections.test.ts` | the `conversation` section, its order after `cwd`, with and without a topic |
| `README.md` / `docs/internals.md` | the variable table, if those docs list the daemon's prompt sections or env |

- `src/topics.ts` stays the index's only owner; `conversation-context.ts`
  reads through `readIndex` only.
- `src/runner/` untouched.

<!-- doctrine:section sec-6 -->
## Verification

| criterion | how |
|---|---|
| VT-1. `conversationVars` always gives all six: a fork's parent; empty parent for a non-fork; empty topic and parent with no entry; ids decimal; `SATAN_HARNESS=malebolge`; profile as given | VT, `test/conversation-context.test.ts`, a table |
| VT-2. `contextOf` reads root in `default`, a fork's parent, and no entry for an unindexed id | VT, same file, over `openTestHarness` (hook installed) |
| VT-3. Host: a bash tool call in conversation A prints A's `SATAN_*`, in B prints B's; an inherited `SATAN_TOPIC` in the daemon's environment is overridden with empty for an unindexed conversation (the command prints `[${SATAN_TOPIC}]`, asserted `[]`, so empty is distinguished from absent); a per-exec `env` wins | VT, `test/daemon-env.test.ts` with `callThenAnswer` + `toolResults` (`test/harness-fixture.ts`) |
| VT-4. Room: `observedEnv` builds `RemoteExecutionEnv` with the given `shellEnv` and id `pi-env:daemon-room` | VT, `test/daemon-env.test.ts`, existing room fixture |
| VT-5. The `conversation` section renders `Conversation: <id> (topic: <t>)`, untagged, right after `cwd` | VT, `test/daemon-sections.test.ts` via `systemPromptSections` |
| VH-1. In the room, from a malebolge conversation: `env \| grep SATAN_` shows all six with this conversation's values; `~/db/q who` shows a `mem.origin` row with them | VH, user at the terminal |

`just check` green, lint clean, at every phase end.

