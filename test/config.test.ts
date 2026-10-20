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
