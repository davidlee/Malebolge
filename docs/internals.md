# Malebolge internals

Notes for working on Malebolge. The [README](../README.md) covers what it is
and how to run it.

Origin: spike satan `CHR-012`, feeding satan `RFC-018` ("Pi Durable as the
harness").

## Components

```
malebolge (daemon, owns the session)                     clients
 ├─ Harness on SQLite  ~/.local/state/satan/durable/<profile>/   malebolge-attach (terminal)
 ├─ conversations.ts   attach target ─▶ root, an existing or a new one
 ├─ persona section    ~/satan-corpus scaffold + interactive  M-x malebolge-attach (comint)
 │                     + prompts/env/<profile>.txt
 ├─ project_context section   AGENTS.md chain, .pi/APPEND_SYSTEM.md (read once)
 ├─ skills section     SKILL.md listings from $MALEBOLGE_SKILLS
 ├─ cwd section        "Current working directory: …"
 ├─ CodingTools        read · write · edit · bash  ┐ through daemonEnv's
 ├─ grep               ripgrep                     ┘ environment (below)
 ├─ satan extension    pi-mcp client ──unix socket──▶ emacs satan-mcp
 └─ $XDG_RUNTIME_DIR/satan/durable/<profile>/durable.sock ◀──NDJSON── clients
```

## Execution profiles and the room

`resolveConfig` (`src/config.ts`) turns `MALEBOLGE_PROFILE` into an
`Execution`; `daemonEnv` (`src/daemon-env.ts`) is the one place an
`Execution` becomes the tools' environment, their cwd and the startup
project context.

```
host:  env(state) ─▶ NodeExecutionEnv(cwd = state.cwd ?? launch dir)
room:  env(state) ─▶ RemoteExecutionEnv "pi-env:daemon-room", cwd = state.cwd ?? home
                       └─ ObservedConnection(reword, logs) ─┐
       readContext ─▶ roomShell ─▶ (its own ObservedConnection) ─┤
                                                             DaemonConnection (one, lazy)
                                                               ssh ─▶ pi-env in the room
                                                               (directLaunch: no `session`)
```

- **One connection for the daemon's life.** Nothing runs until the first
  call; a failed start fails that call and the next call tries again.
  `close` at shutdown closes it. The daemon never starts the room.
- **An `ObservedConnection` always wraps a `DaemonConnection` directly.** Its
  trust check reads `trustFailure()` from its immediate inner connection, so
  a nested wrapper would report a host-key refusal as a lost room
  (satan RV-035 F-4; the control test is in `test/daemon-env.test.ts`).
- **Room faults are worded once, at the connection seam** (`reword`), so
  `read`, `write`, `edit`, `bash` and `grep` alike see `room unavailable: …`
  (lost, no trust failure) or `room host key untrusted: …` (the start failed
  host-key checking; never reported as unavailable). Both are logged. Any
  other failure keeps pi-env's message. The runner passes no reword.
- **Startup context in the room** is read from the home only, through the
  room's source reader, every exec bounded (`FETCH_LIMITS` / `HEAD_LIMITS`).
  A down or untrusted room is logged and yields no project context; the
  daemon starts anyway.
- **Gateway socket.** When `MALEBOLGE_GATEWAY_SOCKET` is set and absent,
  start is refused (`gateway socket missing: …`). Presence only.

## Jail

The daemon runs in `jailed-malebolge` (`~/dev/satan/flake.nix`), started by
the `malebolge-room` systemd user unit (`M-x malebolge-start`; unit facts in
`~/flakes/SATAN.md`). Its stop sends SIGTERM; the daemon's stop handler runs.
The jail sees this repo read-only, `~/satan-corpus` read-only (its `goad/`
read-write), the session store, and `$XDG_RUNTIME_DIR/satan/`. Its only secret
is the gateway key file, bound read-only with the catalog;
`MALEBOLGE_GATEWAY_KEY_FILE` and `MALEBOLGE_GATEWAY_CATALOG` point at them. No
provider keys, no `op run`. It sets `MALEBOLGE_PROFILE=room`.

Startup order: the instance lock (`daemon.lock` beside the store; a second
daemon of the profile is refused before it opens the store), then the socket
claim (a live server there refuses the start; a stale socket — listener died —
is replaced), then the first SATAN tool refresh, then the session opens, so a
turn resumed after a restart has the tools. Clients that connect during startup
wait for the session. Residual race: the stale-socket replace is safe only
because the lock holder alone reaches the socket; a daemon build without the
lock is not excluded.

## Protocol

One JSON message per line on the daemon socket. The first line a connection
sends binds it to one conversation (`src/daemon.ts`); every later line acts
on that binding.

- client → daemon, the `attach` frame, valid only as the first line:
  `{"type":"attach"}` (root), `{"type":"attach","conversation":N}`,
  `{"type":"attach","new":true}`, `{"type":"attach","new":true,"cwd":S}`.
  Strict: `conversation` with `new`, `cwd` without `new`, `new` other than
  `true`, a `conversation` that is not a safe positive integer, a non-string
  `cwd`, or an unknown key is refused before anything is created
  (`src/protocol.ts`). `cwd` is handed to pi uninterpreted; a new conversation
  is ownerless and carries the daemon's model and cwd as its defaults
  (`src/conversations.ts`).
- client → daemon, later lines:
  `{"type":"input","content":…,"requestId"?:…}`, `{"type":"abort"}`,
  `{"type":"compact","instructions"?:…}`
- daemon → client: `{"type":"attached","conversation":N}` once, after a
  successful attach and before the snapshot; then pi-durable `watchEvents`
  agent events, first a `snapshot`; `{"type":"error","message":…}` for a line
  it could not act on.

The first line's outcome:

- a refused `attach`, an unknown id or a task-owned conversation: one
  `{"type":"error"}` and the daemon ends the connection, dropping the lines
  queued behind it.
- a first line that is a command: root is bound, the line is acted on, and
  no `attached` is sent.
- on a bound connection, a second `attach` — well-formed or not — answers
  `already attached to conversation N` and the connection stays open with its
  binding unchanged; any other bad line gets its own error.
- a line that is not JSON, or neither `attach` nor a valid command, binds
  root, answers the error, and stays open.

A connection that sends nothing is never bound and receives nothing
(`probeUnix` connects and leaves). An id names a conversation only within
this profile's store and socket; a client that persists one persists the
profile with it.

## Design notes

- **Not a pi coding-agent extension host.** pi-durable is a library with its
  own extension model (`defineExtension`/`defineTool`); it does not load
  `ExtensionAPI` extensions such as `~/notes/.pi/extensions/satan.ts`.
  `src/satan-tools.ts` is that extension's durable counterpart, built on
  pi-mcp with a unix-socket transport (`src/unix-socket-transport.ts`).
- **SATAN tools are not replay-safe.** A crash mid-call gives the model an
  `interrupted` error result instead of rerunning a side-effecting tool.
- **satan-mcp may restart under the daemon** (Emacs restarts it). The next
  SATAN tool call reconnects; a call made while it is down fails and is not
  retried. The SATAN tool list is refreshed before each input and on
  reconnect, so tools satan-mcp adds or drops show up on the next input
  without a restart; a call to a tool that has gone settles as
  `tool_unavailable`. satan-mcp absent at start: the daemon starts with zero
  SATAN tools.
- **Persona is live.** The section re-reads the corpus files on each request;
  the harness resends only changed sections, so prompt caching survives.
- **Skills are listed once.** `$MALEBOLGE_SKILLS` directories are loaded and
  parsed at daemon start (DEC-067); the section then renders a constant. Bad
  or missing entries are logged `skill <dir>: <reason>` and dropped, never
  fatal. The model reads a skill's body with the `read` tool when it uses
  it, so body edits take effect at once; changes to the listing (adding or
  removing a skill, or a frontmatter `name`, `description` or
  `disable-model-invocation`) need a daemon restart. Wording and rules follow
  pi 1.3.0's `formatSkillsForPrompt`.
- **Sections.** The daemon's order is persona, project_context, skills, cwd,
  then the tools (CodingTools, grep, satan), set once in
  `src/daemon-extensions.ts`. Persona is live; project_context and skills are
  per profile, cwd per conversation: each conversation's agent carries its
  directory, so a conversation created elsewhere states that directory, while
  its project context still came from the daemon's. pi-durable re-sends all
  sections once, in the desired order, when a new key would otherwise land
  out of place.
- **Project context (sources).** Project instructions follow pi's coding
  agent: per directory the first of `AGENTS.override.md`, `AGENTS.md`,
  `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD` (`CONTEXT_FILE_NAMES`) that is a
  regular file and reads, for the cwd and its ancestors up to the git root
  (outermost first), plus `.pi/APPEND_SYSTEM.md` at the cwd. Each source is
  capped at 64 KiB (`SOURCE_CAP_BYTES`) with a `[truncated at 65536 bytes]`
  marker; an empty source, and an empty set, are omitted.
  - *Daemon:* read once at start; edits need a restart. It does not run
    doctrine. Host profile: a node fs reader (`stat` decides what is a
    regular file, so a FIFO is never opened). Room profile: the room's
    source reader over the home only, no root walk (above).
  - *Runner:* read in the room during `preparing`, as `readyRoom`'s final
    step (`src/runner/project-context.ts`), through the room's shell: one
    `stat -L` from the clone root over absolute paths (a clone-root-only
    chain), then `head -c` reads, each exec bounded. When the clone has
    `.doctrine/` and its boot file is git-ignored it also runs
    `doctrine prompt resolve --role orchestrator` (60 s, output a source,
    overflow truncating) and re-checks the clone, since doctrine may write.
    A source that cannot be had degrades: one `context_degraded` audit event
    per degradation, and the job continues without that source. For doctrine
    that is an unignored boot, a missing binary, a timeout, a non-zero exit
    without overflow, empty (all-whitespace) output, or a `test -d .doctrine`
    or `git check-ignore` that times out, overflows or exits other than 0/1;
    for a file, a `stat` or `head` that cannot run or times out (a `stat`
    also when it overflows or exits other than 0/1). The re-check does not
    degrade: a defect it finds fails preparing with that defect, and a check
    that cannot finish fails it `dirty_clone` with no paths. A lost room, an
    untrusted host key and an abort are rethrown, never degraded.
  - *Composition* of the job prompt: corpus text, policy fragments, project
    instructions, then the job block (which carries `Working directory:`).
    The repo's text precedes the block and never alters it.
- **grep.** `rg --json --line-number --color=never --hidden` plus the call's
  options, then `-- pattern path`, run through the conversation's execution
  environment: the room for jobs, the daemon's jail for the daemon, `rg` from
  the room's base or the jail's `PATH`. Replay-safe (a crash mid-call reruns
  it). Output is bounded on the host as it streams: an rg message over 1 MiB
  is dropped and counted, lines are cut at 500 characters, stderr is kept to
  4 KiB, `limit` defaults to 100 matches (1 to 1000), and the result stops at
  50 KB. Exit codes: 0, or 2 with matches, answers the matches; 1 is "No
  matches found"; otherwise an error with rg's stderr; a missing `rg` is an
  error result naming it.
- **Model catalog.** pi-ai 1.3.0's built-in catalog lags the coding agent's
  remote one; `src/models.ts` adds the models found in
  `~/.pi/agent/models-store.json`.
- **One process owns the storage.** Clients never touch it; they attach.
- **An answer's text is spread across events.** `message_start` carries the
  first partial; `message_update` carries deltas *or* whole `block`/`message`
  replacements; the final entry at `message_end` may hold a tail no update
  delivered. A client must track the answer's text, not just append deltas
  (`src/render.ts`). The faux provider at `tokensPerSecond: 40` reproduces
  this shape in tests.
