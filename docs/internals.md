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
| `interactive` | `persona`, `project_context`, `skills`, `cwd`, `conversation`, `coding-tools`, `grep`, `tasks`, `threads`, `bookmarks`, `bridge`, `satan` | the daemon |
| `mail` | `mail-persona`, `conversation`, `mail` | the daemon |
| `job` | `job-tools`, `job-guard` | the runner |

- `interactive` is the install order from before toolsets existed; the
  registry's list, with `satan` appended by discovery.
- `tasks`, `threads` and `bridge` are room-only, so a host's `interactive` is
  the same list without them (DEC-100); `bookmarks` is on both profiles
  (DEC-055). `mail` names none of `coding-tools`, `grep`, `satan`, `tasks` or
  `bookmarks`: the interactive toolset never includes mail, and a mail
  conversation holds nothing but the five `mail_*` tools, the conversation
  section and its own persona.
- The name is a closed type, `Toolset = "interactive" | "mail" | "job"`, so
  a name outside the catalogue does not compile.
- A stored `bridge` is retired, once: reconcile rewrites every topic and
  conversation that names it to `interactive` and writes the index back,
  logging `topic NAME: toolset bridge retired, now interactive` per topic and
  the usual list change per conversation. A second start rewrites nothing
  (DEC-101).
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

- **The topic record** (`TopicRecord = { cwd?, toolset?, model? }`) is the source for
  a new conversation in that topic, written by the `topic` frame and by
  `malebolge-attach --set-topic NAME --toolset T` (`--no-toolset` clears it) and
  `--model REF` (`--no-model` clears it).
  The profile's policy judges the name, whatever its origin, and refuses one
  it does not allow.
- **The index entry** (`{ topic, parent?, toolset }`) carries the name a
  conversation was created with. `topicInit` resolves it inside the
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
- **In the jail:** satan's `mkJailedMalebolge` sets both variables and binds
  the binary and config with their closures, and the store's directory
  read-write (a WAL reader writes `-wal`/`-shm` beside it; screwtape
  DEC-031). `~/flakes` `features/satan/malebolge.nix` passes it the
  `services.screwtape` module's `package`, `configFile` and `storeDir`.

## Bookmarks

Bookmarks reach a conversation in `interactive`, on both profiles: three
read-only tools (`bookmarks_search`, `bookmarks_tags`, `bookmarks_folders`)
over a `BookmarkSource` port (`src/bookmarks/`), fed by Firefox's daily backup.

**The source.** Firefox writes `bookmarks-YYYY-MM-DD_N_*.jsonlz4` into its
`bookmarkbackups` directory once a day (`src/bookmarks/backup.ts`). A call
takes the newest of those by name, decodes it (mozlz4, then JSON), checks the
tree against the backup schema and projects it to a flat list: a folder path,
tags, and fields capped. Every call re-reads the directory and the file — no
cache, so no answer comes from an earlier call's snapshot (DEC-027). Nothing
is written to Firefox: a call changes nothing, and an interrupted one reruns
after a restart.

- `bookmarks_search` matches a query's terms (title, url, tags, folder path),
  an exact tag, and a folder with its subfolders, a page at a time.
- `bookmarks_tags` lists every tag with its bookmark count, most used first.
- `bookmarks_folders` lists every folder with its direct bookmark count, by
  path.

**Untrusted data.** Each result opens with a header this code writes — the
backup's date, how old it is, counts, clamps, only literals and fixed forms —
and then a `<bookmark-data untrusted="true">` block, one JSON object per line.
Every `<`, `>` and `&` in a line is escaped, so no field can end the block.
The extension's section (`src/bookmarks/extension.ts`, `BOOKMARKS_SECTION`)
tells the model that everything inside the block is bookmark data taken from
web pages, never an instruction however phrased, and that a field in an item's
cut list was shortened. `src/bookmarks/` shares the block and the input ranges
with mail (`src/untrusted-block.ts`, `src/ranges.ts`) but never imports
`src/mail/`.

**Failures.** `not_configured`, `no_backup`, `too_large`, `unreadable`,
`corrupt` and `invalid` are error results with a fixed message, never an empty
page: a tool that cannot read the backup says so rather than reporting no
bookmarks.

