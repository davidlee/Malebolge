#!/usr/bin/env node
// pandaemonium: own SATAN's durable interactive session and serve it on a socket.

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

const log = (text: string) => process.stderr.write(`pandaemonium: ${text}\n`);

const config = resolveConfig(process.env, process.cwd());
const models = createDaemonModels(readModelsStore(config.modelsStorePath));
const { provider, modelId } = config.model;
if (!models.getModelOfType("chat", provider, modelId)) {
  throw new Error(`unknown model ${provider}/${modelId}`);
}

const satan = await connectSatanTools(config.mcpSocket).catch((error) => {
  throw new Error(`satan-mcp not reachable at ${config.mcpSocket} (satan-mcp-start?): ${error}`);
});
satan.client.onClose(() => log("satan-mcp connection closed; SATAN tools will fail"));

mkdirSync(dirname(config.storagePath), { recursive: true });
mkdirSync(dirname(config.daemonSocket), { recursive: true });
const session = await openSession(await openNodeSqliteStorage(config.storagePath), {
  models,
  extensions: [personaExtension(personaFiles(config.corpusRoot)), CodingTools, satan.extension],
  agent: { model: config.model, cwd: config.cwd },
});
const daemon = await serve(session.harness, session.root, config.daemonSocket);
log(`${provider}/${modelId} · ${satan.extension.tools?.length ?? 0} SATAN tools`);
log(`session ${config.storagePath}`);
log(`attach  ${config.daemonSocket}`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await daemon.close();
  await session.harness.close(context);
  await satan.client.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
