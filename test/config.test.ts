import { describe, expect, it } from "vitest";
import { attachSocket, daemonSocket, resolveConfig } from "../src/config.ts";

const DOOR_PATH = "/h/.config/malebolge/door.toml";
const DOOR = `[door]
room = "assistant"
user = "satan"
known_hosts = "/var/lib/capsule/room/assistant/known_hosts"
host_key_alias = "room-assistant"
identity = "~/.ssh/malebolge-vm.key"
home = "/home/satan"
`;

type Env = Record<string, string | undefined>;

const host: Env = { HOME: "/h", XDG_RUNTIME_DIR: "/run/u", MALEBOLGE_PROFILE: "host" };
const room: Env = {
  HOME: "/h",
  XDG_RUNTIME_DIR: "/run/u",
  MALEBOLGE_PROFILE: "room",
  MALEBOLGE_DOOR: DOOR_PATH,
  MALEBOLGE_SSH_CONFIG: "/nix/store/x-ssh_config",
};

/** A file system holding `files`; reading anything else throws, as readFileSync does. */
const filesystem =
  (files: Record<string, string>) =>
  (path: string): string => {
    const text = files[path];
    if (text === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    return text;
  };

const resolve = (env: Env, door = DOOR): ReturnType<typeof resolveConfig> =>
  resolveConfig(env, "/cwd", filesystem({ [DOOR_PATH]: door }));

/** What resolving `env` with door file `door` refuses with. */
function refusal(env: Env, door = DOOR): string {
  try {
    resolve(env, door);
  } catch (error) {
    return String(error);
  }
  throw new Error("resolved");
}

describe("resolveConfig", () => {
  it("defaults to SATAN's roots and sockets, the store and socket the profile's", () => {
    expect(resolve(host)).toEqual({
      corpusRoot: "/h/satan-corpus",
      storagePath: "/h/.local/state/satan/durable/host/session.sqlite",
      lockPath: "/h/.local/state/satan/durable/host/daemon.lock",
      mcpSocket: "/run/u/satan/mcp/mcp.sock",
      daemonSocket: "/run/u/satan/durable/host/durable.sock",
      model: { provider: "gateway", modelId: "deepseek-flash" },
      gatewayCatalog: "/h/.config/malebolge/gateway-models.json",
      gatewayKeyFile: "/h/.config/llm-gateway/keys/malebolge",
      skillDirs: [],
      satanIdleMs: 900_000,
      wakes: {
        enabled: false,
        floorMs: 300_000,
        ceilingMs: 7_200_000,
        quiet: { startMin: 23 * 60 + 20, endMin: 7 * 60 },
        topic: "room",
      },
      execution: { profile: "host", cwd: "/cwd" },
    });
  });

  it.each([
    ["", []],
    ["a::b:", ["a", "b"]],
    ["/s/one:/s/two", ["/s/one", "/s/two"]],
  ])(
    "splits MALEBOLGE_SKILLS %j on ':' into skillDirs %j, dropping empty segments",
    (value, dirs) => {
      expect(resolve({ ...host, MALEBOLGE_SKILLS: value }).skillDirs).toEqual(dirs);
    },
  );

  it("honours XDG_STATE_HOME and explicit overrides", () => {
    const config = resolve({
      ...host,
      XDG_STATE_HOME: "/state",
      SATAN_CORPUS_ROOT: "/corpus",
      SATAN_MCP_SOCKET: "/mcp.sock",
      MALEBOLGE_SOCKET: "/d/host/d.sock",
      MALEBOLGE_MODEL: "openai/gpt-6-sol",
      MALEBOLGE_GATEWAY_CATALOG: "/etc/catalog.json",
      MALEBOLGE_GATEWAY_KEY_FILE: "/run/key",
    });
    expect(config).toMatchObject({
      corpusRoot: "/corpus",
      storagePath: "/state/satan/durable/host/session.sqlite",
      lockPath: "/state/satan/durable/host/daemon.lock",
      mcpSocket: "/mcp.sock",
      daemonSocket: "/d/host/d.sock",
      model: { provider: "openai", modelId: "gpt-6-sol" },
      gatewayCatalog: "/etc/catalog.json",
      gatewayKeyFile: "/run/key",
    });
  });

  it("rejects a model without a provider prefix", () => {
    expect(() => resolve({ ...host, MALEBOLGE_MODEL: "bare" })).toThrow(/provider\/model/);
  });

  it("takes the SATAN connection idle timeout from MALEBOLGE_SATAN_IDLE_MS", () => {
    expect(resolve({ ...host, MALEBOLGE_SATAN_IDLE_MS: "30000" }).satanIdleMs).toBe(30_000);
  });

  it.each(["0", "-1", "1.5", "abc", "1e3", " 30", "0x10"])(
    "refuses MALEBOLGE_SATAN_IDLE_MS %j",
    (value) => {
      expect(refusal({ ...host, MALEBOLGE_SATAN_IDLE_MS: value })).toContain(
        "MALEBOLGE_SATAN_IDLE_MS",
      );
    },
  );
});

describe("the execution profile (design §4.2)", () => {
  it.each([
    [undefined, "MALEBOLGE_PROFILE is not set"],
    ["vm", 'MALEBOLGE_PROFILE must be "room" or "host", not "vm"'],
  ])("MALEBOLGE_PROFILE %j refuses startup", (profile, error) => {
    expect(refusal({ ...host, MALEBOLGE_PROFILE: profile })).toContain(error);
  });

  it("room: the door file's room, through the jail's ssh_config, and the room user's home", () => {
    const config = resolve({ ...room, MALEBOLGE_GATEWAY_SOCKET: "/run/gateway.sock" });
    expect(config).toMatchObject({
      storagePath: "/h/.local/state/satan/durable/room/session.sqlite",
      lockPath: "/h/.local/state/satan/durable/room/daemon.lock",
      daemonSocket: "/run/u/satan/durable/room/durable.sock",
    });
    expect(config.execution).toEqual({
      profile: "room",
      room: {
        host: "assistant",
        user: "satan",
        hostKeyAlias: "room-assistant",
        knownHosts: "/var/lib/capsule/room/assistant/known_hosts",
        identity: "/h/.ssh/malebolge-vm.key",
        sshConfig: "/nix/store/x-ssh_config",
      },
      home: "/home/satan",
      gatewaySocket: "/run/gateway.sock",
    });
  });

  it("room: no gateway socket is no gatewaySocket key", () => {
    expect(resolve(room).execution).not.toHaveProperty("gatewaySocket");
  });

  it.each(["MALEBOLGE_DOOR", "MALEBOLGE_SSH_CONFIG"])("room without %s refuses startup", (name) => {
    expect(refusal({ ...room, [name]: undefined })).toContain(`${name} is not set`);
  });

  it("host with MALEBOLGE_DOOR refuses startup", () => {
    expect(refusal({ ...host, MALEBOLGE_DOOR: DOOR_PATH })).toContain(
      "MALEBOLGE_DOOR is for the room profile",
    );
  });

  it("an unreadable door file refuses startup, naming it", () => {
    expect(() => resolveConfig(room, "/cwd", filesystem({}))).toThrow(DOOR_PATH);
  });

  it.each([
    [`${DOOR}ssh_config = "/x"\n`, "door: unknown key ssh_config"],
    [`${DOOR}[other]\n`, "door file: unknown key other"],
    [DOOR.replace(/^home = .*$/m, ""), "door: home"],
    [DOOR.replace(/^identity = .*$/m, ""), "door: identity"],
    ["door = 1\n", "door"],
    ["[door", "door file is not valid TOML"],
  ])("door file %j refuses startup, naming the file and %s", (text, error) => {
    const message = refusal(room, text);
    expect(message).toContain(DOOR_PATH);
    expect(message).toContain(error);
  });
});

describe("the profile-bound store and socket (DEC-078)", () => {
  it("refuses a MALEBOLGE_SOCKET whose directory names another profile", () => {
    expect(refusal({ ...room, MALEBOLGE_SOCKET: "/run/u/satan/durable/host/d.sock" })).toContain(
      "daemonSocket /run/u/satan/durable/host/d.sock is not in a directory named room",
    );
  });

  it("daemonSocket is the profile's", () => {
    expect(daemonSocket(host, "host")).toBe("/run/u/satan/durable/host/durable.sock");
    expect(daemonSocket({ ...host, MALEBOLGE_SOCKET: "/s.sock" }, "room")).toBe("/s.sock");
  });

  it("attach defaults to the room's daemon; the daemon never defaults", () => {
    const client = { XDG_RUNTIME_DIR: "/run/u" };
    expect(attachSocket(client)).toBe("/run/u/satan/durable/room/durable.sock");
    expect(attachSocket({ ...client, MALEBOLGE_PROFILE: "host" })).toBe(
      "/run/u/satan/durable/host/durable.sock",
    );
    expect(() => attachSocket({ ...client, MALEBOLGE_PROFILE: "vm" })).toThrow(/MALEBOLGE_PROFILE/);
    expect(refusal({ ...host, MALEBOLGE_PROFILE: undefined })).toContain("MALEBOLGE_PROFILE");
  });
});

describe("wakes (VT-1)", () => {
  const WAKES = {
    enabled: false,
    floorMs: 300_000,
    ceilingMs: 7_200_000,
    quiet: { startMin: 23 * 60 + 20, endMin: 7 * 60 },
    topic: "room",
  };
  const MILLISECOND_KEYS: readonly string[] = [
    "MALEBOLGE_WAKE_FLOOR_MS",
    "MALEBOLGE_WAKE_CEILING_MS",
  ];
  const NOT_MILLISECONDS: readonly string[] = ["1e3", " 30", "0x10", "0", "-5", "abc"];
  const BAD_MILLISECONDS_NAMED: [string, string][] = MILLISECOND_KEYS.flatMap((name) =>
    NOT_MILLISECONDS.map((value): [string, string] => [name, value]),
  );
  const BAD_QUIET: readonly string[] = [
    "7:00-08:00",
    "24:00-07:00",
    "23:60-07:00",
    "23:20",
    "23:20-07:00 ",
    "08:00-08:00",
  ];
  const WAKE_KEYS: [string, string][] = [
    ["MALEBOLGE_WAKES", "on"],
    ["MALEBOLGE_WAKE_FLOOR_MS", "300000"],
    ["MALEBOLGE_WAKE_CEILING_MS", "7200000"],
    ["MALEBOLGE_WAKE_QUIET", "23:20-07:00"],
    ["MALEBOLGE_WAKE_TOPIC", "room"],
  ];

  it("host: no wake keys means wakes are off and otherwise by default", () => {
    expect(resolve(host).wakes).toEqual(WAKES);
  });

  it.each([
    ["on", true],
    ["ON", false],
    ["true", false],
    ["1", false],
    [" on", false],
  ])("MALEBOLGE_WAKES %j is enabled %s", (value, enabled) => {
    expect(resolve({ ...room, MALEBOLGE_WAKES: value }).wakes.enabled).toBe(enabled);
  });

  it("takes the floor and ceiling from the environment", () => {
    const config = resolve({
      ...room,
      MALEBOLGE_WAKE_FLOOR_MS: "60000",
      MALEBOLGE_WAKE_CEILING_MS: "3600000",
    });
    expect(config.wakes.floorMs).toBe(60_000);
    expect(config.wakes.ceilingMs).toBe(3_600_000);
  });

  it.each(BAD_MILLISECONDS_NAMED)("%s refuses %j", (name, value) => {
    expect(refusal({ ...room, [name]: value })).toMatch(name);
  });

  it("refuses a floor above the ceiling", () => {
    const keys = {
      ...room,
      MALEBOLGE_WAKE_FLOOR_MS: "7200001",
      MALEBOLGE_WAKE_CEILING_MS: "7200000",
    };
    expect(refusal(keys)).toMatch(/MALEBOLGE_WAKE_(FLOOR|CEILING)_MS/);
  });

  it("defaults the quiet window to 23:20-07:00", () => {
    expect(resolve(room).wakes.quiet).toEqual({ startMin: 1400, endMin: 420 });
  });

  it("takes MALEBOLGE_WAKE_QUIET 13:00-14:30 as 780 to 870", () => {
    expect(resolve({ ...room, MALEBOLGE_WAKE_QUIET: "13:00-14:30" }).wakes.quiet).toEqual({
      startMin: 780,
      endMin: 870,
    });
  });

  it.each(BAD_QUIET)("refuses MALEBOLGE_WAKE_QUIET %j", (value) => {
    expect(refusal({ ...room, MALEBOLGE_WAKE_QUIET: value })).toMatch("MALEBOLGE_WAKE_QUIET");
  });

  it("defaults the wake topic to the room", () => {
    expect(resolve(room).wakes.topic).toBe("room");
  });

  it("takes a topic name in MALEBOLGE_WAKE_TOPIC as it is", () => {
    expect(resolve({ ...room, MALEBOLGE_WAKE_TOPIC: "workshop.2" }).wakes.topic).toBe("workshop.2");
  });

  // The heartbeat's topic is one an attach can name, and one the daemon can create.
  it.each(["", "the workshop", "Room", "default"])("refuses MALEBOLGE_WAKE_TOPIC %j", (topic) => {
    expect(refusal({ ...room, MALEBOLGE_WAKE_TOPIC: topic })).toMatch("MALEBOLGE_WAKE_TOPIC");
  });

  it.each(WAKE_KEYS)("host with %s refuses startup", (name, value) => {
    expect(refusal({ ...host, [name]: value })).toMatch(name);
  });

  it("host refuses a wake key as a host key before reading its value", () => {
    expect(refusal({ ...host, MALEBOLGE_WAKE_QUIET: "nonsense" })).toMatch(
      "MALEBOLGE_WAKE_QUIET is for the room profile, not host",
    );
  });
});
