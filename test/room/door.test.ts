// The room door's table (design §4.1, DEC-074, DEC-077): the five keys both
// programs read, parsed once. Which other keys a door file may hold is the
// caller's (onlyKeys); the runner's [door] fixtures are pinned in
// test/runner/config.test.ts.

import { describe, expect, it } from "vitest";
import type { JsonRecord } from "../../src/json.ts";
import { readRoomDoor, ROOM_DOOR_KEYS, roomConnectionOf } from "../../src/room/door.ts";

const HOME = "/home/test";

const DOOR: JsonRecord = {
  room: "assistant",
  user: "satan",
  known_hosts: "~/rooms/known_hosts",
  host_key_alias: "room-assistant",
  identity: "~/.ssh/malebolge-vm.key",
};

describe("readRoomDoor", () => {
  it("the five keys are the cross-repo contract (flakes DEC-079)", () => {
    expect(ROOM_DOOR_KEYS).toEqual(["room", "user", "known_hosts", "host_key_alias", "identity"]);
  });

  it("reads the five keys, ~ expanded in the path keys only", () => {
    expect(readRoomDoor({ ...DOOR, room: "~", user: "~" }, HOME)).toEqual({
      room: "~",
      user: "~",
      knownHosts: "/home/test/rooms/known_hosts",
      hostKeyAlias: "room-assistant",
      identity: "/home/test/.ssh/malebolge-vm.key",
    });
  });

  it.each(ROOM_DOOR_KEYS)("names a missing %s", (key) => {
    const rest = Object.fromEntries(Object.entries(DOOR).filter(([name]) => name !== key));
    expect(() => readRoomDoor(rest, HOME)).toThrow(new RegExp(`^${key} `));
  });

  it("ignores keys it does not own: the caller's onlyKeys decides", () => {
    const fields = { ...DOOR, kind: "room", ssh_config: "/c", session_path: "/s", home: "/h" };
    expect(readRoomDoor(fields, HOME)).toEqual(readRoomDoor(DOOR, HOME));
  });
});

describe("roomConnectionOf", () => {
  const door = readRoomDoor(DOOR, HOME);

  it("is the door's ssh facts, the room's name as the placeholder host", () => {
    expect(roomConnectionOf(door, "/c/ssh_config")).toEqual({
      host: "assistant",
      user: "satan",
      hostKeyAlias: "room-assistant",
      knownHosts: "/home/test/rooms/known_hosts",
      sshConfig: "/c/ssh_config",
      identity: "/home/test/.ssh/malebolge-vm.key",
    });
  });

  it("leaves the ssh config out when none is given", () => {
    expect(roomConnectionOf(door)).not.toHaveProperty("sshConfig");
  });
});
