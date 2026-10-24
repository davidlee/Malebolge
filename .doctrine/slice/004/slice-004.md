# Conversation context in the tool environment and system prompt

## Context

All paths are in this repo unless stated.

The room hosts satan's own psql database and a bash frontend to it,
`~/db/q` (in the room user's home; not readable from the host). `~/db/q
spawn` pulls memory relevant to the current conversation thread and topic,
plus satan's current enthusiasms. Its writes attribute each row to an origin
(`mem.origin_upsert`) built from environment variables, so every command the
agent's tools run must carry them. An unset variable is stored as NULL ("an
honest gap, not a guess"); an unset `SATAN_HARNESS` defaults to `pi-durable`
(`~/db/q` as pasted by the user, 2026-10-24).

One daemon runs many conversations in one Node process, so process
environment cannot carry per-conversation values. They must be set per exec,
per conversation.

Evidence (checked 2026-10-24, pi-durable 1.4.0, pi-env as pinned):

- pi-durable's `HarnessOptions.env` hook receives `EnvTarget {conversationId,
  cwd, read}` (`node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts:541`).
  `src/session.ts:28` types it as `(state: {cwd?}) => ExecutionEnv`, so the id
  and the document reader are unused today.
- The reader opens SL-003's index document: `IndexEntry {topic, parent?}`
  (`src/topics.ts:32`).
- `ExecutionEnv.exec` takes `ShellExecOptions.env`, merged over the inherited
  environment by both `NodeExecutionEnv` (host) and pi-env's remote env
  (room, `pi-env/dist/remote-env.js:767`).
- A prompt section's `render` receives `PromptInput {conversationId, agent,
  read, …}`. `src/cwd.ts` already renders the conversation's cwd this way.

## Scope & Objectives

1. **Variables.** One pure function maps a conversation's context to:

   | variable | value |
   |---|---|
   | `SATAN_HARNESS` | `malebolge` (enum, shared with other harnesses: `gptel`, `pi`, `jailed-pi`) |
   | `SATAN_PROFILE` | the daemon's execution profile: `host` or `room` (enum, open to e.g. `tick-agent`) |
   | `SATAN_CONVERSATION` | the conversation id |
   | `SATAN_TOPIC` | the conversation's topic from the index |
   | `SATAN_CWD` | the conversation's agent cwd (not the daemon's) |
   | `SATAN_PARENT_CONVERSATION` | the parent conversation id; unset when not a fork |

2. **Tool environment.** Every exec a conversation's tools make carries those
   variables, on both profiles: passed as `shellEnv` where `daemonEnv` builds
   each env (research X-1). An explicit `options.env` from the caller wins.
3. **System prompt.** A prompt section states the conversation id and topic,
   so the model can name its thread without running a command.

```
EnvTarget{conversationId, cwd, read} ─┬─ index → {topic, parent}
                                       ▼
                             conversationVars(...)   (pure)
                                ├─► shellEnv      → tool processes (host, room)
                                └─► prompt section → system prompt
```

## Non-Goals

- `~/db/q` itself, its SQL, and the "run `~/db/q spawn`" reminder text in the
  room's environment prompt (`~/satan-corpus/prompts/env/room.txt`): corpus
  and room content, owned by satan.
- The variables in other harnesses (gptel, pi, jailed-pi): each sets its own.
  This slice fixes the names and enum values malebolge emits.
- Labels, titles, archiving (SL-003 non-goal D4).
- Task-owned conversations' owner and task variables (IDE-002).

## Affected surface

- `src/session.ts` — the env hook's type widens to `EnvTarget`.
- `src/daemon-env.ts`, `src/room/connection.ts` — host and room envs take `shellEnv`.
- A new module for the variables; `src/cwd.ts` or a sibling
  for the prompt section.
- `src/topics.ts` — read-only use of the index.
- Tests under `test/`.

## Risks, assumptions, open questions

- **A-1.** The env hook is called at each use, so the topic read there is
  current. Topic is fixed at creation (SL-003), so staleness is moot.
- **Q-1 (settled, DEC-019).** A separate untagged `conversation` section
  after `cwd`.
- **Q-2 (settled, DEC-021).** Index miss: leave `SATAN_TOPIC` unset, never
  guess `default` — `q` stores unset as NULL, by design.
- **Q-3 (settled, user 2026-10-24).** The parent variable is
  `SATAN_PARENT_CONVERSATION`, the name `q` reads.
- **R-1.** System prompt text varies per conversation but is stable within
  one, so no prompt-cache cost beyond today's cwd section.

## Verification / closure intent

- Unit: the pure mapping — fork and non-fork, caller-env precedence.
- Integration: a host-profile tool exec sees its own conversation's
  variables; two conversations see different values.
- VH: in the room, `env | grep SATAN_` from a conversation shows every value,
  and `~/db/q who` shows a `mem.origin` row with them.

## Summary

## Follow-Ups
