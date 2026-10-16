# pandaemonium

A durable home for interactive SATAN: a daemon that owns one
[pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable)
session, with SATAN's MCP tools and persona, served to any number of clients
over a unix socket.

Spike: satan `CHR-012`, feeding satan `RFC-018` ("Pi Durable as the harness").

```
pandaemonium (daemon, owns the session)                     clients
 ├─ Harness on SQLite  ~/.local/state/satan/durable/         pandaemonium-attach (terminal)
 ├─ persona section    ~/satan-corpus scaffold + interactive  M-x pandaemonium-attach (comint)
 ├─ CodingTools        read · write · edit · bash
 ├─ satan extension    pi-mcp client ──unix socket──▶ emacs satan-mcp
 └─ $XDG_RUNTIME_DIR/satan/durable.sock ◀──NDJSON──── clients
```

## Run

```sh
cd ~/notes && just hello-durable     # starts satan-mcp, then the daemon under `op run`
just attach-durable                  # in another terminal; or M-x pandaemonium-attach
```

In a client: type to talk, `/abort` stops the run, `/compact [instructions]`
compacts, `/quit` detaches. Detaching leaves the conversation running; the
next client gets the transcript so far.

Stop the daemon with Ctrl-C. Restarting it reopens the same conversation and
resumes any run it was in the middle of.

## Configuration (environment)

| Variable | Default |
|---|---|
| `PANDAEMONIUM_MODEL` | `deepseek/deepseek-flash` (`provider/model`) |
| `PANDAEMONIUM_SOCKET` | `$XDG_RUNTIME_DIR/satan/durable.sock` |
| `SATAN_MCP_SOCKET` | `$XDG_RUNTIME_DIR/satan/mcp/mcp.sock` |
| `SATAN_CORPUS_ROOT` | `~/satan-corpus` |
| `XDG_STATE_HOME` | `~/.local/state` (session at `satan/durable/session.sqlite`) |

The agent's coding tools work in the daemon's cwd. Provider keys come from the
environment (`DEEPSEEK_API_KEY`, …); `op run` resolves `op://` references.

## Protocol

One JSON message per line on the daemon socket.

- client → daemon: `{"type":"input","content":…,"requestId"?:…}`,
  `{"type":"abort"}`, `{"type":"compact","instructions"?:…}`
- daemon → client: pi-durable `watchEvents` agent events, first a `snapshot`;
  `{"type":"error","message":…}` for a line it could not act on.

## Develop

```sh
npm install
just check        # biome lint+format check, tsc, vitest
```

Node ≥ 24 runs the TypeScript directly (type stripping); nothing is built.

## Design notes

- **Not a pi coding-agent extension host.** pi-durable is a library with its
  own extension model (`defineExtension`/`defineTool`); it does not load
  `ExtensionAPI` extensions such as `~/notes/.pi/extensions/satan.ts`.
  `src/satan-tools.ts` is that extension's durable counterpart, built on
  pi-mcp with a unix-socket transport (`src/unix-socket-transport.ts`).
- **SATAN tools are not replay-safe.** A crash mid-call gives the model an
  `interrupted` error result instead of rerunning a side-effecting tool.
- **Persona is live.** The section re-reads the corpus files on each request;
  the harness resends only changed sections, so prompt caching survives.
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
