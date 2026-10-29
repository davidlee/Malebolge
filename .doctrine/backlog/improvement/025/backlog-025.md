# IMP-025: Desktop notifications from pi jails through an xdg-dbus-proxy filtered to org.freedesktop.Notifications

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

From SL-009 PHASE-01 VH-1 (2026-10-29): `notify-send` inside a pi jail exits 1
— no D-Bus session bus (glib cannot read `var/lib/dbus/machine-id`). ASM-005
invalidated; accepted by DEC-073 (floor: `ctx.ui.notify` and stderr), so
malebolge-bridge's notify-send stays best-effort (DEC-075).

If the operator wants desktop notifications from jails: run `xdg-dbus-proxy`
on the host with `--filter --talk=org.freedesktop.Notifications` and bind only
the proxy socket into the jail, setting `DBUS_SESSION_BUS_ADDRESS` to it (and
a `machine-id` if glib still asks). Never bind the raw session bus: it reaches
systemd --user and the secrets service. ~/flakes work
(`agents/jailed-agents.nix`), alongside CHR-007's bridge contract.
