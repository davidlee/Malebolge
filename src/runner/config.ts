// Runner configuration (design §5.3): one TOML file, read once at start. Pure:
// text in, typed config or Error out. Reading the file and checking that
// `prompt_file` is readable belong to the entry point. Every table is closed,
// so a misspelt key refuses the config instead of being ignored (I13).

import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { parse } from "smol-toml";
import {
  expandHome,
  onlyKeys,
  optionalBoolean,
  optionalPositiveInt,
  optionalPositiveNumber,
  optionalRecord,
  optionalString,
  isStringArray,
  required,
  requireString,
  setDefined,
} from "../fields.ts";
import { isRecord, type JsonRecord } from "../json.ts";
import { readRoomDoor, ROOM_DOOR_KEYS, type RoomDoor } from "../room/door.ts";
import { normaliseAllowedEntry } from "./classify.ts";
import { messageOf } from "./errors.ts";

export const CEILING_KEYS = [
  "model_requests",
  "cost_usd",
  "tokens",
  "active_wall_clock_s",
] as const;

export type CeilingKey = (typeof CEILING_KEYS)[number];

/** Per-job ceilings. Keys keep their wire names: they are shared with submit. */
export type Ceilings = Record<CeilingKey, number>;

/** A full ceiling set, each key's value from `value`. */
export const ceilingsFrom = (value: (key: CeilingKey) => number): Ceilings => ({
  model_requests: value("model_requests"),
  cost_usd: value("cost_usd"),
  tokens: value("tokens"),
  active_wall_clock_s: value("active_wall_clock_s"),
});

export interface Maxima {
  ceilings: Ceilings;
  /** Fraction of a ceiling at which the agent is warned, in (0, 1). */
  softThreshold: number;
  maxRoomWaitS: number;
  maxPendingCollectionS: number;
}

/** One rung of the policy ladder: only the keys it sets. */
export interface PolicyLayer {
  model?: string;
  thinkingLevel?: ThinkingLevel;
  ceilings: Partial<Ceilings>;
  /** Prompt fragment; modes and repos only. */
  prompt?: string;
}

/** A mode's bound on one axis: a closed list, or "*" for unbounded (DEC-069). */
export type Scope = readonly string[] | "*";

/** A mode: a ladder rung plus the repos and paths a job under it may touch. */
export interface ModeConfig extends PolicyLayer {
  repos: Scope;
  allowedPaths: Scope;
}

export interface DefaultsLayer extends PolicyLayer {
  model: string;
}

export interface RepoConfig extends PolicyLayer {
  /** The `[repo.*]` key: under a room door, the oubliette target's name. */
  name: string;
  path: string;
  guestPath: string;
  defaultBranch: string;
  /** Room kind: the room's quarantine for this repo; never derived (I13). */
  quarantine?: string;
  /** Room kind: the bound on this repo's push and collect. */
  transferTimeoutS?: number;
}

/** What every door kind needs of the room's ssh. */
interface DoorSsh {
  /** The room's ssh user. */
  user: string;
  knownHosts: string;
  /** The name the room's host keys are stored under in `knownHosts`; never derived (I13). */
  hostKeyAlias: string;
}

/** An oubliette slot standing in for the room: the live rung until SL-006 ships. */
export interface SlotDoorConfig extends DoorSsh {
  kind: "slot";
  slot: string;
  /** The slot's quarantine, `$state/collect/<slot>.git`. */
  quarantine: string;
  /** The guest's address, as ssh reaches it through `sshConfig`. */
  host: string;
  /** Passed to `provision` when the slot needs it. */
  profile?: string;
  sshConfig?: string;
  identity?: string;
}

/** An oubliette room (SL-006 design sec-6); `room` is also `capsule`'s argv. */
export interface RoomDoorConfig extends RoomDoor {
  kind: "room";
  /** The relay's ProxyCommand. */
  sshConfig: string;
  /** The guest's `session` program, verbatim; no built-in fallback. */
  sessionPath: string;
}

/** The door into the room, by kind (DEC-065). */
export type DoorConfig = SlotDoorConfig | RoomDoorConfig;

const SHARED_DOOR_KEYS = ["kind", "user", "known_hosts", "host_key_alias"];

/** Each kind's `[door]` keys: the table is closed per kind. A room's are the room door's and two more. */
const DOOR_KEYS = {
  slot: [...SHARED_DOOR_KEYS, "slot", "quarantine", "host", "profile", "ssh_config", "identity"],
  room: ["kind", ...ROOM_DOOR_KEYS, "ssh_config", "session_path"],
} as const;

/** The `[repo.*]` keys taken, and required, only under a room door. */
const ROOM_REPO_KEYS = ["quarantine", "transfer_timeout_s"];

/**
 * Where the runner finds its model gateway (design §5.1, §5.3). Both are
 * configured, never derived (I13): the catalog is the file `~/flakes` renders
 * for the jails; the credential is the name of a systemd `LoadCredential=`
 * entry holding the key issued to this runner.
 */
export interface GatewayConfig {
  catalog: string;
  /** A file name in `$CREDENTIALS_DIRECTORY`. */
  credential: string;
}

