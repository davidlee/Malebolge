# SL-004 research

- **Thread 1 (governance):** pi `research` profile, deepseek-flash, quotient
  run `run-20261024T100121270Z-5-2f21525815e5`; verbatim in `raw/governance.md`.
- **Thread 2 (code map):** the orchestrator, by hand (the delegate failed on a
  gateway outage; `raw/code-map.md`).
- **Baseline:** `baseline.toml`, stamped by `doctrine slice research 4`.

## Verification legend

✓ = checked by the consuming agent (orchestrator) at the cited site.
Unmarked = researcher claim, cited, not checked. Thread 2 was produced by the
orchestrator from direct reads, so all its rows are ✓.

## Thread 1 — governance applicability

### Binding constraints

- ✓ **DEC-013** — the index is one session-scoped document; topic and parent
  are read from it, never from new state.
- **DEC-012** — the creation hook skips task-owned conversations, so an index
  miss is legitimate (task-owned) and its variables stay unset. ✓ at
  `src/topics.ts:82-85`.
- ✓ **DEC-015** — root is `default`'s first conversation; root's lookup yields
  `default`, never a miss.
- **satan:DEC-104 / DEC-107** — the conversation's stored `cwd` is authoritative
  after creation; `SATAN_CWD` reports it and re-derives nothing.
- **RFC-002 "Shared resources"** — the room env id `pi-env:daemon-room` stays
  the same for every conversation (pi-durable serialises writes by env id). Not
  found by grep under `.doctrine/` as quoted; the id itself is ✓ at
  `src/daemon-env.ts:150`, and SL-004 leaves it alone.
- **satan:DEC-106** — room faults stay per daemon; the variables must not
  re-attribute them.
- **CHR-002** — pi packages stay at 1.4.0; SL-004 consumes, never bumps.

### Checked, not applicable

- DEC-007/008/010/017 — listing and attach flags; SL-004 adds no frame or flag.
- DEC-001–006, DEC-009 — Emacs behaviour.
- DEC-079/080/081 — satan-repo ids; nothing in this repo flows through them.
- IMP-009 — room↔host path mapping; SL-004 emits each profile's own paths.
- RFC-001, IMP-002 — module placement advice; non-binding.
- Memory: no matches for SATAN_ variables or prompt sections.

### Revision candidates

- **RFC-002 env-hook row** — says the hook gets `EnvTarget{conversationId,
  cwd?}`; SL-004 also uses `read`. Archive drift in a resolved RFC; low value.
- Rejected: the delegate's DEC-014 candidate. ✓ DEC-014 governs `--here`, not
  the profile's value set. Malebolge emits only `host`/`room`; `tick-agent` is
  another harness's value.

## Thread 2 — code map

### Hotspots

- `src/session.ts:28` — `SessionOptions.env` typed `(state: {cwd?}) =>
  ExecutionEnv`; widens to `(target: EnvTarget) => ExecutionEnv`.
- `src/daemon-env.ts:120-150` — `hostEnv`/`roomEnv` build a fresh env per call.
- `src/daemon-start.ts:68,111` — `daemonEnv(config.execution, log)` passed to
  `openSession`; `config.execution.profile` is in scope (`:59`).
- `src/daemon-extensions.ts:24-31` — section order; `cwdExtension` sits here.
- `src/cwd.ts` — the per-conversation section precedent.

### Cited facts (all ✓)

- F-1. Both env constructors take a base environment for every inheriting
  command: `NodeExecutionEnv({cwd, shellEnv})` (`pi-durable/dist/env/node.d.ts`;
  merge `{...process.env, ...shellEnv, ...options.env}`, `env/node.js:205-212`),
  and `RemoteExecutionEnv({shellEnv})` (`pi-env/dist/remote-env.d.ts:12-13`;
  merge `{...shellEnv, ...options.env}`, `remote-env.js:767`). A per-exec
  caller `env` wins in both.
