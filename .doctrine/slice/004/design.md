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
patch-job env (`src/runner/tenancy.ts:35`).

<!-- doctrine:section sec-2 -->
## The variables

The contract `~/db/q` reads (as pasted by the user, 2026-10-24). Unset means
NULL in `mem.origin`: an honest gap, never a guess (DEC-021).

| variable | value | unset when |
|---|---|---|
| `SATAN_HARNESS` | `malebolge` | never |
| `SATAN_PROFILE` | the daemon's `config.execution.profile`: `host` or `room` | never |
| `SATAN_CONVERSATION` | the conversation id, decimal | never |
| `SATAN_CWD` | `target.cwd ?? ` the env's default cwd (launch dir or room home) — where tools run (DEC-022) | never |
| `SATAN_TOPIC` | the index entry's `topic` | no index entry (task-owned, DEC-012) |
| `SATAN_PARENT_CONVERSATION` | the index entry's `parent`, decimal | not a fork, or no entry |

Root always has an entry in `default` (DEC-015), so a miss means a task-owned
conversation, which malebolge does not create today.

**Masking.** On the host, `NodeExecutionEnv` merges `{...process.env,
...shellEnv, ...options.env}` (`pi-durable/dist/env/node.js:205-212`). A daemon
launched from a shell that already carries, say, `SATAN_TOPIC` would leak it
into a conversation that has none. So `conversationVars` returns all six keys,
an absent value as `undefined`; Node's spawn drops undefined values, so the
inherited one is masked. pi-env's remote env drops undefined values too
(`remote-env.js:767-769`) but types `shellEnv` as `Record<string, string>`, so
the room path passes only the defined keys; the room's pi-env daemon starts
without `SATAN_*` (assumption, checked by VH-1).

`SATAN_*` names live once, in `conversation-context.ts`.

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
                         return observedEnv(connection, observer, { id: "pi-env:daemon-room", cwd, reword, shellEnv: defined(vars) }); }
```

- `observedEnv` (`src/room/connection.ts:177`) gains optional `shellEnv`,
  passed to `RemoteExecutionEnv`. The env id stays `pi-env:daemon-room` for
  every conversation (RFC-002: pi-durable serialises writes by env id).
- pi-durable's bash tool execs with `{env: {}, inheritEnv: true}`
  (`tools/bash.js:36-37`), so every bash call inherits `shellEnv`; a caller's
  explicit per-exec `env` still wins in both merges.
- Cost: one index snapshot read per env build. The hook already builds a new
  env per use; the read is one in-process document.

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
costs no prompt-cache churn beyond `cwd`'s.

The "run `~/db/q spawn` at session start" reminder belongs in the room's
environment prompt (`~/satan-corpus/prompts/env/room.txt`), owned by satan; it
can name `$SATAN_CONVERSATION` and `$SATAN_TOPIC` knowing they are set.

<!-- doctrine:section sec-5 -->
## Code impact

| file | change |
|---|---|
| `src/conversation-context.ts` (new) | `ConversationContext {id, entry?}`; `contextOf(read, id)` — the one index read, an own-key lookup over `readIndex`; pure `conversationVars(profile, cwd, context)` — the six names, undefined when absent; `conversationLine(context)`; `conversationExtension` |
| `src/session.ts` | `SessionOptions.env` takes `EnvTarget`, may be async |
| `src/daemon-env.ts` | `DaemonEnv.env` takes `EnvTarget`; host and room arms share `conversationEnv` and pass `shellEnv` |
| `src/room/connection.ts` | `observedEnv` passes an optional `shellEnv` to `RemoteExecutionEnv` |
| `src/daemon-extensions.ts` | `conversationExtension` after `cwdExtension` |
| `test/conversation-context.test.ts` (new) | the mapping table; `contextOf` on an indexed, a forked and an unindexed conversation |
| `test/daemon-env.test.ts` | host: a bash exec sees its own conversation's variables, masks an inherited `SATAN_TOPIC`; room: `RemoteExecutionEnv` gets the `shellEnv` and keeps its id |
| `test/daemon-sections.test.ts` | the `conversation` section, its order after `cwd`, with and without a topic |
| `README.md` / `docs/internals.md` | the variable table, if those docs list the daemon's prompt sections or env |

- `src/topics.ts` stays the index's only owner; `conversation-context.ts`
  reads through `readIndex` only.
- `src/runner/` untouched.

<!-- doctrine:section sec-6 -->
## Verification

| criterion | how |
|---|---|
| VT-1. `conversationVars` gives all six for a fork; parent undefined for a non-fork; topic and parent undefined with no entry; ids decimal; `SATAN_HARNESS=malebolge`; profile as given | VT, `test/conversation-context.test.ts`, a table |
| VT-2. `contextOf` reads root in `default`, a fork's parent, and no entry for an unindexed id | VT, same file, over `openTestHarness` (hook installed) |
| VT-3. Host: a bash tool call in conversation A prints A's `SATAN_*`, in B prints B's; an inherited `SATAN_TOPIC` in the daemon's environment is masked for an unindexed conversation; a per-exec `env` wins | VT, `test/daemon-env.test.ts` with `callThenAnswer` + `toolResults` (`test/harness-fixture.ts`) |
| VT-4. Room: `observedEnv` builds `RemoteExecutionEnv` with the given `shellEnv` and id `pi-env:daemon-room` | VT, `test/daemon-env.test.ts`, existing room fixture |
| VT-5. The `conversation` section renders `Conversation: <id> (topic: <t>)`, untagged, right after `cwd` | VT, `test/daemon-sections.test.ts` via `systemPromptSections` |
| VH-1. In the room, from a malebolge conversation: `env \| grep SATAN_` shows all set values; `~/db/q who` shows a `mem.origin` row with them | VH, user at the terminal |

`just check` green, lint clean, at every phase end.