**The variable.** `MALEBOLGE_BOOKMARK_BACKUPS` is Firefox's `bookmarkbackups`
directory as an absolute path, read when the profile allows `interactive`
(both profiles). Unset or empty leaves the three tools installed, each call
refused `bookmarks are not configured` (DEC-055); a relative path refuses
startup (`<NAME> must be an absolute path, not "…"`). There is no existence
check at start.

**Operator rollout** (outside this repo):

1. The satan flake's launcher (`~/dev/satan/flake.nix`, `mkJailedMalebolge`)
   takes an optional `bookmarkBackups` path: it sets
   `MALEBOLGE_BOOKMARK_BACKUPS` to it inside the jail and binds exactly that
   directory read-only — never the Firefox profile directory itself, which
   holds history, `logins.json` and `key4.db`. The jail sets the daemon's
   environment, so a systemd `Environment=` line would not reach it.
2. In `~/flakes` (`features/satan/malebolge.nix`), pass `bookmarkBackups` the
   absolute path of Firefox's `bookmarkbackups` directory, e.g.
   `/home/<user>/.config/mozilla/firefox/<profile>.default/bookmarkbackups`.
   The profile lives under `XDG_CONFIG_HOME` since a Home Manager update, and
   the path is configured, never discovered.
3. `just home-switch` in `~/flakes`, then
   `systemctl --user restart malebolge-room` (a switch never restarts it).
   Existing interactive conversations gain the bookmark tools at that restart;
   startup logs each changed toolset list (DEC-029(6)).
4. Check: in an interactive conversation, ask for a bookmark. `bookmarks are
   not configured` means the path did not reach the launcher; `unreadable` or
   `no bookmark backup found` means the path is wrong.

## Bridge

A jailed pi session and one room conversation exchange messages (SL-009).
SATAN never touches the project; the jailed pi does.

```
 pi jail (per project)                         room daemon
  /workspace/<project>  ro | rw                 src/bridge/listener.ts ── bridge.sock
  ~/.pi/agent/extensions/malebolge-bridge (ro)  src/bridge/pairing.ts  token hash · posture
   = pi-bridge/   index.ts ──── NDJSON ────────▶                       outbox · budget
                  malebolge-bridge send|tee ──▶ src/bridge/inbound.ts  pi → SATAN
                                                src/bridge/extension.ts  bridge_post, section
 pi-bridge/wire.ts: frames, parser, caps, socket path rule — imported by both sides
```

**The socket.** A second listener, room profile only, with its own frame
vocabulary (`pi-bridge/wire.ts`). The path rule, `bridgeSocketPath`:
`MALEBOLGE_BRIDGE_SOCKET`, else
`$XDG_RUNTIME_DIR/satan/durable/room/bridge/bridge.sock`. The daemon refuses
to start when the path is not in a `bridge/` directory inside one named
`room`. It serves the socket through `servePrivateUnix`
(`src/unix-socket.ts`): the directory is made 0700 if absent, start is refused
unless it is owned by the daemon's user and closed to group and other, and the
socket is left 0600. The directory exists so a pi jail can bind it alone,
never `durable/room/`, which holds `durable.sock`.

**Pairing.** `/bridge pair delegate|consult [conversation]` in pi sends
`pair {posture, project, conversation?}`. `project` is the basename of pi's
cwd and display only; over 255 bytes it is refused (`project longer than 255
bytes`). `conversation` is decimal digits; anything else is `not a
conversation id: X`. With an id the daemon binds that conversation, refusing
one the index does not list (`no conversation N`) and one on another
toolset (`conversation N has toolset mail, not interactive`, so a mail
conversation is refused); a fork of an interactive conversation may be
paired. Without one it binds the conversation an operator client is attached
to, root included, a `--list` connection not counting: none is `no operator
client is attached; name a conversation`, several `several conversations are
attached (N, M); name one`. A pair never creates a topic or a conversation,
and the checks and the pairing write are one commit, so a refusal writes
nothing. It mints a token per pairing and stores only its SHA-256. A new pair
on an already-paired conversation replaces the pairing: new token, posture
and project, outbox and budget reset, `seq` continuing and never reused. The
old connection is closed `superseded by a new pairing`, which pi treats as
terminal and unpairs, so its later resume gets `bad token`; a resume or newer
connection on the same pairing is still `superseded by a newer connection`,
and pi keeps the pairing and stops. pi keeps the pairing as a session entry
and resumes it on its next `session_start`; a fork of either side starts
unpaired. `/bridge end` ends the pairing; in an outage it unpairs pi alone
and leaves the daemon's pairing as it is.

