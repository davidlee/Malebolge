# Malebolge internals

Notes for working on Malebolge. The [README](../README.md) covers what it is
and how to run it.

Origin: spike satan `CHR-012`, feeding satan `RFC-018` ("Pi Durable as the
harness").

## Components

```
malebolge (daemon, owns the session)                     clients
 ├─ Harness on SQLite  ~/.local/state/satan/durable/         malebolge-attach (terminal)
 ├─ persona section    ~/satan-corpus scaffold + interactive  M-x malebolge-attach (comint)
 ├─ skills section     SKILL.md listings from $MALEBOLGE_SKILLS
 ├─ CodingTools        read · write · edit · bash
 ├─ satan extension    pi-mcp client ──unix socket──▶ emacs satan-mcp
 └─ $XDG_RUNTIME_DIR/satan/durable.sock ◀──NDJSON──── clients
```

## Jail

The daemon runs in `jailed-malebolge` (`~/dev/satan/flake.nix`), started by
`just hello-durable` in `~/notes`. The jail sees this repo read-only,
`~/satan-corpus` read-only (its `goad/` read-write), the session store, and
`$XDG_RUNTIME_DIR/satan/`. Its only secret is the gateway key file, bound
read-only with the catalog; `MALEBOLGE_GATEWAY_KEY_FILE` and
`MALEBOLGE_GATEWAY_CATALOG` point at them. No provider keys, no `op run`.

## Protocol

One JSON message per line on the daemon socket.

- client → daemon: `{"type":"input","content":…,"requestId"?:…}`,
  `{"type":"abort"}`, `{"type":"compact","instructions"?:…}`
- daemon → client: pi-durable `watchEvents` agent events, first a `snapshot`;
  `{"type":"error","message":…}` for a line it could not act on.

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
  retried. The tool list is the one satan-mcp offered at daemon start.
- **Persona is live.** The section re-reads the corpus files on each request;
  the harness resends only changed sections, so prompt caching survives.
- **Skills are read once.** `$MALEBOLGE_SKILLS` directories are loaded and
  parsed at daemon start (DEC-067); the section then renders a constant. Bad
  or missing entries are logged `skill <dir>: <reason>` and dropped, never
  fatal. Editing a skill needs a daemon restart. Wording and rules follow
  pi 1.3.0's `formatSkillsForPrompt`.
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