export interface RunnerConfig {
  enabled: boolean;
  promptFile: string;
  maxima: Maxima;
  defaults: DefaultsLayer;
  modes: ReadonlyMap<string, ModeConfig>;
  /** Keyed by the tag rule's name, e.g. `cheap+code`. */
  tags: ReadonlyMap<string, PolicyLayer>;
  repos: ReadonlyMap<string, RepoConfig>;
  door?: DoorConfig;
  gateway: GatewayConfig;
}

const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export const isThinkingLevel = (value: string): value is ThinkingLevel =>
  THINKING_LEVELS.some((level) => level === value);

/** Runs `read`, prefixing any Error with the table it was reading. */
function within<T>(where: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw new Error(`${where}: ${messageOf(error)}`, {
      cause: error,
    });
  }
}

const readCeiling = (fields: JsonRecord, key: CeilingKey): number | undefined =>
  key === "cost_usd" ? optionalPositiveNumber(fields, key) : optionalPositiveInt(fields, key);

/** The ceiling keys present in `fields`. */
export function readCeilings(fields: JsonRecord): Partial<Ceilings> {
  const ceilings: Partial<Ceilings> = {};
  for (const key of CEILING_KEYS) {
    const value = readCeiling(fields, key);
    if (value !== undefined) {
      ceilings[key] = value;
    }
  }
  return ceilings;
}

function readMaxima(fields: JsonRecord): Maxima {
  onlyKeys(
    fields,
    [...CEILING_KEYS, "soft_threshold", "max_room_wait_s", "max_pending_collection_s"],
    "maxima",
  );
  return within("maxima", () => {
    const softThreshold = required(fields, "soft_threshold", optionalPositiveNumber);
    if (softThreshold >= 1) {
      throw new Error("soft_threshold must be below 1");
    }
    return {
      ceilings: {
        model_requests: required(fields, "model_requests", optionalPositiveInt),
        cost_usd: required(fields, "cost_usd", optionalPositiveNumber),
        tokens: required(fields, "tokens", optionalPositiveInt),
        active_wall_clock_s: required(fields, "active_wall_clock_s", optionalPositiveInt),
      },
      softThreshold,
      maxRoomWaitS: required(fields, "max_room_wait_s", optionalPositiveInt),
      maxPendingCollectionS: required(fields, "max_pending_collection_s", optionalPositiveInt),
    };
  });
}

function readThinkingLevel(fields: JsonRecord): ThinkingLevel | undefined {
  const level = optionalString(fields, "thinking_level");
  if (level !== undefined && !isThinkingLevel(level)) {
    throw new Error(`thinking_level must be one of ${THINKING_LEVELS.join(", ")}`);
  }
  return level;
}

/** A ladder rung; `extra` names the keys beyond the shared ones this table takes. */
function readLayer(fields: JsonRecord, where: string, extra: readonly string[]): PolicyLayer {
  onlyKeys(fields, ["model", "thinking_level", ...CEILING_KEYS, ...extra], where);
  return within(where, () =>
    setDefined<PolicyLayer>(
      { ceilings: readCeilings(fields) },
      {
        model: optionalString(fields, "model"),
        thinkingLevel: readThinkingLevel(fields),
        prompt: extra.includes("prompt") ? optionalString(fields, "prompt") : undefined,
      },
    ),
  );
}

/**
 * The scope at `key`: "*", or a non-empty list of strings, each run through
 * `normalise`. "*" as a list member is refused: it is a mistaken unbounded marker.
 */
function readScope(fields: JsonRecord, key: string, normalise: (entry: string) => string): Scope {
  const value = required(fields, key, (f, k) => f[k]);
  if (value === "*") {
    return "*";
  }
  if (!isStringArray(value) || value.length === 0) {
    throw new Error(`${key} must be "*" or a non-empty list of strings`);
  }
  return within(key, () =>
    value.map((entry) => {
      if (entry === "*") {
        throw new Error('"*" is not a list member; write the bare string "*" for unbounded');
      }
      return normalise(entry);
    }),
  );
}

/** A `[mode.*]` table: a ladder rung plus its required scopes, `repos` among `repoNames`. */
function readMode(
  fields: JsonRecord,
  name: string,
  repoNames: ReadonlyMap<string, unknown>,
): ModeConfig {
  const where = `mode.${name}`;
  const layer = readLayer(fields, where, ["prompt", "repos", "allowed_paths"]);
  const knownRepo = (entry: string): string => {
    if (!repoNames.has(entry)) {
      throw new Error(`unknown repo ${JSON.stringify(entry)}`);
    }
    return entry;
  };
  return within(where, () => ({
    ...layer,
    repos: readScope(fields, "repos", knownRepo),
    allowedPaths: readScope(fields, "allowed_paths", normaliseAllowedEntry),
  }));
}

function readDefaults(fields: JsonRecord): DefaultsLayer {
  const layer = readLayer(fields, "defaults", []);
  const model = within("defaults", () => requireString(fields, "model"));
  return { ...layer, model };
}

