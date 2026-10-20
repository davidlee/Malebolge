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

- **`malebolge`**, the interactive daemon. It holds one ongoing conversation;
  terminal and Emacs clients attach, talk and detach. Several clients can
  share it, and a new client sees the conversation so far.
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
  attached at once, all in the same conversation.
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
                                ├─ one durable conversation
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
Detaching an interactive client leaves the conversation running. The runner
keeps enforcing job limits with Emacs absent; Emacs remains the approval
surface. Patch jobs currently have coding tools, without the interactive
daemon's SATAN MCP tools or skills listing.

## Interactive conversation

You need Node 24 or later and a working SATAN setup (Emacs with `satan-mcp`,
and a corpus).

**Start the daemon** (it starts satan-mcp in Emacs first):

```sh
cd ~/notes && just hello-durable
```

**Attach**, from another terminal or from Emacs:

```sh
cd ~/notes && just attach-durable
```

```
M-x malebolge-attach      ; load emacs/malebolge.el first
```

**In a client:**

| Type | Effect |
|---|---|
| any text | talk to SATAN |
| `/abort` | stop the answer in progress |
| `/compact [instructions]` | summarise older history to free up the model's context |
| `/quit` | detach; the conversation keeps going |

**Stop the daemon** with Ctrl-C. Starting it again reopens the same
conversation.

To run the daemon on the host, outside the jail:
`MALEBOLGE_PROFILE=host node src/daemon-main.ts`. It reaches models through
the LLM gateway, with a key read from a file.

### Execution profiles

The launcher picks where the agent's coding tools run, with
`MALEBOLGE_PROFILE`; there is no default.

| Profile | Tools run | Working directory | Project context from |
|---|---|---|---|
| `room` | in the room VM, as the room user, over one pi-env connection the daemon holds | the room user's home | the home (no git walk) |
| `host` | on this machine | the launch directory | the launch directory up to its git root |

Each profile keeps its own conversation and socket, under
`durable/<profile>/`: the room's and the host's conversations never mix. A
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
| `XDG_STATE_HOME` | saved conversation lives at `satan/durable/<profile>/session.sqlite` under this | `~/.local/state` |

The gateway key is read from its file at start and held only in the provider;
it is never in the environment or on a command line.

The jailed launcher (`jailed-malebolge`, from satan's flake) runs the room
profile: no network, the room reached through its door socket and the gateway
through its client socket, and writes only under `durable/room/`. The host
profile has no jailed launcher.

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
morning runs have not become events in the interactive conversation, and
patch jobs do not yet have SATAN's host-reading tools.

Recent slices supplied the runner and room integration (SL-023), skill
listings (SL-024), and mode scopes (SL-025). SL-026 has designed the next coding
layer: project instructions read from the execution environment, explicit
working-directory context, and a ripgrep-backed `grep` tool. Those additions
are not implemented in this checkout yet. Tool filtering, operation without
Emacs, and a coding-agent evaluation remain part of the wider RFC-019 work.

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
