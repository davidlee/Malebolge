Basis: `~/flakes/agents/jailed-agents.nix:105` ships `libnotify` in the jail,
but the file shows no bind of the D-Bus session socket and no
`DBUS_SESSION_BUS_ADDRESS` forward; only `XDG_RUNTIME_DIR` and the satan-mcp
directory are passed (`:171-174`). Staged copy:
`.doctrine/state/slice/009/research-context/jailed-agents.nix`.

From the operator, 2026-10-29: "a connect failure should fail loud (with a
notify-send naming both ends, if known)".

## Invalidation (2026-10-29)

Probed by the operator in a real pi jail, 2026-10-29 (SL-009 PHASE-01 VH-1; kit `.doctrine/slice/009/probes/vh1/sl009-probe/`, runbook in SL-009 notes.md § Probes). `notify-send sl009 "jail probe"` exited 1; glib could not read
`…/glib-2.88.3/var/lib/dbus/machine-id` (no D-Bus session bus in the jail).
Accepted by DEC-073: the loud floor is ctx.ui.notify and stderr, and
notify-send stays best-effort (DEC-075). A desktop notification from the jail
would need a filtered D-Bus proxy (CHR-007 option), not the raw session bus.
No design change.
