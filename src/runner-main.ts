#!/usr/bin/env node
// satan-runner: own patch jobs and serve the control socket (design §5.2).
// Refuses to start, exiting 1, on missing or invalid config or prompt file (I13).

import { StartRefused } from "./runner/errors.ts";
import { type Runner, startRunner } from "./runner/start.ts";

const log = (text: string): void => {
  process.stderr.write(`satan-runner: ${text}\n`);
};

let runner: Runner;
try {
  runner = await startRunner(process.env, { log });
} catch (error) {
  if (!(error instanceof StartRefused)) {
    throw error;
  }
  log(`refusing to start: ${error.message}`);
  process.exit(1);
}
log(`store   ${runner.paths.store}`);
log(`control ${runner.paths.socket}`);

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) {
    return;
  }
  stopping = true;
  await runner.close();
  process.exit(0);
};
/** Signal handlers return nothing, so a failed stop is reported here. */
const stopOnSignal = (): void => {
  stop().catch((error: unknown) => {
    log(`stop failed: ${String(error)}`);
    process.exit(1);
  });
};
process.on("SIGINT", stopOnSignal);
process.on("SIGTERM", stopOnSignal);