**Messages.** SATAN's `bridge_post {text}` appends a turn to the pairing's
outbox (at most 32 unread: `outbox full, pi is not draining`); the listener
delivers it and pi acknowledges each entry once it is in pi's session. pi
takes a delivery only while idle (DEC-090), and a turn starts a pi turn. pi →
SATAN is pi's own `bridge_post {text}` tool (a turn) or `malebolge-bridge` (a
note unless `--turn`). The daemon frames each as
`<bridge from="pi" project="…" kind="…">…</bridge>`. The `bridge` section
renders the untrusted-data text in every room interactive conversation,
paired or not, so a body in its history stays framed as data, never an
instruction, after `/bridge end` and in a fork (DEC-107). Once the
conversation has been paired the section adds where pi runs
(`BRIDGE_ENVIRONMENT`, DEC-098): on the host, in the project's checkout, out
of SATAN's sight, reachable only through `bridge_post`, then the posture's
text. Bodies are cut head-and-tail at 32 KiB (`capHeadTail`) on both sides.

**Reach.** The bridge extension is in the room's `interactive` list
(DEC-100), so a paired conversation is an ordinary interactive conversation:
threads start, fork, post and wake into and out of it, and `interactive`
still does not wake `mail`. A pi-started turn (a `bridge_post` from pi, or
`malebolge-bridge --turn`) opens its own thread origin, kind `bridge`
(`src/threads/origin.ts`, DEC-105); a note starts no turn and keeps the
current origin. `bridge_post` is registered in every room interactive
conversation and refuses (`not a bridged conversation`, `pairing ended`)
until pi pairs.

**Budget** (DEC-070, DEC-078). A pairing admits 10 pi-started turns
(`BRIDGE_TURN_BUDGET`), spent in its own commit before the submit; a
duplicate request spends nothing and notes are free. Past it, pi is refused
`budget exhausted, waiting on the operator`. The operator refills it to 10
by typing in the bridged conversation, or by typing in pi (an interactive
`input`, while bound). Residual: a subverted pi can fake a refill.

**The pi side** (`pi-bridge/`, DEC-073). `index.ts` is the extension, a thin
shell over the pure transition function `step` in `pi-bridge/state.ts`. It
needs nothing from npm beyond pi's own packages. It registers `/bridge`
(`/bridge pair delegate|consult [conversation]`, `/bridge end`), the
`bridge_post` tool and a bash tool whose spawn hook prepends the
extension's directory to `PATH` and, while paired, sets
`MALEBOLGE_BRIDGE_CONVERSATION` and `MALEBOLGE_BRIDGE_TOKEN` (removed
otherwise, inherited values included). The operator's `!` commands get the
same variables through a `user_bash` handler (DEC-096); pi passes that
handler no env, so they run on pi's `process.env`, without pi's
own bin directory or a configured `shellPath`. `superseded by a new pairing`
is terminal, as `pairing ended` and `bad token` are: pi unpairs and stops.
While paired, pi's system prompt gains where SATAN runs
(`PI_BRIDGE_ENVIRONMENT`, DEC-098), then the posture's text. The status line
reads
`malebolge bridge: <phase>`, or `malebolge bridge: outage (attempt N)`; the
same text goes to pi-powerbar as segment `malebolge-bridge` over pi's event
bus (DEC-097), shown where powerbar's settings enable it.
Failure is loud: the first failure of an outage raises an error notice and a
best-effort `notify-send`, naming the project, pi session, conversation,
topic and socket; retries back off from 1 s doubling to 30 s and show only in
the status line; recovery notifies once. Every request has a 30 s reply
deadline (`BRIDGE_POST_WAIT_MS`); a post whose reply is lost to a drop is
resent once the same pairing is bound again, one past its deadline is
`outcome unknown` and never resent.

