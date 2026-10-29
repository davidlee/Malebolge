// Where things live, resolved from the environment. Mirrors SATAN's roots
// (satan-custom.el): corpus under ~/satan-corpus, runtime state under
// $XDG_STATE_HOME/satan, sockets under $XDG_RUNTIME_DIR/satan. The launcher
// picks the execution profile; the store and socket are the profile's
// (design §4.2, DEC-077, DEC-078).

import { basename, dirname, isAbsolute, join } from "node:path";
import { bridgeSocketPath } from "../pi-bridge/wire.ts";
import {
  onlyKeys,
  optionalRecord,
  parseToml,
  required,
  requireString,
  setDefined,
  within,
} from "./fields.ts";
import { messageOf } from "./message-of.ts";
import { DEFAULT_MODEL, type ModelRef, parseModel } from "./models.ts";
import { DEFAULT_TOPIC, topicNameOf } from "./protocol.ts";
import type { RoomConnection } from "./room/connection.ts";
import { readRoomDoor, ROOM_DOOR_KEYS, type RoomDoor, roomConnectionOf } from "./room/door.ts";
import { DEFAULT_SATAN_IDLE_MS } from "./satan-pool.ts";
import { PROFILE_TOOLSETS } from "./toolsets.ts";
import type { QuietWindow, WakeSettings } from "./wake/policy.ts";

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

/** The mail extension's screwtape: absolute paths, never a PATH lookup (design sec-5). */
export interface ScrewtapePaths {
  /** MALEBOLGE_SCREWTAPE: the screwtape executable itself (not a wrapper that adds --config). */
  binary: string;
  /** MALEBOLGE_SCREWTAPE_CONFIG */
  config: string;
  /** The child's HOME: the daemon's HOME. */
  home: string;
}

