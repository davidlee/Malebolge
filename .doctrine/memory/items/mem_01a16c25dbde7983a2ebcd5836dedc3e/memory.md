`daemonCommand` (`src/room/connection.ts:227-240`) calls pi-env's `deployDaemon`
on every start. `deployDaemon` (`~/.local/src/pi/packages/env/src/ssh.ts:405-435`)
uploads the binary bundled in the host's `pi-env` package, names it by sha256,
then **deletes every other `pi-env-*` binary** in that directory. A daemon that
is already running stays up until it exits.

Bundled binaries differ between releases even when pi-env's source does not:
1.3.0 → 1.4.0 changed only a test, yet `bin/pi-env-linux-x64` went from
`145eacb3…` to `46dde0e2…` (checked 2026-10-24 with `npm pack`).

Why it matters: the flake-pinned runner and the live-tree daemon share a room
(satan RSK-020). While their pi-env versions differ, each start deletes the
other's binary and the other re-uploads at its next start. That is churn, not
breakage. Move the runner's pin in the same rollout as any pi-env bump
(CHR-002).
