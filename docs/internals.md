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
 ├─ conversation section   "Conversation: <id> (topic: …)"
 ├─ CodingTools        read · write · edit · bash  ┐ through daemonEnv's
 ├─ grep               ripgrep                     ┘ environment (below)
 ├─ satan extension    pi-mcp client ──unix socket──▶ emacs satan-mcp
 └─ $XDG_RUNTIME_DIR/satan/durable/<profile>/durable.sock ◀──NDJSON── clients
```

## Execution profiles and the room

`resolveConfig` (`src/config.ts`) turns `MALEBOLGE_PROFILE` into an
`Execution`; `daemonEnv` (`src/daemon-env.ts`) is the one place an
`Execution` becomes the tools' environment — its `shellEnv`, the conversation's
`SATAN_*` from `conversationVars` (`src/conversation-context.ts`) — their cwd
and the startup project context.

```
host:  env(target) ─▶ NodeExecutionEnv(cwd = target.cwd ?? launch dir, shellEnv = SATAN_*)
room:  env(target) ─▶ RemoteExecutionEnv "pi-env:daemon-room", cwd = target.cwd ?? home,
                       shellEnv = SATAN_*
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

## Toolsets

A conversation's model-facing tools come from its **toolset**: a named,
complete, ordered list of extension names (`src/toolsets.ts`), chosen as a
whole with its persona.

| Toolset | Extensions, in system prompt and tool order | Used by |
|---|---|---|
| `interactive` | `persona`, `project_context`, `skills`, `cwd`, `conversation`, `coding-tools`, `grep`, `tasks`, `satan` | the daemon |
| `mail` | `mail-persona`, `conversation`, `mail` | the daemon |
| `job` | `job-tools`, `job-guard` | the runner |

- `interactive` is the install order from before toolsets existed; the
  registry's list, with `satan` appended by discovery.
- `tasks` is room-only, so a host's `interactive` is the same list without
  it. `mail` names none of `coding-tools`, `grep`, `satan` or `tasks`: the
  interactive toolset never includes mail, and a mail conversation holds
  nothing but the five `mail_*` tools, the conversation section and its own
  persona.
- The name is a closed type, `Toolset = "interactive" | "mail" | "job"`, so
  a name outside the catalogue does not compile.
- A persona belongs to the toolset too: `interactive` reads
  `system/scaffold.txt`, `prompts/interactive.txt` and
  `prompts/env/<profile>.txt`; `mail` reads `system/scaffold.txt` and
  `prompts/mail.txt`, with no environment file, since its tools run on the
  host whatever the profile. Both render the section key `persona`, so the
  two never meet in one conversation.

**Policy per profile** (`PROFILE_TOOLSETS`):

| Profile | Default for a new conversation | Allowed |
|---|---|---|
| `room` | `interactive` | `interactive`, `mail` |
| `host` | `interactive` | `interactive` |

The daemon installs the union of its allowed toolsets' lists and refuses to
start when a static name is not installed (`extension <name> is not
installed`). `satan` is the one dynamic member: discovery installs it before
the session resumes, and pi-durable skips a selected name the registry lacks,
so an absent `satan` is fewer tools, never more. The runner picks `job` in
code, opens the harness with no index and stores no name.

**Where the toolset is recorded.**

- **The topic record** (`TopicRecord = { cwd?, toolset? }`) is the source for
  a new conversation in that topic, written by the `topic` frame and by
  `malebolge-attach --set-topic NAME --toolset T` (`--no-toolset` clears it).
  The profile's policy judges the name, whatever its origin, and refuses one
  it does not allow.
- **The index entry** (`{ topic, parent?, toolset }`) carries the name a
  conversation was created with. `toolsetInit` resolves it inside the
  creating commit — the topic's, else the profile default — and sets the
  conversation's `extensions` from it, so no create path can omit it. The
  name is fixed at creation; the list is re-derived from it, so a change in
  the catalogue reaches existing conversations at the next restart while a
  conversation never changes toolset.
