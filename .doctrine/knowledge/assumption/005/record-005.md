Basis: `~/flakes/agents/jailed-agents.nix:105` ships `libnotify` in the jail,
but the file shows no bind of the D-Bus session socket and no
`DBUS_SESSION_BUS_ADDRESS` forward; only `XDG_RUNTIME_DIR` and the satan-mcp
directory are passed (`:171-174`). Staged copy:
`.doctrine/state/slice/009/research-context/jailed-agents.nix`.

From the operator, 2026-10-29: "a connect failure should fail loud (with a
notify-send naming both ends, if known)".
