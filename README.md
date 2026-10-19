# Malebolge

![bridges](./assets/wall.jpg)

A place for a conversation with [SATAN](https://github.com/davidlee/SATAN) to
live, so it outlasts the terminal or Emacs buffer you started it in.

## What it's for

SATAN is a personal agent: it knows my notes and recent activity, and talks
through Emacs. Talking to it interactively used to tie the conversation to one
window. Close the window, restart Emacs, or crash, and the conversation was
gone.

Malebolge is a small background process (a daemon) that holds one ongoing
conversation with SATAN. You attach to it from a terminal or Emacs, talk, and
detach. The conversation carries on without you, and whoever attaches next
sees it so far.

## Why

- **It doesn't forget.** The conversation is saved to disk as it happens.
  Restart the daemon and it picks up where it was, even halfway through an
  answer.
- **Attach from anywhere.** Several terminals and Emacs buffers can be
  attached at once, all in the same conversation.
- **SATAN wears many faces.** Whatever the harness, it still has the same motives, persona, and tools.
  Here, edits to the persona apply from the next message, with no restart.
- **It's fenced in.** The daemon runs in a jail, enforcing policy about what it can read and edit.

If you're not me, this is mostly of interest as a small example of
keeping an LLM session alive behind a socket, using
[pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable).

## The picture

```
  you                          malebolge (daemon)
 ─────                        ─────────────────────────────────
  terminal ──┐                 one conversation, saved to disk
             ├── attach ────▶  SATAN's persona   (~/satan-corpus)
                               skills            SKILL.md listings ($MALEBOLGE_SKILLS)
  Emacs ─────┘   detach        coding tools      read/write/edit/bash
                               SATAN's tools ──────────▶ satan-mcp (in Emacs)
                               model ──────────────────▶ LLM provider
```

Clients only display and send; the daemon does all the work and holds all the
state. Detaching a client changes nothing else.

## How to use it

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

To run the daemon on the host, outside the jail: `node src/daemon-main.ts`.
It reaches models through the LLM gateway, with a key read from a file.

### Configuration

Set through environment variables:

| Variable | Purpose | Default |
|---|---|---|
| `MALEBOLGE_MODEL` | model, as `provider/model` | `gateway/deepseek-flash` |
| `MALEBOLGE_GATEWAY_CATALOG` | gateway model catalog (JSON file) | `~/.config/malebolge/gateway-models.json` |
| `MALEBOLGE_GATEWAY_KEY_FILE` | file holding the daemon's gateway key (names a file; never carries the key) | `~/.config/llm-gateway/keys/malebolge` |
| `MALEBOLGE_SKILLS` | Agent Skill directories, `:`-separated, each holding a `SKILL.md`; use absolute paths; listed once at start, bodies read on use | none |
| `MALEBOLGE_SOCKET` | where clients attach | `$XDG_RUNTIME_DIR/satan/durable.sock` |
| `SATAN_MCP_SOCKET` | where SATAN's tools are | `$XDG_RUNTIME_DIR/satan/mcp/mcp.sock` |
| `SATAN_CORPUS_ROOT` | SATAN's persona files | `~/satan-corpus` |
| `XDG_STATE_HOME` | saved conversation lives at `satan/durable/session.sqlite` under this | `~/.local/state` |

The gateway key is read from its file at start and held only in the provider;
it is never in the environment or on a command line. The coding tools work in
the daemon's current directory.

## Develop

```sh
npm install
just check        # lint, format check, typecheck, tests
```

Node runs the TypeScript directly; there is no build step. How it works
inside — the wire protocol, the jail, design decisions — is in
[docs/internals.md](docs/internals.md).
