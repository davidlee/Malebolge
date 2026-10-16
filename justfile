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