- F-2. The env hook builds a new env each use: `hostEnv` `new
  NodeExecutionEnv(...)` per call (`daemon-env.ts:121`), `roomEnv`
  `observedEnv(...)` per call (`:142-148`). So a per-conversation `shellEnv` is
  passed at construction, with no exec wrapper.
- F-3. `observedEnv` builds `RemoteExecutionEnv({connection, id, cwd})`
  (`src/room/connection.ts:177-192`); it needs a `shellEnv` pass-through.
- F-4. pi-durable's bash tool calls `env.exec(cmd, {env: {}, inheritEnv: true,
  …})` (`pi-durable/dist/tools/bash.js:36-37,51-55`), so it inherits `shellEnv`.
- F-5. `EnvTarget = {conversationId, cwd?, read: DocumentReader}`
  (`harness/types.d.ts:541-546`); `DocumentReader = Pick<Session, "snapshot" |
  "snapshotAsOf">` (`dist/types.d.ts:917`). `readIndex(session: Pick<Session,
  "snapshot">)` (`src/topics.ts:115`) therefore takes `target.read` as is.
- F-6. `PromptInput` carries `conversationId` and `read` too
  (`harness/types.d.ts:277-287`), so the section reuses `readIndex`.
- F-7. `IndexEntry = {topic, parent?: number}`; keys are `String(id)`
  (`src/topics.ts:32,62-72`).
- F-8. `ExecutionEnv = FileSystem & Shell`, ~28 methods
  (`pi-durable/dist/env/index.d.ts:164-303`). An exec-only wrapper would have to
  forward all of them, and `RemoteExecutionEnv` uses `#private` fields, so a
  prototype-delegating wrapper would break `this`. F-1/F-2 make it unnecessary.
- F-9. A second env factory exists: the runner's `roomTenancy().env`
  (`src/runner/tenancy.ts:35-37`) — patch jobs, not daemon conversations.

### Naming precedents

- Modules are flat kebab-case nouns in `src/` (`project-context.ts`,
  `daemon-env.ts`, `topics.ts`). Extensions are `<noun>Extension`
  (`cwdExtension`, `grepExtension`).

### Test precedents

- `test/daemon-env.test.ts` — host/room construction (`:103`, `:113`).
- `test/harness-fixture.ts` — `openFauxHarness`, `callThenAnswer`,
  `toolResults`, `systemPromptSections`, `indexOf`: a faux-model turn that runs
  a bash tool and reads its result, and a section renderer.
- `test/daemon-sections.test.ts`, `test/topics.test.ts`.

## Cross-thread findings

- X-1. **No exec wrapper.** F-1 + F-2: pass the variables as `shellEnv` where
  each env is built. Host and room differ only in which constructor gets it.
  This also keeps the room env id unchanged (RFC-002 constraint).
- X-2. **Index miss is real, not hypothetical.** DEC-012 skips task-owned
  conversations; those get `SATAN_CONVERSATION` etc. but no topic, matching
  `q`'s NULL-is-honest rule. Root always resolves to `default` (DEC-015).
- X-3. **The runner is out of scope.** F-9's patch-job env is a separate
  harness surface (patch-runner owns its rows in the ADR-017 ledger); it may
  want the same variables later. Follow-up, not this slice.
- X-4. **Topic read per use is safe.** No verb renames a topic or moves a
  conversation between topics after creation (SL-003 objectives 3–4), so a
  live read equals the creation-time value.

## Design-input deltas

- Drop the "exec wrapper" from scope objective 2: set `shellEnv` at env
  construction (X-1). Simpler, and avoids forwarding ~28 methods (F-8).
- The pure function's input is `{profile, conversationId, cwd, entry?}`; the
  hook does the one `readIndex(target.read)`.
- `observedEnv` gains an optional `shellEnv` (F-3).
- Q-1 stays open: a separate `conversation` section, or fold into `cwd`.
