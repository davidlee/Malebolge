# CHR-007: Roll out the bridge deployment contract in ~/flakes: socket dir and extension ro-binds, env, read-only project mount

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

From SL-009 (DEC-074; DEC-064, DEC-073, DEC-075). Operator's change, outside
this repo; malebolge owns the contract, ~/flakes implements it, and the satan
launcher is unchanged.

The pi jail combinator in `~/flakes/agents/jailed-agents.nix`:

1. **Socket directory, read-only.** Create
   `/run/user/1000/satan/durable/room/bridge` on the host before a pi jail
   starts, and ro-bind that directory only — never its parent, which holds
   `durable.sock` (DEC-064). The daemon serves `bridge.sock` inside it.
2. **Extension mount, read-only.** ro-bind this repo's `pi-bridge/` at
   `~/.pi/agent/extensions/malebolge-bridge` in the jail home (DEC-073).
3. **Env.** Forward `MALEBOLGE_BRIDGE_SOCKET` when set (DEC-064); the
   extension sets `MALEBOLGE_BRIDGE_CONVERSATION` and `MALEBOLGE_BRIDGE_TOKEN`
   for pi's commands itself (DEC-075).
4. **Read-only project mount option.** An option to bind the project with
   `--ro-bind` instead of read-write (DEC-074 (4)).

Optional, only if the operator wants desktop notifications from the jail: bind
the D-Bus session socket (see the notify-send ASM).

## Done (2026-10-30)

~/flakes 311a0c27, `agents/jailed-agents.nix` `piBridgeOptions`, applied
wherever pi is in the jail (agent or subagent):

1. `(umask 077 && mkdir -p /run/user/1000/satan/durable/room/bridge)` on the
   host before launch, then `--ro-bind-try` that directory only.
2. `MALEBOLGE_BRIDGE_SOCKET` forwarded when set; `XDG_RUNTIME_DIR` too, since
   `bridgeSocketPath` derives the default from it and throws without it.
3. `--ro-bind-try "$HOME/dev/malebolge/pi-bridge"` at
   `~/.pi/agent/extensions/malebolge-bridge`, after the persisted-home bind.
4. `makeJailedAgent { readOnlyLaunchDir = true; }` binds the project with
   `--ro-bind`; no jail uses it yet.

Tests in `agents/jailed-agents-test.nix` (launched argv under a fake bwrap;
none of it in non-pi jails); `just gate` green.

Rollout (operator): push nix-config, then update the `agents` input in each
project whose pi jail should pair (`nix flake update agents`).