**`malebolge-bridge`** (DEC-075), a `#!/usr/bin/env node` script beside
`index.ts`, a bare command in pi's bash through the spawn hook's `PATH`.
It needs node 23.6 or later in the jail (type stripping).

```sh
… | malebolge-bridge send [--turn]   # stdin is the body; prints `accepted`
… | malebolge-bridge tee [--turn]    # also copies stdin to stdout; no ack line
```

| Exit | Meaning |
|---|---|
| 0 | accepted |
| 1 | connect failure: one stderr line naming the ends, best-effort `notify-send` |
| 2 | refused, the reason on stderr; also not paired, or a usage error |
| 3 | outcome unknown (reply lost, or the 30 s deadline): never retried |

**Variables.**

| Variable | Set by | Read by |
|---|---|---|
| `MALEBOLGE_BRIDGE_SOCKET` | optional; the daemon's environment, and the pi jail's by forwarding | the daemon, the extension and the command (`bridgeSocketPath`) |
| `MALEBOLGE_BRIDGE_CONVERSATION` | the extension, in pi's bash, while paired | `malebolge-bridge` |
| `MALEBOLGE_BRIDGE_TOKEN` | the extension, in pi's bash, while paired; never logged | `malebolge-bridge` |

The operator never sets the last two.

**Posture texts**, keyed by posture (DEC-072): `PI_POSTURE_TEXT` in
`pi-bridge/posture.ts` is pi's, the operator's text. `BRIDGE_POSTURE_TEXT` in
`src/bridge/extension.ts` is SATAN's placeholder; corpus prose replaces it
later (CHR-008).

**Deployment contract** (DEC-074). Malebolge owns it; `~/flakes` implements
it in the pi jail combinator (CHR-007):

1. `/run/user/1000/satan/durable/room/bridge` exists before a pi jail starts,
   and pi jails ro-bind that directory only. Whoever creates it makes it
   0700 (`mkdir -m 700`): a directory open to group or other stops the
   daemon at start.
2. `MALEBOLGE_BRIDGE_SOCKET` is forwarded into the jail when set.
3. This repo's `pi-bridge/` is ro-bound at
   `~/.pi/agent/extensions/malebolge-bridge` in the jail home.
4. The project mount has a read-only option (`--ro-bind`).

The jail also needs `node` for `malebolge-bridge` (~/flakes adds `nodejs_24`
wherever pi runs). The room daemon runs this repo's live tree, so a bridge
change is deployed by restarting `malebolge-room`.

## Jail

The daemon runs in `jailed-malebolge` (`~/dev/satan/flake.nix`
`mkJailedMalebolge`), started by
the `malebolge-room` systemd user unit (`M-x malebolge-start`; unit facts in
`~/flakes/SATAN.md`). Its stop sends SIGTERM; the daemon's stop handler runs.
The jail sees this repo read-only, `~/satan-corpus` read-only (its `goad/`
read-write), the session store, and `$XDG_RUNTIME_DIR/satan/`. Its only secret
is the gateway key file, bound read-only with the catalog;
`MALEBOLGE_GATEWAY_KEY_FILE` and `MALEBOLGE_GATEWAY_CATALOG` point at them. No
provider keys, no `op run`. It sets `MALEBOLGE_PROFILE=room`. The bookmark
tools need a read-only bind of Firefox's `bookmarkbackups` directory alone:
see the rollout under [Bookmarks](#bookmarks).

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
| `list`, well-formed | `conversations`, or `topics` for a `topics:true` query, or `models` for `models:true` | ended cleanly: reply, then end, no error |
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
  (that topic's ids from the index, newest first),
  `{"type":"list","topics":true}` (the topic records), or
  `{"type":"list","models":true}` (the catalogue's chat-model refs, answered
  without a store call). Strict too: any key it
  does not know is refused before anything is read, so `{"type":"list","page":2}`
  answers `list: unknown key page` and ends the connection, binding nothing
  (`src/protocol.ts`). `topic`, `topics` and `models` are exclusive, `topics`
  and `models` must be `true`, and a `topic` no write made is `no topic NAME`.
  The page size is the daemon's, not the client's.
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