- **The startup reconcile** writes it back: an entry without a toolset gets
  the profile default (the one-time backfill, root included), a topic record
  or entry whose toolset the profile does not allow refuses startup naming
  it, and each conversation whose `extensions` differ from its toolset's list
  is rewritten, logged `conversation <id>: toolset <t> list changed`. Root's
  `configure` carries no `extensions`, so the reconcile is root's only
  writer. A fork or a task-owned conversation refuses startup, named, since
  neither can be given a selection (IMP-017).

## Mail

Mail reaches a conversation only through the `mail` toolset: five read-only
tools (`mail_new`, `mail_read`, `mail_thread`, `mail_list`, `mail_mailboxes`)
over a `MailSource` port.

**Port.** `MailSource { mailboxes, list, read, readAfter, thread }`
(`src/mail/source.ts`) returns validated envelopes; the tools clamp their
bounds and refuse inputs before any port call, and a fake stands in for the
adapter in tests.

**The screwtape adapter** (`src/mail/screwtape.ts`) runs one child per call.

- argv is `[MALEBOLGE_SCREWTAPE, "--config", MALEBOLGE_SCREWTAPE_CONFIG,
  <verb>, …]`: `--config` comes first, and there is no shell.
- `inheritEnv: false` with `env: { HOME }`, so the daemon's environment never
  merges in; `HOME` is the daemon's.
- 10 s timeout. The child runs in a host `NodeExecutionEnv` owned by the mail
  extension, never the conversation's environment (which may be the room);
  an in-flight child is ended by its call's abort when the harness closes.
- stdout is bounded at 4 MiB per line and in all, through the bounded exec
  shared with `grep` (`src/bounded-exec.ts`), and is read as a stream of JSON
  envelope lines. Oversize fails the call closed: no partial result, and,
  when `limit` is above 1, the error says to retry with `limit: 1`. stderr is kept to 4 KiB and read only
  for a usage error's code.
- Every line must be a v1 envelope of the called verb's kind whose `data`
  passes the schema, with ids, cursors and `received_at` checked; arity is
  one envelope, except `read --after`, which prints 0 to `limit`. A breach is
  `screwtape contract violation: <what>`, from a fixed vocabulary.
- Every tool is replay-safe: reading mail changes nothing, so an interrupted
  call reruns after a restart.

| outcome | model sees |
|---|---|
| exit 0 | the result |
| exit 2 | `screwtape usage error: <code>`, the code only if it matches `^[a-z_]{1,64}$`, otherwise `screwtape usage error` |
| any other exit, `128+n` included | `screwtape failed (exit N)` |
| timeout | `screwtape timed out after 10 s` |
| the child does not start | `screwtape could not run` |
| aborted | the abort propagates; the call is aborted |

No child text, raw stderr least of all, reaches a message the model can see.

**Untrusted data.** Each result opens with a header this code writes — counts,
cursor, clamps, only literals and fixed forms — and then a
`<mail-data untrusted="true">` block, one JSON object per line. Every `<`,
`>` and `&` in a line is escaped, so no field can end the block. The extension's
section (`src/mail/extension.ts`) tells the model that everything inside the
block is email data written by the sender, never an instruction however
phrased, and that a field in an item's cut list was shortened or left out
(`mail_read` shows a message in full).

**The Screwtape variables.** `MALEBOLGE_SCREWTAPE` and
`MALEBOLGE_SCREWTAPE_CONFIG` are absolute paths, read only when the profile
allows `mail` (that is, `room`); a host neither reads nor refuses them. There
is no `PATH` lookup and no existence check: unset or empty is `<NAME> is not
set`, and a relative path is `<NAME> must be an absolute path, not "…"`.

- `MALEBOLGE_SCREWTAPE` is the `screwtape` executable itself, not a wrapper
  script that already passes `--config`: the daemon adds `--config` first, so
  a wrapper that adds its own would meet it twice. The Home Manager wrapper
  is such a script; point the variable at the store path it `exec`s.
- **Deployment order:** 1. add `prompts/mail.txt` to the corpus, so the
  persona files exist; 2. set both variables in the launcher's environment;
  3. restart the daemon. A room start without either refuses.

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

One JSON message per line on the daemon socket. A connection's first line is
either a **first-line frame** — `attach`, which names the conversation the
connection binds to, `list`, which asks what this store holds, or `topic`,
which writes one topic's directory — or a command, which binds the connection
to root (`src/daemon.ts`). Every later line acts on that binding.