export interface Config {
  corpusRoot: string;
  /** `<state>/satan/durable/<profile>/session.sqlite` */
  storagePath: string;
  /** `daemon.lock` beside the store: one daemon per profile (DEC-087). */
  lockPath: string;
  mcpSocket: string;
  /** How long a conversation's SATAN connection survives once no call is using it (ms). */
  satanIdleMs: number;
  /** `$MALEBOLGE_SOCKET` or `<runtime>/satan/durable/<profile>/durable.sock` */
  daemonSocket: string;
  model: ModelRef;
  /** The gateway model catalog file `~/flakes` renders (see models.ts). */
  gatewayCatalog: string;
  /** The file holding this daemon's gateway key; the key itself is never in the environment. */
  gatewayKeyFile: string;
  /** Agent Skill directories (each holds a SKILL.md), from MALEBOLGE_SKILLS. */
  skillDirs: string[];
  /** When SATAN may wake itself in the room (SL-034; host keeps the defaults, disabled). */
  wakes: WakeSettings;
  /** Present exactly when the profile allows `mail` (the room). */
  screwtape?: ScrewtapePaths;
  /** Present exactly when the profile is room: the bridge listener's socket (SL-009). */
  bridgeSocket?: string;
  /**
   * MALEBOLGE_BOOKMARK_BACKUPS: Firefox's bookmarkbackups directory, absolute;
   * absent leaves the bookmark tools refusing (DEC-055).
   */
  bookmarkBackups?: string;
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

/** `env[name]` as an absolute path: no PATH lookup, and no existence check (design sec-5). */
function absolutePathEnv(env: Env, name: string): string {
  const value = requireEnv(env, name);
  if (!isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path, not ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * The room's screwtape, and exactly the profiles that allow `mail` read it: a host
 * neither reads nor refuses the variables. `home` is the daemon's own HOME on the
 * host, never the room user's: mail runs on the host whatever the profile (DEC-028).
 */
export function screwtapeOf(env: Env, profile: Profile, home: string): ScrewtapePaths | undefined {
  if (!PROFILE_TOOLSETS[profile].allowed.includes("mail")) {
    return undefined;
  }
  return {
    binary: absolutePathEnv(env, "MALEBOLGE_SCREWTAPE"),
    config: absolutePathEnv(env, "MALEBOLGE_SCREWTAPE_CONFIG"),
    home,
  };
}

/**
 * Firefox's bookmark backup directory, and exactly the profiles that allow
 * `interactive` read it. Unset or empty leaves the tools installed and refusing
 * (DEC-055); set but not absolute refuses startup. Never checked for existence:
 * a backup may land after the daemon starts.
 */
export function bookmarkBackupsOf(env: Env, profile: Profile): string | undefined {
  if (!PROFILE_TOOLSETS[profile].allowed.includes("interactive")) {
    return undefined;
  }
  const value = env["MALEBOLGE_BOOKMARK_BACKUPS"];
  return value === undefined || value === ""
    ? undefined
    : absolutePathEnv(env, "MALEBOLGE_BOOKMARK_BACKUPS");
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

/**
 * `path`, unless its directory is named for another profile (a launcher
 * misconfiguration). `inner`, when given, names a directory the path must sit
 * in first, as the bridge socket sits in `bridge/` inside the profile's own
 * directory (SL-009 design sec-2).
 */
function inProfileDir(name: string, path: string, profile: Profile, inner?: string): string {
  const directory = dirname(path);
  if (inner === undefined) {
    if (basename(directory) !== profile) {
      throw new Error(`${name} ${path} is not in a directory named ${profile}`);
    }
    return path;
  }
  if (basename(directory) !== inner || basename(dirname(directory)) !== profile) {
    throw new Error(`${name} ${path} is not in a ${inner} directory inside one named ${profile}`);
  }
  return path;
}

/** The room's bridge socket, checked to sit in its `bridge/` directory; nothing on the host. */
function bridgeSocketOf(env: Env, profile: Profile): string | undefined {
  return profile === "room"
    ? inProfileDir("bridgeSocket", bridgeSocketPath(env), profile, "bridge")
    : undefined;
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

/** `env[name]` as a positive integer of milliseconds, or `fallback` when it is unset. */
function msOf(env: Env, name: string, fallback: number): number {
  const value = env[name];
  if (value === undefined) {
    return fallback;
  }
  // Digits only: `Number` would also read "1e3", " 30" and "0x10" as integers.
  const ms = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(ms) || ms <= 0) {
    throw new Error(`${name} must be a positive integer of milliseconds, not ${value}`);
  }
  return ms;
}

/** The wake settings' defaults: five minutes to two hours, quiet from 23:20 to 07:00. */
const DEFAULT_WAKE_FLOOR_MS = 300_000;
const DEFAULT_WAKE_CEILING_MS = 7_200_000;
const DEFAULT_QUIET: QuietWindow = { startMin: 23 * 60 + 20, endMin: 7 * 60 };
const DEFAULT_WAKE_TOPIC = "room";

/** The heartbeat's topic: a topic name the daemon can create, so not the reserved `default`. */
function wakeTopicOf(topic: string): string {
  if (topic === DEFAULT_TOPIC) {
    throw new Error("MALEBOLGE_WAKE_TOPIC must not be default: it is reserved");
  }
  try {
    return topicNameOf(topic);
  } catch (error) {
    throw new Error(`MALEBOLGE_WAKE_TOPIC: ${messageOf(error)}`);
  }
}

/** `HH:MM-HH:MM`, the only shape MALEBOLGE_WAKE_QUIET accepts. */
const QUIET = /^(\d\d):(\d\d)-(\d\d):(\d\d)$/;

/** The minutes since midnight an `HH`/`MM` pair names; `undefined` unless it is a clock time. */
function minutesOf(hours: string | undefined, minutes: string | undefined): number | undefined {
  if (hours === undefined || minutes === undefined) {
    return undefined;
  }
  const hour = Number(hours);
  const minute = Number(minutes);
  return hour > 23 || minute > 59 ? undefined : hour * 60 + minute;
}

/** MALEBOLGE_WAKE_QUIET's window; a window with no minutes in it is malformed, not empty. */
function quietOf(env: Env): QuietWindow {
  const value = env["MALEBOLGE_WAKE_QUIET"];
  if (value === undefined) {
    return { ...DEFAULT_QUIET };
  }
  const parsed = QUIET.exec(value);
  const startMin = parsed === null ? undefined : minutesOf(parsed[1], parsed[2]);
  const endMin = parsed === null ? undefined : minutesOf(parsed[3], parsed[4]);
  if (startMin === undefined || endMin === undefined || startMin === endMin) {
    throw new Error(`MALEBOLGE_WAKE_QUIET must be HH:MM-HH:MM, not ${JSON.stringify(value)}`);
  }
  return { startMin, endMin };
}

/**
 * The wake settings the environment names, defaults for the keys it leaves
 * unset (VT-1). The host's refusal of wake keys is `refuseWakeKeys`'s (W10).
 */
function wakesOf(env: Env): WakeSettings {
  const floorMs = msOf(env, "MALEBOLGE_WAKE_FLOOR_MS", DEFAULT_WAKE_FLOOR_MS);
  const ceilingMs = msOf(env, "MALEBOLGE_WAKE_CEILING_MS", DEFAULT_WAKE_CEILING_MS);
  if (floorMs > ceilingMs) {
    throw new Error(
      `MALEBOLGE_WAKE_FLOOR_MS ${String(floorMs)} is above MALEBOLGE_WAKE_CEILING_MS ${String(ceilingMs)}`,
    );
  }
  const topic = wakeTopicOf(env["MALEBOLGE_WAKE_TOPIC"] ?? DEFAULT_WAKE_TOPIC);
  return {
    enabled: env["MALEBOLGE_WAKES"] === "on",
    floorMs,
    ceilingMs,
    quiet: quietOf(env),
    topic,
  };
}

/** W10: wakes wake the room, never the host, so a host profile refuses every wake key. */
function refuseWakeKeys(env: Env): void {
  const key = Object.keys(env).find(
    (name) => name.startsWith("MALEBOLGE_WAKE") && env[name] !== undefined,
  );
  if (key !== undefined) {
    throw new Error(`${key} is for the room profile, not host`);
  }
}

function executionOf(env: Env, cwd: string, readFile: (path: string) => string): Execution {
  const profile = profileOf(env["MALEBOLGE_PROFILE"]);
  if (profile === "host") {
    if (env["MALEBOLGE_DOOR"] !== undefined) {
      throw new Error("MALEBOLGE_DOOR is for the room profile, not host");
    }
    refuseWakeKeys(env);
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
  return setDefined<Config>(
    {
      corpusRoot: env["SATAN_CORPUS_ROOT"] ?? join(home, "satan-corpus"),
      storagePath: join(profileState, "session.sqlite"),
      lockPath: join(profileState, "daemon.lock"),
      mcpSocket: env["SATAN_MCP_SOCKET"] ?? join(runtime, "mcp", "mcp.sock"),
      satanIdleMs: msOf(env, "MALEBOLGE_SATAN_IDLE_MS", DEFAULT_SATAN_IDLE_MS),
      daemonSocket: inProfileDir("daemonSocket", daemonSocket(env, profile), profile),
      model: parseModel(env["MALEBOLGE_MODEL"] ?? DEFAULT_MODEL),
      gatewayCatalog:
        env["MALEBOLGE_GATEWAY_CATALOG"] ??
        join(home, ".config", "malebolge", "gateway-models.json"),
      gatewayKeyFile:
        env["MALEBOLGE_GATEWAY_KEY_FILE"] ??
        join(home, ".config", "llm-gateway", "keys", "malebolge"),
      skillDirs: (env["MALEBOLGE_SKILLS"] ?? "").split(":").filter((dir) => dir !== ""),
      wakes: wakesOf(env),
      execution,
    },
    {
      screwtape: screwtapeOf(env, profile, home),
      bookmarkBackups: bookmarkBackupsOf(env, profile),
      bridgeSocket: bridgeSocketOf(env, profile),
    },
  );
}
