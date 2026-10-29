The room daemon runs in `jailed-malebolge` (`~/dev/satan/flake.nix` `mkJailedMalebolge`). The jail sets the daemon's environment itself with `set-env` and binds host-absolute paths with `readonly` / `readwrite`. A systemd `Environment=` line in `~/flakes/features/satan/malebolge.nix` does not reach the daemon.

Pattern for a new daemon env var / bind (screwtape SL-005, bookmarks SL-008):
- satan: a `<thing>JailOptions` helper (`set-env` + bind) and an argument to `mkJailedMalebolge`; keep it optional (`? null`) so `jailed-malebolge-probe` still builds.
- ~/flakes: pass the value in the `mkJailedMalebolge { … }` call, so the value has one author.

Deploy: `just home-switch` in `~/flakes`, which applies `bin/dev-checkouts override` (it overrides `satan` with the local checkout, `git+file`, tracked files including uncommitted edits), then `systemctl --user restart malebolge-room` (X-RestartIfChanged=false). A plain `home-manager switch`, or another machine, uses the satan rev pinned in ~/flakes' flake.lock. It fails (`unexpected argument`) until satan is pushed and `nix flake update satan` is run.