/** A `[repo.*]` table; the room's keys are taken, and required, only under a room door. */
function readRepo(
  fields: JsonRecord,
  name: string,
  home: string,
  kind: DoorConfig["kind"] | undefined,
): RepoConfig {
  const where = `repo.${name}`;
  const room = kind === "room";
  const layer = readLayer(fields, where, [
    "path",
    "guest_path",
    "default_branch",
    "prompt",
    ...(room ? ROOM_REPO_KEYS : []),
  ]);
  return within(where, () =>
    setDefined<RepoConfig>(
      {
        ...layer,
        name,
        path: expandHome(requireString(fields, "path"), home),
        guestPath: requireString(fields, "guest_path"),
        defaultBranch: requireString(fields, "default_branch"),
      },
      room
        ? {
            quarantine: expandHome(requireString(fields, "quarantine"), home),
            transferTimeoutS: required(fields, "transfer_timeout_s", optionalPositiveInt),
          }
        : {},
    ),
  );
}

function readDoorKind(fields: JsonRecord): DoorConfig["kind"] {
  const kind = within("door", () => requireString(fields, "kind"));
  if (kind !== "slot" && kind !== "room") {
    throw new Error('door: kind must be "slot" or "room"');
  }
  return kind;
}

function readDoor(fields: JsonRecord, home: string): DoorConfig {
  const kind = readDoorKind(fields);
  onlyKeys(fields, DOOR_KEYS[kind], `door (kind = ${kind})`);
  return within("door", () => {
    const text = (key: string): string => requireString(fields, key);
    const path = (key: string): string => expandHome(text(key), home);
    const optionalPath = (key: string): string | undefined => {
      const value = optionalString(fields, key);
      return value === undefined ? undefined : expandHome(value, home);
    };
    if (kind === "room") {
      return {
        kind,
        ...readRoomDoor(fields, home),
        sshConfig: path("ssh_config"),
        sessionPath: text("session_path"),
      };
    }
    const ssh: DoorSsh = {
      user: text("user"),
      knownHosts: path("known_hosts"),
      hostKeyAlias: text("host_key_alias"),
    };
    return setDefined<SlotDoorConfig>(
      { kind, slot: text("slot"), quarantine: path("quarantine"), host: text("host"), ...ssh },
      {
        profile: optionalString(fields, "profile"),
        sshConfig: optionalPath("ssh_config"),
        identity: optionalPath("identity"),
      },
    );
  });
}

/** A credential id is one file name: it cannot leave `$CREDENTIALS_DIRECTORY`. */
const isFileName = (name: string): boolean => !name.includes("/") && name !== "." && name !== "..";

function readGateway(fields: JsonRecord, home: string): GatewayConfig {
  onlyKeys(fields, ["catalog", "credential"], "gateway");
  return within("gateway", () => {
    const credential = requireString(fields, "credential");
    if (!isFileName(credential)) {
      throw new Error("credential must be a file name, not a path");
    }
    return { catalog: expandHome(requireString(fields, "catalog"), home), credential };
  });
}

/** Each sub-table of `parent[key]`, read by `read` given its name. */
function readNamed<T>(
  parent: JsonRecord,
  key: string,
  read: (fields: JsonRecord, name: string) => T,
): Map<string, T> {
  const tables = within(key, () => optionalRecord(parent, key)) ?? {};
  return new Map(
    Object.entries(tables).map(([name, fields]) => {
      if (!isRecord(fields)) {
        throw new Error(`${key}.${name} must be a table`);
      }
      return [name, read(fields, name)];
    }),
  );
}

function parseToml(text: string): JsonRecord {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (error) {
    throw new Error(`config is not valid TOML: ${messageOf(error)}`, {
      cause: error,
    });
  }
  if (!isRecord(doc)) {
    throw new Error("config must be a table");
  }
  return doc;
}

/** The runner config in `text`; `~` in paths expands against `home`. */
export function parseRunnerConfig(text: string, home: string): RunnerConfig {
  const doc = parseToml(text);
  onlyKeys(
    doc,
    ["enabled", "prompt_file", "maxima", "defaults", "mode", "tag", "repo", "door", "gateway"],
    "config",
  );
  const table = (key: string): JsonRecord =>
    within("config", () => required(doc, key, optionalRecord));
  const doorTable = within("config", () => optionalRecord(doc, "door"));
  const door = doorTable === undefined ? undefined : readDoor(doorTable, home);
  const repos = readNamed(doc, "repo", (fields, name) => readRepo(fields, name, home, door?.kind));
  return {
    ...within("config", () => ({
      enabled: required(doc, "enabled", optionalBoolean),
      promptFile: expandHome(requireString(doc, "prompt_file"), home),
    })),
    gateway: readGateway(table("gateway"), home),
    maxima: readMaxima(table("maxima")),
    defaults: readDefaults(table("defaults")),
    modes: readNamed(doc, "mode", (fields, name) => readMode(fields, name, repos)),
    tags: readNamed(doc, "tag", (fields, name) => readLayer(fields, `tag.${name}`, [])),
    repos,
    ...(door === undefined ? {} : { door }),
  };
}