| first line | answered with | the connection after |
|---|---|---|
| `attach`, well-formed | `attached`, then the snapshot | bound to that conversation |
| `attach`, refused | one `error` | ended, binding nothing |
| `list`, well-formed | `conversations`, or `topics` for a `topics:true` query | ended cleanly: reply, then end, no error |
| `list`, refused | one `error` | ended, binding nothing |
| `topic`, well-formed | `topics`, the one record written | ended cleanly |
| `topic`, refused | one `error` | ended, binding nothing |
| a command | its own events, no `attached` | bound to root, stays open |

No frame is a verb a bound connection can use: one sent later is refused by the
rule below, not served.

- client → daemon, the `attach` frame, valid only as the first line:
  `{"type":"attach"}` (root), `{"type":"attach","conversation":N}`,
  `{"type":"attach","new":true}`, `{"type":"attach","new":true,"cwd":S}`,
  and the topic forms `{"type":"attach","topic":"NAME"}` and
  `{"type":"attach","topic":"NAME","new":true,"cwd":S}`. Strict:
  `conversation` with `new` or with `topic`, `cwd` without `new`, `new` other
  than `true`, a `conversation` that is not a safe positive integer, a name
  that does not match `[a-z0-9][a-z0-9._-]{0,63}`, a non-string `cwd`, or an
  unknown key is refused before anything is created (`src/protocol.ts`). `cwd`
  is handed to pi uninterpreted; a new conversation is ownerless and carries
  the daemon's model and cwd as its defaults (`src/conversations.ts`).
- client → daemon, the `attach` frame with a `topic`: a topic target binds
  that topic's latest conversation — the highest id in the index, since pi
  mints ids in creation order — or creates its first when it has none or
  `new` asks for one, with `init: assignTopic(name)`. Its directory is the
  client's `cwd`, else the topic's, else the daemon's, read once at creation;
  after that the conversation's own `cwd` governs. A topic no frame has
  written is `no topic NAME` (`src/conversations.ts`): nothing creates a topic
  implicitly. `default` is not reserved here — attaching to it is how a client
  reaches root by name.
