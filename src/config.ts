// Where things live, resolved from the environment. Mirrors SATAN's roots
// (satan-custom.el): corpus under ~/satan-corpus, runtime state under
// $XDG_STATE_HOME/satan, sockets under $XDG_RUNTIME_DIR/satan.

import { join } from "node:path";

export interface ModelRef {
  provider: string;
  modelId: string;
}

export interface Config {
  corpusRoot: string;
  storagePath: string;
  mcpSocket: string;
  daemonSocket: string;
  model: ModelRef;
  /** The coding agent's cache of its remote model catalog (see models.ts). */
  modelsStorePath: string;
  /** Working directory of the agent's coding tools. */
  cwd: string;
}

type Env = Readonly<Record<string, string | undefined>>;

export const DEFAULT_MODEL = "deepseek/deepseek-flash";

export function parseModel(ref: string): ModelRef {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    throw new Error(`model must be provider/model, got ${JSON.stringify(ref)}`);
  }
  return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set`);
  }
  return value;
}

/** The daemon socket clients attach to; needs no more environment than a client has. */
export const daemonSocket = (env: Env): string =>
  env["MALEBOLGE_SOCKET"] ?? join(required(env, "XDG_RUNTIME_DIR"), "satan", "durable.sock");

export function resolveConfig(env: Env, cwd: string): Config {
  const home = required(env, "HOME");
  const stateRoot = join(env["XDG_STATE_HOME"] ?? join(home, ".local", "state"), "satan");
  const runtime = join(required(env, "XDG_RUNTIME_DIR"), "satan");
  return {
    corpusRoot: env["SATAN_CORPUS_ROOT"] ?? join(home, "satan-corpus"),
    storagePath: join(stateRoot, "durable", "session.sqlite"),
    mcpSocket: env["SATAN_MCP_SOCKET"] ?? join(runtime, "mcp", "mcp.sock"),
    daemonSocket: daemonSocket(env),
    model: parseModel(env["MALEBOLGE_MODEL"] ?? DEFAULT_MODEL),
    modelsStorePath: join(home, ".pi", "agent", "models-store.json"),
    cwd,
  };
}
