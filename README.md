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

**Which conversation.** The client sends its choice when it connects, and
prints `[attached to conversation N]` once the daemon accepts it; that `N` is
what `--conversation` takes. With no flag the client attaches to root. The
flags go to the program directly — `just attach` and `M-x malebolge-attach`
accept none, so both stay on root:

```sh
node src/attach-main.ts --conversation N   # conversation N
node src/attach-main.ts --new              # a new one, in the daemon's cwd
node src/attach-main.ts --new --cwd DIR    # a new one whose cwd is DIR
```

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
a daemon older than its attach frame. That daemon answers `unknown message
type "attach"` and the client prints
`[the daemon predates attach: restart it (malebolge-stop, then malebolge-start)]`.
Restart the daemon (`M-x malebolge-stop`, then `M-x malebolge-start`) to
attach again.

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
