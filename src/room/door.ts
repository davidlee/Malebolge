// The room door's table (design §4.1, DEC-074, DEC-077; invariants in
// connection.ts): the keys every program that reaches a room reads from its
// door, parsed once. The key list is a cross-repo contract: ~/flakes renders
// the door file from it and pins it in a check (flakes DEC-079), so changing
// it means telling flakes.

import { expandHome, requireString } from "../fields.ts";
import type { JsonRecord } from "../json.ts";
import type { RoomConnection } from "./connection.ts";

/** A room door: where the room is, and how its ssh is trusted. */
export interface RoomDoor {
  /** The room's name: the placeholder ssh host. */
  room: string;
  /** The room's ssh user. */
  user: string;
  knownHosts: string;
  /** The name the room's host keys are stored under in `knownHosts`; never derived (I13). */
  hostKeyAlias: string;
  identity: string;
}

export const ROOM_DOOR_KEYS = [
  "room",
  "user",
  "known_hosts",
  "host_key_alias",
  "identity",
] as const;

/**
 * The room-door keys of `fields`, `~` expanded against `home` in the path
 * keys; throws naming a missing key. Other keys are ignored: the caller
 * checks for keys it does not allow (onlyKeys).
 */
export function readRoomDoor(fields: JsonRecord, home: string): RoomDoor {
  const path = (key: string): string => expandHome(requireString(fields, key), home);
  return {
    room: requireString(fields, "room"),
    user: requireString(fields, "user"),
    knownHosts: path("known_hosts"),
    hostKeyAlias: requireString(fields, "host_key_alias"),
    identity: path("identity"),
  };
}

/** The connection facts of `door`, through the ssh config file `sshConfig` when given. */
export const roomConnectionOf = (door: RoomDoor, sshConfig?: string): RoomConnection => ({
  host: door.room,
  user: door.user,
  hostKeyAlias: door.hostKeyAlias,
  knownHosts: door.knownHosts,
  identity: door.identity,
  ...(sshConfig === undefined ? {} : { sshConfig }),
});
