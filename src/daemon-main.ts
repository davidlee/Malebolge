#!/usr/bin/env node
// malebolge: own SATAN's durable interactive session and serve it on a socket.

import { readFileSync } from "node:fs";
import { resolveConfig } from "./config.ts";
import { type DaemonHandle, startDaemon } from "./daemon-start.ts";
import { InstanceLocked } from "./instance-lock.ts";
import { SocketInUse } from "./unix-socket.ts";

const log = (text: string): void => {
  process.stderr.write(`malebolge: ${text}\n`);
};

const config = resolveConfig(process.env, process.cwd(), (path) => readFileSync(path, "utf8"));
let handle: DaemonHandle;
try {
  handle = await startDaemon(config, { log });
} catch (error) {
  if (!(error instanceof InstanceLocked) && !(error instanceof SocketInUse)) {
    throw error;
  }
  log(`refusing to start: ${error.message}`);
  process.exit(1);
}
const { provider, modelId } = handle.model;
log(
  `${provider}/${modelId} · ${String(handle.satanTools)} SATAN tools · ${String(handle.mailTools)} mail tools · ${String(handle.skills)} skills · ${handle.hasProjectContext ? "" : "no "}project context`,
);
log(`profile ${handle.profile} · cwd ${handle.cwd}`);
log(`session ${handle.storagePath}`);
log(`attach  ${handle.daemonSocket}`);

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) {
    return;
  }
  stopping = true;
  await handle.stop();
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