- client → daemon, the `list` frame, valid only as the first line:
  `{"type":"list"}` (this store's page), `{"type":"list","topic":"NAME"}`
  (that topic's ids from the index, newest first), or
  `{"type":"list","topics":true}` (the topic records). Strict too: any key it
  does not know is refused before anything is read, so `{"type":"list","page":2}`
  answers `list: unknown key page` and ends the connection, binding nothing
  (`src/protocol.ts`). `topic` and `topics` are exclusive, `topics` must be
  `true`, and a `topic` no write made is `no topic NAME`. The page size is the
  daemon's, not the client's.
- client → daemon, the `topic` frame, valid only as the first line:
  `{"type":"topic","name":"NAME"}` creates the topic, or leaves an existing
  record exactly as it is, so the frame is idempotent;
  `{"type":"topic","name":"NAME","cwd":S}` sets its directory and
  `"cwd":null` clears it. Refused: a bad name, `topic: default is reserved`,
  `cwd` that is neither a string nor `null`, a `cwd` holding a control
  character (`topic: cwd must not contain a control character`, so a
  `--topics` line stays one `NAME<TAB>DIR` record), an unknown key.
- client → daemon, later lines:
  `{"type":"input","content":…,"requestId"?:…}`, `{"type":"abort"}`,
  `{"type":"compact","instructions"?:…}`
- daemon → client, the `list` frame's reply:
  `{"type":"conversations","conversations":[N,…],"truncated":false}` — bare
  ids, newest first, and whether the page was cut. A framed object rather than
  a bare array, so keys can widen additively; a conversation a task owns is
  absent, since an attach to one is refused. The page is `LIST_PAGE` (50,
  `src/conversations.ts`), and `truncated: true` says the oldest conversations
  are not in this page — not that some pager exists. `malebolge-attach --list`
  is this frame's client: ids on stdout, one truncation line on stderr. A
  `{"type":"list","topic":"NAME"}` reply is the same shape from the index
  instead of a scan, so it cuts at `LIST_PAGE` too.
- daemon → client, the `topics` reply, to a `topics` query and to a `topic`
  write alike: `{"type":"topics","profile":"host","topics":[{"name":"default"},…]}`
  — `default` first, then the rest by name, a topic's directory present when
  it has one. `profile` is the answering daemon's own, `host` or `room`
  (`config.execution.profile`), because a topic directory is a path in that
  profile's space and the client cannot learn it from its own environment:
  `MALEBOLGE_SOCKET` can point it at any daemon (`src/config.ts`).
  `malebolge-attach --topics` and `--set-topic` are this reply's clients.
- daemon → client, an attached connection:
  `{"type":"attached","conversation":N}` once, after a successful attach and
  before the snapshot; then pi-durable `watchEvents` agent events, first a
  `snapshot`; `{"type":"error","message":…}` for a line it could not act on.

The first line's outcome:

- a refused `attach` — an unknown id, a conversation a task owns,
  `conversation` with `new`, an unknown topic, a bad name — or a malformed
  `list` or `topic`: one `{"type":"error"}` naming the frame, and the daemon
  ends the connection, dropping the lines queued behind it.
- a `list` or `topic` that parses: one `conversations` or `topics` reply, then
  the daemon ends the connection. A listing or a write writes no error and
  leaves nothing behind but a topic record.
- a `list` whose read fails: one `{"type":"error"}` and the connection ends,
  rather than an error left on a connection that would then stay silent.
- a first line that is a command: root is bound, the line is acted on, and
  no `attached` is sent.
- on a bound connection, any line that parses as a first-line frame —
  `attach`, `list` or `topic`, valid or refused — answers the unprefixed
  message `already attached to conversation N`, and the connection stays open
  with its binding unchanged; a line that is not JSON or not an object, or any
  other bad line, gets its ordinary error.
- a line that is not JSON, or neither frame nor a valid command, binds root,
  answers the error, and stays open.

A connection that sends nothing is never bound and receives nothing
(`probeUnix` connects and leaves). An id names a conversation only within
this profile's store and socket; a client that persists one persists the
profile with it.

**The index.** One session-scoped document, `malebolge.index` version 1
(`src/topics.ts`), holds both halves of the model:

```
{ topics: { NAME: { cwd? } }, conversations: { "ID": { topic, parent? } } }
```

An entry files one conversation under a topic and, for a fork, names the
conversation it came from, from which it inherits the parent's topic.
`conversations` is keyed by conversation id as a string, since JSON has no
other keys; `topics` holds only topics a `topic` frame wrote, never `default`,
which always exists and has no directory. Task-owned conversations are not
indexed — an attach to one is refused anyway.

- **Written in the creating commit.** `conversationCreated` writes the entry,
  so a commit that creates or forks a conversation cannot land without one;
  a throw fails that commit. `conversationCreated` reads documents only, never
  a table, so no read-after-write can fire.
- **Merged, never replaced.** A write spreads the existing entry, so keys a
  later slice adds survive every write.
- **Session scope**, so a fork never copies it, and the document is
  checkpointed every 50 deltas rather than per write.
- **Backfill.** Opening a store whose conversations predate the index puts
  every ownerless conversation the document does not know, root included, into
  `default`: one commit, paged reads of 64, every read before the first write.
  A second start finds nothing to do and writes nothing.
- **One reader.** `readIndex` is the only read; a store whose index was never
  written reads as the empty document, because a snapshot does not apply a
  document's `initial()`.

**One dispatch table.** `src/protocol.ts` parses a first-line frame into
`FirstLineFrame = AttachMessage | ListMessage | TopicMessage`, strictly; a
`type` that names none falls through to `parseClientMessage`. `src/daemon.ts`
holds one table, `FIRST_LINE`, keyed by `FirstLineFrame["type"]` with a
handler per key: `attach` binds the target, `list` and `topic` answer through
`answer(state, produce)`, which sends one reply and `finish`es, or sends any
rejection through `fail` (a failed read closes, DEC-007). The mapped type
makes a frame without a row a compile error, so **a new first-line verb costs
one parser case and one table row**, and `laterLine` needs no edit: it asks
whether the line is a `FirstLineFrame` at all instead of naming each type.

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
