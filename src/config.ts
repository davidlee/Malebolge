// Where things live, resolved from the environment. Mirrors SATAN's roots
// (satan-custom.el): corpus under ~/satan-corpus, runtime state under
// $XDG_STATE_HOME/satan, sockets under $XDG_RUNTIME_DIR/satan.

import { join } from "node:path";
import { DEFAULT_MODEL, type ModelRef, parseModel } from "./models.ts";

export interface Config {
  corpusRoot: string;
  storagePath: string;
  mcpSocket: string;
  daemonSocket: string;
  model: ModelRef;
  /** The gateway model catalog file `~/flakes` renders (see models.ts). */
  gatewayCatalog: string;
  /** The file holding this daemon's gateway key; the key itself is never in the environment. */
  gatewayKeyFile: string;
  /** Agent Skill directories (each holds a SKILL.md), from MALEBOLGE_SKILLS. */
  skillDirs: string[];
  /** Working directory of the agent's coding tools. */
  cwd: string;
}

type Env = Readonly<Record<string, string | undefined>>;

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
    gatewayCatalog:
      env["MALEBOLGE_GATEWAY_CATALOG"] ?? join(home, ".config", "malebolge", "gateway-models.json"),
    gatewayKeyFile:
      env["MALEBOLGE_GATEWAY_KEY_FILE"] ??
      join(home, ".config", "llm-gateway", "keys", "malebolge"),
    skillDirs: (env["MALEBOLGE_SKILLS"] ?? "").split(":").filter((dir) => dir !== ""),
    cwd,
  };
}
