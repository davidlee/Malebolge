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
