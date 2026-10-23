# format check + lint + typecheck + test (with coverage gate)
check: fmt-check lint typecheck test

# Biome is the formatter only; lint is typescript-eslint (IMP-041).
fmt-check:
  npx biome format .

lint:
  npx eslint . --max-warnings 0

typecheck:
  npx tsc --noEmit

test:
  npx vitest run

# Emacs ERT suite and byte-compile (needs emacs; kept out of `check`).
ert:
  emacs --batch -Q -L emacs -l ert -l test/malebolge-ert.el -f ert-run-tests-batch-and-exit
  emacs --batch -Q -L emacs --eval '(setq byte-compile-error-on-warn t)' -f batch-byte-compile emacs/malebolge.el
  rm -f emacs/malebolge.elc

format:
  npx biome format --write .

# Run the daemon (owns the durable session). satan-mcp is optional: without
# it the daemon starts with no SATAN tools.
daemon:
  -emacsclient -e "(satan-mcp-start)"
  node src/daemon-main.ts

# Run the patch-job runner (config path from $SATAN_RUNNER_CONFIG).
runner:
  node src/runner-main.ts

# Attach a terminal client to the running daemon.
attach:
  node src/attach-main.ts

# PHASE-01 live spike: stop the slot at the IN FLIGHT marker (`capsule <slot> stop`).
# Results land in spike-results/room-stop-*.json.
spike-room-stop slot="f" identity=(env_var("HOME") + "/.ssh/id"):
  MALEBOLGE_LIVE_SLOT={{slot}} SPIKE_IDENTITY={{identity}} node test/runner/room-stop-spike.ts

# SL-023 PHASE-12 live smoke (EX-6, EX-10a): one job on goad-walk through the
# deployed runner to needs_review; never promoted or rejected. `--slow` for the
# room-stop reconnect. Needs SATAN_RUNNER_LIVE=1.
smoke-runner *args:
  node test/runner/live-smoke.ts {{args}}

# SL-023 PHASE-12 EX-10c: a scratch runner with a tampered known_hosts fails
# host_key. Stop the deployed runner first. Needs SATAN_RUNNER_LIVE=1.
smoke-runner-host-key:
  node test/runner/live-host-key.ts
