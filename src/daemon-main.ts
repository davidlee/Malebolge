#!/usr/bin/env node
// malebolge: own SATAN's durable interactive session and serve it on a socket.

import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { resolveConfig } from "./config.ts";
import { context } from "./context.ts";
import { daemonEnv, requireGatewaySocket } from "./daemon-env.ts";
import { daemonExtensions } from "./daemon-extensions.ts";
import { serve } from "./daemon.ts";
import { loadGatewayModels } from "./models.ts";
import { personaFiles } from "./persona.ts";
import { renderProjectContext } from "./project-context.ts";
import { connectSatanTools } from "./satan-tools.ts";
import { openSession } from "./session.ts";
import { loadSkills } from "./skills.ts";

const log = (text: string): boolean => process.stderr.write(`malebolge: ${text}\n`);

const config = resolveConfig(process.env, process.cwd(), (path) => readFileSync(path, "utf8"));
const persona = personaFiles(config.corpusRoot, config.execution.profile);
const skills = loadSkills(config.skillDirs, log);
requireGatewaySocket(config.execution);
const environment = daemonEnv(config.execution, log);
// Read once: a context file edit takes a restart.
const projectContext = renderProjectContext(await environment.readContext());
const models = await loadGatewayModels(config.gatewayCatalog, config.gatewayKeyFile);
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
  extensions: daemonExtensions({
    personaFiles: persona,
    projectContext,
    skills,
    cwd: environment.cwd,
    satan: satan.extension,
  }),
  agent: { model: config.model, cwd: environment.cwd },
  env: environment.env,
});
const daemon = await serve(session.harness, session.root, config.daemonSocket);
log(
  `${provider}/${modelId} · ${String(satan.extension.tools?.length ?? 0)} SATAN tools · ${String(skills.length)} skills · ${projectContext === undefined ? "no " : ""}project context`,
);
log(`profile ${config.execution.profile} · cwd ${environment.cwd}`);
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
  environment.close();
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
