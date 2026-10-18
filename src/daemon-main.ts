#!/usr/bin/env node
// malebolge: own SATAN's durable interactive session and serve it on a socket.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { resolveConfig } from "./config.ts";
import { context } from "./context.ts";
import { serve } from "./daemon.ts";
import { createDaemonModels, readModelsStore } from "./models.ts";
import { personaExtension, personaFiles } from "./persona.ts";
import { connectSatanTools } from "./satan-tools.ts";
import { openSession } from "./session.ts";

const log = (text: string): boolean => process.stderr.write(`malebolge: ${text}\n`);

const config = resolveConfig(process.env, process.cwd());
const models = createDaemonModels(readModelsStore(config.modelsStorePath));
const { provider, modelId } = config.model;
if (models.getModelOfType("chat", provider, modelId) === undefined) {
  throw new Error(`unknown model ${provider}/${modelId}`);
}

const satan = await connectSatanTools(config.mcpSocket, log).catch((error: unknown) => {
  throw new Error(
    `satan-mcp not reachable at ${config.mcpSocket} (satan-mcp-start?): ${String(error)}`,
  );
});

mkdirSync(dirname(config.storagePath), { recursive: true });
mkdirSync(dirname(config.daemonSocket), { recursive: true });
const session = await openSession(await openNodeSqliteStorage(config.storagePath), {
  models,
  extensions: [personaExtension(personaFiles(config.corpusRoot)), CodingTools, satan.extension],
  agent: { model: config.model, cwd: config.cwd },
});
const daemon = await serve(session.harness, session.root, config.daemonSocket);
log(`${provider}/${modelId} · ${String(satan.extension.tools?.length ?? 0)} SATAN tools`);
log(`session ${config.storagePath}`);
log(`attach  ${config.daemonSocket}`);

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) {
    return;
  }
  stopping = true;
  await daemon.close();
  await session.harness.close(context);
  await satan.close();
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
