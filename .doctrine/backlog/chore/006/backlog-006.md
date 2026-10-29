# CHR-006: Roll out bookmark backups: MALEBOLGE_BOOKMARK_BACKUPS and a read-only jail bind in ~/flakes

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

From SL-008 (DEC-052, DEC-055). Operator's change, outside this repo.

- `~/flakes`: set `MALEBOLGE_BOOKMARK_BACKUPS` to the absolute
  `~/.config/mozilla/firefox/ez06zp0k.default/bookmarkbackups` (Firefox's
  profile moved under XDG_CONFIG_HOME with a recent Home Manager update).
- `~/dev/satan/flake.nix` `mkJailedMalebolge`: read-only bind of that
  directory only — never the profile (history, logins.json, key4.db).
- Then SL-008's VH: ask the Kegan question in an interactive conversation.

## As made (SL-008 reconcile, RV-024 F-2, 2026-10-29)

The split differs from the steps above: satan's `mkJailedMalebolge` takes an
optional `bookmarkBackups` path and does both — sets
`MALEBOLGE_BOOKMARK_BACKUPS` inside the jail and binds only that directory
read-only (the jail sets the daemon's env). `~/flakes`
(`features/satan/malebolge.nix`) passes the absolute path.

- satan 95e40a8 (pushed); ~/flakes 08c0f37d. Deployed on Sleipnir via the
  dev-checkout override + room restart; VH-1 passed.
- Remaining operator act: `nix flake update satan` in ~/flakes — the lock
  still pins satan cacfd5d, so a non-override switch drops the bind. Then
  close this item.
