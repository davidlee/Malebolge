# lint + typecheck + test
check: lint typecheck test

lint:
  npx biome check .

typecheck:
  npx tsc --noEmit

test:
  npx vitest run

format:
  npx biome format --write .

# Run the daemon (owns the durable session).
daemon:
  node src/daemon-main.ts

# Attach a terminal client to the running daemon.
attach:
  node src/attach-main.ts

# PHASE-01 live spike: stop the slot at the IN FLIGHT marker (`capsule <slot> stop`).
# Results land in spike-results/room-stop-*.json.
spike-room-stop slot="f" identity=(env_var("HOME") + "/.ssh/id"):
  MALEBOLGE_LIVE_SLOT={{slot}} SPIKE_IDENTITY={{identity}} node test/runner/room-stop-spike.ts
