# Malebolge

![bridges](./assets/wall.jpg)

A durable home for [SATAN](https://github.com/davidlee/SATAN): conversations
that outlast their clients, and patch jobs that run in a microVM and return
work for human review. Built on
[pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable).

## What it's for

SATAN is a personal agent: it knows my notes and [recent activity](https://github.com/davidlee/panopticon), and can
propose changes to its [own code](https://github.com/davidlee/satan), persona, and [other](https://github.com/davidlee/org-incremental-writing) [projects](https://github.com/davidlee/doctrine). Malebolge hosts
its agent conversations independently of Emacs. This repository currently
ships two programs:

- **`malebolge`**, the interactive daemon. It holds its profile's
  conversations; terminal and Emacs clients attach to one — root by
  default — talk and detach. Several clients can be attached at once, and a
  client sees its conversation's history once attached.
- **`satan-runner`**, the patch-job daemon. It owns a durable queue and runs
  one job at a time, each with its own conversation. The model loop runs on
  the host; coding tools execute in an
  [oubliette](https://github.com/davidlee/oubliette) room over pi-env. Commits
  return to a host quarantine for review in Emacs.

These are separate processes with separate SQLite stores. SATAN supplies the
persona, prompts and model-facing tools; Malebolge supplies the durable
harness and, for jobs, scheduling, policy enforcement and recovery.

## Why

- **It survives a restart.** Conversations are saved as they happen. The
  harness resumes interrupted turns; unsafe tool calls interrupted by a crash
  return an error rather than silently running again.
- **Attach from anywhere.** Several terminals and Emacs buffers can be
  attached at once, each to its own conversation or all to the same one.
- **The persona stays live.** The interactive daemon re-reads SATAN's persona
  on each request. Skills are listed at startup and their bodies read on use.
- **Jobs have bounds.** The runner checks mode scopes at admission, enforces
  per-job request, token, cost and active-time ceilings, and pauses through
  room outages within configured limits.
- **Changes need review.** The runner checks collected commits for ancestry
  and allowed paths. It never writes the real repository; a human promotes
  the reviewed commit to a branch from Emacs, then decides whether to merge.

This is personal infrastructure, coupled to my SATAN, oubliette and Nix
deployment. The reusable idea is a durable host-side agent loop with thin
clients and a separate execution environment.

## The picture

```
 terminal / Emacs ── attach ──▶ malebolge (interactive daemon, jailed)
                                ├─ many conversations (root by default)
                                ├─ live persona + skill listings
                                ├─ coding tools ─▶ the room (pi-env), or the host
                                ├─ SATAN tools ──▶ satan-mcp (Emacs)
                                └─ model ────────▶ LLM gateway

 Emacs patch_job_* ── RPC ────▶ satan-runner (host)
                                ├─ queue + per-job conversations
                                ├─ scopes, ceilings, recovery
                                ├─ model ────────▶ LLM gateway
                                └─ coding tools ─▶ oubliette room (pi-env)
                                                     │ commits
 real repo ◀── human promotion in Emacs ◀── host quarantine
```

Each daemon owns its store; clients use sockets rather than opening it.
Detaching an interactive client leaves its conversation running. The runner
keeps enforcing job limits with Emacs absent; Emacs remains the approval
surface. Patch jobs currently have coding tools, without the interactive
daemon's SATAN MCP tools or skills listing.

## Interactive conversations

You need Node 24 or later, Emacs, and a SATAN corpus. `satan-mcp` is
optional: without it the daemon runs with no SATAN tools and picks them up on
the next input once satan-mcp is up.

**Start** with `M-x malebolge-start` (load `emacs/malebolge.el` first). It
starts satan-mcp if satan is loaded, starts the `malebolge-room` systemd user
unit, and attaches in a comint buffer. `M-x malebolge-attach` re-attaches to
root on a running daemon. The unit is on demand — nothing starts it at
login — and is defined in ~/flakes (unit facts: `~/flakes/SATAN.md`). Logs:
`journalctl --user -u malebolge-room`.

**In a client:**

| Type | Effect |
|---|---|
| any text | talk to SATAN |
| `/abort` | stop the answer in progress |
| `/compact [instructions]` | summarise older history to free up the model's context |
| `/quit` | detach; its conversation keeps going |

### Emacs session

`M-x malebolge-start` (or `M-x malebolge-attach`) opens two buffers: the
read-only transcript `*malebolge*` and the draft `*malebolge-draft*`. You
type in the draft and only ever read the transcript.

| Key | Effect |
|---|---|
| `C-c C-c` | submit the draft as one message |
| `C-c C-a` | abort the run in progress |
| `C-c C-m` | compact, optionally with instructions |
| `C-c C-q` | quit: detach this client; the daemon keeps running |
| `C-c C-e` | focus the draft (also `RET` in the transcript) |
| `C-c C-h` | show the key summary |

The draft is ordinary text, so multi-line drafts submit as one message; RET
inserts a newline and paste keeps every line. Leading `/` is content, not a
command — only an all-whitespace draft is refused. A transcript window whose
point is at the end follows new output; after scrolling back it stays put,
and `M->` resumes following. `[tool]` and `[status]` lines are coloured
(`malebolge-tool-face`, `malebolge-status-face`).

**Which conversation.** The client sends its choice when it connects, and
prints `[attached to conversation N]` once the daemon accepts it; that `N` is
what `--conversation` takes. With no flag the client attaches to root, so a
plain `malebolge-attach` — and `just attach` — always reaches root, whatever a
listing below does or does not show. pi-durable's `ROOT_CONVERSATION_ID`
(id 1) is the explicit spelling of that root, for a caller that would rather
name it than rely on the default.

There are two ways to choose. `C-u M-x malebolge-attach` asks the daemon which
conversations this store holds, then prompts with those ids newest first, plus
`new`; the one you pick is the one it attaches to. In a terminal, or from a
script, ask for the list yourself and pass the id:

```sh
node src/attach-main.ts --list             # this store's ids, newest first
node src/attach-main.ts --conversation N   # conversation N
node src/attach-main.ts --new              # a new one, in the daemon's cwd
node src/attach-main.ts --new --cwd DIR    # a new one whose cwd is DIR
```

`--list` prints ids only, one per line, on standard output, and exits 0. It
takes `--topic NAME` or `--here` to narrow it, and nothing else: `--list` with
`--conversation`, `--new`, `--cwd` or `--emacs` is one usage line and exit 2,
before any connection is made. A
listing that fails — no daemon, one that predates `list` or topics, or a reply
that is not JSON — prints the client's error line and, for a daemon that
predates the feature, the restart hint; it exits 1, never a stack trace. Its connect budget is one second, not the
attach client's ten seconds: a listing runs against a daemon already up.

One page is **50 conversations**. When the store holds more, `--list` writes
one line to standard error — `the listing was truncated: older conversations
are not shown` — and the Emacs picker says the same in the minibuffer; standard
output stays ids only, because it is the picker's candidate list. A cut page
takes nothing away: an id you kept still attaches, and root is still reached by
a plain attach or by `ROOT_CONVERSATION_ID`. The picker waits five seconds for
the listing and then says so, rather than leaving the editor waiting silently.

`DIR` reaches the daemon uninterpreted, the empty string included, and becomes
the conversation's working directory: this profile's tools run there, so a
host path given to the `room` profile points inside the room. It overrides the
profile's default working directory (see
[Execution profiles](#execution-profiles)). A refused combination —
`--conversation` with `--new`, `--cwd` without `--new`, a `--conversation`
that is not a positive integer written without leading zeros, an unknown flag —
prints one line and the usage, and exits 2 before connecting. A refused attach — an unknown id, a
conversation a task owns — prints one error line and exits 1, and so does a
daemon that closes before attaching. An id names a conversation only inside
one profile's store and socket: keep the profile with any id you keep.

**Topics.** Every conversation is filed in one topic. A conversation created
with no topic named goes to `default`: it always exists, has no directory, and
cannot be created or given one. A topic exists once something wrote it, so
`--topic` names a topic somebody made, and attaching to one nobody wrote is
refused rather than silently starting a separate line of work.

```sh
node src/attach-main.ts --set-topic NAME               # create it, no directory
node src/attach-main.ts --set-topic NAME --dir DIR     # create it, or re-point it
node src/attach-main.ts --set-topic NAME --no-dir      # clear its directory
node src/attach-main.ts --topic NAME                   # its latest conversation
node src/attach-main.ts --topic NAME --new [--cwd DIR] # a fresh one in that topic
node src/attach-main.ts --topics                       # topics, one per line
node src/attach-main.ts --list --topic NAME            # that topic's ids
```

A name matches `[a-z0-9][a-z0-9._-]{0,63}`. `--set-topic` writes one record and
prints it; without `--dir` it leaves the directory as it was, and on a topic it
has to create, that means none. `--topics` prints `default` first, then the
rest by name, as `NAME<TAB>DIR`, the tab and empty directory included, so a
script can read it. A topic's directory is only a default: it reaches
conversations created in that topic afterwards, and a conversation already made
keeps the directory it was created with. `--topic NAME` binds the topic's
latest conversation (highest id), starts its first when it has none, and
`--new` always starts a fresh one. `--topics` takes no other flag, `--set-topic`
takes neither an attach nor a list flag, `--topic` and `--conversation` are
exclusive, and `--dir` and `--no-dir` are exclusive: each is one usage line and
exit 2. A refused topic — an unwritten name, a bad name, `default` written to, a
directory holding a tab, newline or other control character — is one error
line and exit 1.

`--here` stands where a topic's name would (`--topic`) or where a directory
would (`--set-topic --dir`). With `--set-topic` it writes this git root as the
topic's directory; otherwise it finds the one topic whose directory is exactly
this git root and names it — no match, or more than one, is one error line and
exit 1, because names are unique and directories are not. It is **host-only**:
the client asks the answering daemon which profile it runs under and refuses
anything but `host`. Topic directories are paths in the daemon's profile space,
and a room daemon's paths are not this shell's, so a `room` daemon's `--here`
would compare a host path with room paths and mean nothing. Nothing is created
by the lookup, including when it refuses. "Exactly" is string equality with the
git root as the shell resolves it — symlinks followed, no trailing slash — so a
directory written through a symlink or with a trailing `/` never matches;
`--set-topic NAME --here` writes one that does. An attach's lookup waits for a
starting daemon as the attach would (10 s); a listing's waits one second.

**Stop** with `M-x malebolge-stop`. Starting again reopens root; the profile's
other conversations stay in its store. `M-x malebolge-start` on a running unit
just attaches. Only one daemon per profile runs: a second daemon of the same
profile exits with `refusing to start: …`.

For development, `just daemon` and `just attach` in this repo run the daemon
and a terminal client from the working tree, with the environment described
under [Configuration](#configuration) (at least `MALEBOLGE_PROFILE`).
`just attach` stays on root; the flags above go through
`node src/attach-main.ts`. The attach client waits up to 10 s for the daemon
to start listening.

**After an upgrade, restart the daemon.** It is a long-lived user unit and
`malebolge-start` does not restart a running one, so a fresh client can meet
a daemon older than the frame it sent. That daemon answers in one of two ways:
`unknown message type "<frame>"`, naming a first-line frame it did not know
(`attach`, `list`, `topic`), or `<frame>: unknown key <key>`, refusing a key a
newer client added (`topic`, `topics`). Either way the client prints
`[the daemon predates <feature>: restart it (malebolge-stop, then malebolge-start)]`,
naming the frame or the key.
Restart the daemon (`M-x malebolge-stop`, then `M-x malebolge-start`) and the
same command works.

To run the daemon on the host, outside the jail:
`MALEBOLGE_PROFILE=host node src/daemon-main.ts`. It reaches models through
the LLM gateway, with a key read from a file.

### Execution profiles

The launcher picks where the agent's coding tools run, with
`MALEBOLGE_PROFILE`; there is no default.

| Profile | Tools run | Default working directory | Project context from |
|---|---|---|---|
| `room` | in the room VM, as the room user, over one pi-env connection the daemon holds | the room user's home | the home (no git walk) |
| `host` | on this machine | the launch directory | the launch directory up to its git root |

Each profile keeps its own store and socket, under `durable/<profile>/`,
holding that profile's conversations: the room's and the host's never mix. A
store or socket path in another profile's directory is refused at start.

The room profile reads its room from the **door file** (`MALEBOLGE_DOOR`), a
TOML file with one `[door]` table and nothing else:

```toml
[door]
room = "assistant"                 # the room's name (the ssh host)
user = "satan"                     # the room user
known_hosts = "/var/lib/capsule/room/assistant/known_hosts"
host_key_alias = "room-assistant"  # the name the host keys are stored under
identity = "~/.ssh/malebolge-vm.key"
home = "/home/satan"               # the tools' working directory
```

The daemon never starts the room. A room that is down or whose host key is
not trusted fails the tool call with `room unavailable: …` or
`room host key untrusted: …`; the conversation carries on and the next call
tries again. At start, an unreachable room means no project context, logged.

### Configuration

Set through environment variables:

| Variable | Purpose | Default |
|---|---|---|
| `MALEBOLGE_PROFILE` | execution profile, `room` or `host` (above) | required |
| `MALEBOLGE_DOOR` | the room's door file (room only) | required for `room` |
| `MALEBOLGE_SSH_CONFIG` | the ssh config the room is reached through (room only) | required for `room` |
| `MALEBOLGE_GATEWAY_SOCKET` | the LLM gateway's client socket (room only); start is refused if it is set and missing | none |
| `MALEBOLGE_MODEL` | model, as `provider/model` | `gateway/deepseek-flash` |
| `MALEBOLGE_GATEWAY_CATALOG` | gateway model catalog (JSON file) | `~/.config/malebolge/gateway-models.json` |
| `MALEBOLGE_GATEWAY_KEY_FILE` | file holding the daemon's gateway key (names a file; never carries the key) | `~/.config/llm-gateway/keys/malebolge` |
| `MALEBOLGE_SKILLS` | Agent Skill directories, `:`-separated, each holding a `SKILL.md`; use absolute paths; listed once at start, bodies read on use | none |
| `MALEBOLGE_SOCKET` | where clients attach (clients default to the room's) | `$XDG_RUNTIME_DIR/satan/durable/<profile>/durable.sock` |
| `SATAN_MCP_SOCKET` | where SATAN's tools are | `$XDG_RUNTIME_DIR/satan/mcp/mcp.sock` |
| `SATAN_CORPUS_ROOT` | SATAN's persona files | `~/satan-corpus` |
| `XDG_STATE_HOME` | saved conversations live at `satan/durable/<profile>/session.sqlite` under this | `~/.local/state` |

The gateway key is read from its file at start and held only in the provider;
it is never in the environment or on a command line.

The jailed launcher (`jailed-malebolge`, from satan's flake) runs the room
profile: no network, the room reached through its door socket and the gateway
through its client socket. It can write only under `durable/room/`, its own
persisted jail home and `/tmp`. The host profile has no jailed launcher.

## Patch jobs

SATAN submits jobs through `patch_job_create` in Emacs. A job names a
configured repository, a base branch, a directive and allowed paths. The
client stamps the acting mode; the runner refuses repositories or paths
outside that mode's configured scope. Lanes include `self-edit-mech`,
`self-edit-mind`, `tick-agent` and `interactive`; their deployment is configured
outside this repository. An unbounded mode still uses configured repos and
each job's path allowlist.

The runner refreshes the room clone from the host branch, runs the agent on
`job/<id>`, and collects committed work into quarantine. It checks every
commit between the base and collected tip, so reverting an out-of-scope edit
does not hide it. Uncommitted work does not travel. A ceiling or outage may
leave a partial result offered with a flag; passing these checks does not
establish that the code is correct.

Reviewable jobs appear in SATAN's Emacs inbox. At the entry, use
`M-x satan-patch-promote` or `M-x satan-patch-reject`. Promotion creates
`satan/patch/<id>` at the exact reviewed commit and is verified by the runner.
It does not merge the branch.

The deployed runner is a `satan-runner` user service configured by
`~/flakes/features/satan/runner.nix`. For development, `just runner` runs
`node src/runner-main.ts`; it requires the same room, gateway and config setup.

| Setting | Purpose |
|---|---|
| `SATAN_RUNNER_CONFIG` | required path to the runner's TOML config, read at startup |
| `XDG_RUNTIME_DIR` | required; control socket at `satan-runner/control.sock` |
| `XDG_STATE_HOME` | jobs, audit and conversations at `satan/runner/runner.sqlite`; defaults to `~/.local/state` |
| `CREDENTIALS_DIRECTORY` | systemd credential directory; `[gateway].credential` names the key file within it |

The TOML config names the prompt file, gateway catalog, room door, repos,
modes and policy ceilings. Missing or invalid configuration refuses startup.
The control socket is private to host clients and must stay outside jails.
The room has no uplink or provider credentials. Oubliette owns the room and
git transfer; the host LLM gateway owns provider credentials. The runner has
its own gateway credential and enforces job ceilings at the model boundary.

## Where it's going

The design lives in the SATAN repo. The two latest RFCs explain the direction;
both remain open, and some of their original sketches have since changed:

- [RFC-018: Durable SATAN and brokered authority](https://github.com/davidlee/SATAN/blob/main/.doctrine/rfc/018/rfc-018.md)
  proposes one persistent organism, with modes such as tick, morning and
  self-edit becoming events, and a microVM habitat with little authority
  outside it. Model access now goes through the host LLM gateway; patch jobs
  use oubliette's git channel and human promotion. A generic git-broker is
  not part of this implementation.
- [RFC-019: One Malebolge agent](https://github.com/davidlee/SATAN/blob/main/.doctrine/rfc/019/rfc-019.md)
  proposes shared agent composition with two execution modes: `vm`, living
  under `/home/agent`, and `patch`, working in a scoped `/work/<repo>` job.
  Coding tools would always run in the room; host data would be reached
  through scoped SATAN tools. Tools that do not need Emacs would move into
  native pi-durable tools, sequenced to avoid duplicate implementations.
  This does not yet settle whether the two processes should merge.

Today's split is the diagram above: interactive coding tools still run on
the host, while patch coding tools run in the room. Broker-driven tick and
morning runs have not become events in interactive conversations, and
patch jobs do not yet have SATAN's host-reading tools.

Recent slices supplied the runner and room integration (SL-023), skill
listings (SL-024), mode scopes (SL-025), and the coding layer (SL-026): project
instructions read from the execution environment, explicit working-directory
context, and a ripgrep-backed `grep` tool. SL-030 made the interactive daemon
hold many conversations, root by default, with the working directory per
conversation. Tool filtering, operation without Emacs, and a coding-agent
evaluation remain part of the wider RFC-019 work.

## Develop

```sh
npm install
just check        # lint, format check, typecheck, tests
```

Node 24+ runs the TypeScript directly; there is no TypeScript build step.
`nix build .#runner` packages `satan-runner` with its production dependencies;
the flake also exports `dev-tools` and a development shell. pi-durable and
pi-env are experimental and pinned to 1.3.0.

[docs/internals.md](docs/internals.md) covers the interactive daemon's wire
protocol and implementation details. SATAN's SL-023–SL-026 records and
SPEC-004 (patch runner) carry the cross-repository design.
