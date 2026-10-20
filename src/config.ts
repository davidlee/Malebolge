// Where things live, resolved from the environment. Mirrors SATAN's roots
// (satan-custom.el): corpus under ~/satan-corpus, runtime state under
// $XDG_STATE_HOME/satan, sockets under $XDG_RUNTIME_DIR/satan. The launcher
// picks the execution profile; the store and socket are the profile's
// (design §4.2, DEC-077, DEC-078).

import { basename, dirname, join } from "node:path";
import {
  onlyKeys,
  optionalRecord,
  parseToml,
  required,
  requireString,
  setDefined,
  within,
} from "./fields.ts";
import { DEFAULT_MODEL, type ModelRef, parseModel } from "./models.ts";
import type { RoomConnection } from "./room/connection.ts";
import { readRoomDoor, ROOM_DOOR_KEYS, type RoomDoor, roomConnectionOf } from "./room/door.ts";

export type Profile = "room" | "host";

/** Where the agent's coding tools run. */
export type Execution =
  | { profile: "host"; cwd: string }
  | {
      profile: "room";
      room: RoomConnection;
      /** The room user's home: the tools' cwd in the room. */
      home: string;
      /** The gateway client socket the jail binds (§4.4). */
      gatewaySocket?: string;
    };

export interface Config {
  corpusRoot: string;
  /** `<state>/satan/durable/<profile>/session.sqlite` */
  storagePath: string;
  /** `daemon.lock` beside the store: one daemon per profile (DEC-087). */
  lockPath: string;
  mcpSocket: string;
  /** `$MALEBOLGE_SOCKET` or `<runtime>/satan/durable/<profile>/durable.sock` */
  daemonSocket: string;
  model: ModelRef;
  /** The gateway model catalog file `~/flakes` renders (see models.ts). */
  gatewayCatalog: string;
  /** The file holding this daemon's gateway key; the key itself is never in the environment. */
  gatewayKeyFile: string;
  /** Agent Skill directories (each holds a SKILL.md), from MALEBOLGE_SKILLS. */
  skillDirs: string[];
  /** Where the agent's tools run; daemon-env.ts turns it into their environment and cwd. */
  execution: Execution;
}

type Env = Readonly<Record<string, string | undefined>>;

function requireEnv(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set`);
  }
  return value;
}

function profileOf(value: string | undefined): Profile {
  if (value === "room" || value === "host") {
    return value;
  }
  throw new Error(
    value === undefined
      ? "MALEBOLGE_PROFILE is not set"
      : `MALEBOLGE_PROFILE must be "room" or "host", not ${JSON.stringify(value)}`,
  );
}

/** The socket `profile`'s daemon serves: `$MALEBOLGE_SOCKET`, else the profile's own. */
export const daemonSocket = (env: Env, profile: Profile): string =>
  env["MALEBOLGE_SOCKET"] ??
  join(requireEnv(env, "XDG_RUNTIME_DIR"), "satan", "durable", profile, "durable.sock");

/**
 * The socket a client attaches to: the room's daemon unless MALEBOLGE_PROFILE
 * names another (§7 R5: the room is the one profile with a launcher). Only
 * the client defaults; the daemon requires its profile.
 */
export const attachSocket = (env: Env): string =>
  daemonSocket(
    env,
    env["MALEBOLGE_PROFILE"] === undefined ? "room" : profileOf(env["MALEBOLGE_PROFILE"]),
  );

/** `path`, unless its directory is named for another profile (a launcher misconfiguration). */
function inProfileDir(name: string, path: string, profile: Profile): string {
  if (basename(dirname(path)) !== profile) {
    throw new Error(`${name} ${path} is not in a directory named ${profile}`);
  }
  return path;
}

/**
 * The room door in door file `text`: `[door]` holds ROOM_DOOR_KEYS and the
 * room user's `home`, nothing else (the jail renders the ssh_config). `~` in
 * the path keys expands against `hostHome`.
 */
function parseDoorFile(text: string, hostHome: string): { door: RoomDoor; home: string } {
  const doc = parseToml(text, "door file");
  onlyKeys(doc, ["door"], "door file");
  const fields = within("door file", () => required(doc, "door", optionalRecord));
  onlyKeys(fields, [...ROOM_DOOR_KEYS, "home"], "door");
  return within("door", () => ({
    door: readRoomDoor(fields, hostHome),
    home: requireString(fields, "home"),
  }));
}

function executionOf(env: Env, cwd: string, readFile: (path: string) => string): Execution {
  const profile = profileOf(env["MALEBOLGE_PROFILE"]);
  if (profile === "host") {
    if (env["MALEBOLGE_DOOR"] !== undefined) {
      throw new Error("MALEBOLGE_DOOR is for the room profile, not host");
    }
    return { profile, cwd };
  }
  const doorFile = requireEnv(env, "MALEBOLGE_DOOR");
  const sshConfig = requireEnv(env, "MALEBOLGE_SSH_CONFIG");
  const { door, home } = within(doorFile, () =>
    parseDoorFile(readFile(doorFile), requireEnv(env, "HOME")),
  );
  return setDefined<Execution>(
    { profile, room: roomConnectionOf(door, sshConfig), home },
    { gatewaySocket: env["MALEBOLGE_GATEWAY_SOCKET"] },
  );
}

/** The daemon's configuration; `readFile` reads the door file. */
export function resolveConfig(env: Env, cwd: string, readFile: (path: string) => string): Config {
  const home = requireEnv(env, "HOME");
  const execution = executionOf(env, cwd, readFile);
  const { profile } = execution;
  const stateRoot = join(env["XDG_STATE_HOME"] ?? join(home, ".local", "state"), "satan");
  const runtime = join(requireEnv(env, "XDG_RUNTIME_DIR"), "satan");
  const profileState = join(stateRoot, "durable", profile);
  return {
    corpusRoot: env["SATAN_CORPUS_ROOT"] ?? join(home, "satan-corpus"),
    storagePath: join(profileState, "session.sqlite"),
    lockPath: join(profileState, "daemon.lock"),
    mcpSocket: env["SATAN_MCP_SOCKET"] ?? join(runtime, "mcp", "mcp.sock"),
    daemonSocket: inProfileDir("daemonSocket", daemonSocket(env, profile), profile),
    model: parseModel(env["MALEBOLGE_MODEL"] ?? DEFAULT_MODEL),
    gatewayCatalog:
      env["MALEBOLGE_GATEWAY_CATALOG"] ?? join(home, ".config", "malebolge", "gateway-models.json"),
    gatewayKeyFile:
      env["MALEBOLGE_GATEWAY_KEY_FILE"] ??
      join(home, ".config", "llm-gateway", "keys", "malebolge"),
    skillDirs: (env["MALEBOLGE_SKILLS"] ?? "").split(":").filter((dir) => dir !== ""),
    execution,
  };
}
