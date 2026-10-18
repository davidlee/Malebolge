import { describe, expect, it } from "vitest";
import { parseRunnerConfig } from "../../src/runner/config.ts";
import {
  EXAMPLE_TOML as EXAMPLE,
  HOME,
  ROOM_TOML,
  roomVariant,
  variant,
} from "./config-fixture.ts";

describe("parseRunnerConfig", () => {
  it("parses the design example into a typed config", () => {
    const config = parseRunnerConfig(EXAMPLE, HOME);
    expect(config.enabled).toBe(true);
    expect(config.promptFile).toBe("/home/test/corpus/prompts/patch-agent.md");
    expect(config.maxima).toEqual({
      ceilings: { model_requests: 200, cost_usd: 2, tokens: 2_000_000, active_wall_clock_s: 3600 },
      softThreshold: 0.8,
      maxRoomWaitS: 21_600,
      maxPendingCollectionS: 86_400,
    });
    expect(config.defaults).toEqual({
      model: "gateway/test-model",
      thinkingLevel: "low",
      ceilings: { cost_usd: 1.5 },
    });
    expect(config.modes.get("fix")?.prompt).toBe("Fix mode: keep the change small.");
    expect(config.repos.get("satan")).toEqual({
      name: "satan",
      path: "/home/test/dev/satan",
      guestPath: "/work/repos/satan",
      defaultBranch: "main",
      prompt: "Repo note.",
      ceilings: {},
    });
    expect(config.door).toEqual({
      kind: "slot",
      slot: "f",
      quarantine: "/home/test/state/collect/f.git",
      host: "10.99.0.2",
      user: "agent",
      sshConfig: "/home/test/.ssh/config",
      identity: "/home/test/.ssh/id",
      knownHosts: "/home/test/.ssh/known_hosts",
      hostKeyAlias: "pi-env-f",
    });
  });

  it("keeps a tag table whose quoted key holds a joiner", () => {
    const tag = parseRunnerConfig(EXAMPLE, HOME).tags.get("cheap+code");
    expect(tag).toEqual({ model: "gateway/cheap", ceilings: { tokens: 500_000 } });
  });

  it("accepts a config with no door and no layers beyond defaults", () => {
    const text = `
prompt_file = "/p.md"
enabled = false
[gateway]
catalog = "/c.json"
credential = "k"
[maxima]
model_requests = 1
cost_usd = 1
tokens = 1
active_wall_clock_s = 1
soft_threshold = 0.5
max_room_wait_s = 1
max_pending_collection_s = 1
[defaults]
model = "m"
`;
    const config = parseRunnerConfig(text, HOME);
    expect(config.enabled).toBe(false);
    expect(config.door).toBeUndefined();
    expect(config.repos.size).toBe(0);
  });

  it.each([
    ["prompt_file", 'prompt_file = "~/corpus/prompts/patch-agent.md"\n', ""],
    ["empty prompt_file", 'prompt_file = "~/corpus/prompts/patch-agent.md"', 'prompt_file = ""'],
    ["enabled", "enabled = true\n", ""],
    ["maxima table", "[maxima]", "[maxim]"],
    ["maxima key", "tokens = 2_000_000\n", ""],
    ["maxima soft_threshold", "soft_threshold = 0.8\n", ""],
    ["defaults.model", 'model = "gateway/test-model"\n', ""],
    ["repo default_branch", 'default_branch = "main"\n', ""],
    ["repo guest_path", 'guest_path = "/work/repos/satan"\n', ""],
  ])("refuses a config missing %s", (_label, from, to) => {
    expect(() => parseRunnerConfig(variant(from, to), HOME)).toThrow();
  });

  it("names prompt_file when it is missing", () => {
    const text = variant('prompt_file = "~/corpus/prompts/patch-agent.md"\n', "");
    expect(() => parseRunnerConfig(text, HOME)).toThrow(/prompt_file/);
  });

  it.each([
    ["top-level", "enabled = true", "enabled = true\nsurprise = 1", /surprise/],
    ["maxima", "soft_threshold = 0.8", "soft_threshold = 0.8\nextra = 1", /maxima.*extra/],
    ["defaults", 'thinking_level = "low"', 'thinking_level = "low"\nextra = 1', /defaults.*extra/],
    ["mode", "[mode.fix]", "[mode.fix]\nextra = 1", /mode\.fix.*extra/],
    ["tag", 'model = "gateway/cheap"', 'model = "gateway/cheap"\nextra = 1', /extra/],
    ["repo", 'path = "~/dev/satan"', 'path = "~/dev/satan"\nextra = 1', /repo\.satan.*extra/],
    ["door", 'identity = "~/.ssh/id"', 'identity = "~/.ssh/id"\nextra = 1', /door.*extra/],
  ])("refuses an unknown %s key", (_label, from, to, reason) => {
    expect(() => parseRunnerConfig(variant(from, to), HOME)).toThrow(reason);
  });

  it("refuses TOML syntax errors", () => {
    expect(() => parseRunnerConfig("enabled = = true", HOME)).toThrow(/TOML/);
  });

  it.each([
    ["a non-positive maxima value", "model_requests = 200", "model_requests = 0"],
    ["a fractional request count", "model_requests = 200", "model_requests = 2.5"],
    ["soft_threshold of 1", "soft_threshold = 0.8", "soft_threshold = 1"],
    ["a non-positive layer ceiling", "cost_usd = 1.5", "cost_usd = -1"],
    ["a string layer ceiling", "cost_usd = 1.5", 'cost_usd = "1"'],
    ["an unknown thinking_level", 'thinking_level = "low"', 'thinking_level = "ludicrous"'],
    ["a non-boolean enabled", "enabled = true", 'enabled = "yes"'],
  ])("refuses %s", (_label, from, to) => {
    expect(() => parseRunnerConfig(variant(from, to), HOME)).toThrow();
  });

  it("reads the optional door profile", () => {
    const text = variant('slot = "f"', 'slot = "f"\nprofile = "satan"');
    expect(parseRunnerConfig(text, HOME).door).toMatchObject({ profile: "satan" });
  });

  it("leaves paths without a leading ~ alone", () => {
    const text = variant('path = "~/dev/satan"', 'path = "/srv/satan"');
    expect(parseRunnerConfig(text, HOME).repos.get("satan")?.path).toBe("/srv/satan");
  });

  it("keeps session_path verbatim and expands the other paths", () => {
    const text = roomVariant(
      'session_path = "/run/current-system/sw/bin/session"',
      'session_path = "~/bin/session"',
    );
    const door = parseRunnerConfig(text, HOME).door;
    expect(door).toMatchObject({
      sessionPath: "~/bin/session",
      identity: "/home/test/.ssh/runner",
    });
  });
});

describe("parseRunnerConfig: the [gateway] table", () => {
  it("reads the catalog (home-expanded) and the credential id", () => {
    expect(parseRunnerConfig(EXAMPLE, HOME).gateway).toEqual({
      catalog: "/home/test/gateway/models.json",
      credential: "satan-runner",
    });
  });

  it.each([
    ["the [gateway] table", /\[gateway\][^]*?(?=\[defaults\])/, /gateway/],
    ["gateway.catalog", /catalog = .*\n/, /gateway.*catalog/],
    ["gateway.credential", /credential = .*\n/, /gateway.*credential/],
  ])("refuses a config without %s: nothing is derived (I13)", (_label, pattern, reason) => {
    expect(() => parseRunnerConfig(EXAMPLE.replace(pattern, ""), HOME)).toThrow(reason);
  });

  it("refuses an unknown gateway key", () => {
    const text = variant('credential = "satan-runner"', 'credential = "satan-runner"\nextra = 1');
    expect(() => parseRunnerConfig(text, HOME)).toThrow(/gateway.*extra/);
  });

  it.each([
    ["a path", "../escape"],
    ["a nested path", "a/b"],
  ])(
    "refuses a gateway credential that is %s: it must stay inside CREDENTIALS_DIRECTORY",
    (_l, id) => {
      const text = variant('credential = "satan-runner"', `credential = "${id}"`);
      expect(() => parseRunnerConfig(text, HOME)).toThrow(/gateway.*credential/);
    },
  );
});

describe("parseRunnerConfig: the door kind (DEC-065)", () => {
  it("parses a room door and its repos' room keys", () => {
    const config = parseRunnerConfig(ROOM_TOML, HOME);
    expect(config.door).toEqual({
      kind: "room",
      room: "assistant",
      user: "agent",
      sshConfig: "/home/test/.ssh/room-assistant.conf",
      identity: "/home/test/.ssh/runner",
      knownHosts: "/var/lib/capsule/room/assistant/known_hosts",
      hostKeyAlias: "room-assistant",
      sessionPath: "/run/current-system/sw/bin/session",
    });
    expect(config.repos.get("satan")).toEqual({
      name: "satan",
      path: "/home/test/dev/satan",
      guestPath: "/work/satan",
      defaultBranch: "main",
      quarantine: "/var/lib/capsule/collect/assistant/satan.git",
      transferTimeoutS: 600,
      ceilings: {},
    });
  });

  it.each([
    ["missing", 'kind = "slot"\n', ""],
    ["unknown", 'kind = "slot"', 'kind = "cell"'],
    ["not a string", 'kind = "slot"', "kind = 1"],
  ])("refuses a door whose kind is %s", (_label, from, to) => {
    expect(() => parseRunnerConfig(variant(from, to), HOME)).toThrow(/door.*kind/);
  });

  it.each([
    ["[door] room", 'slot = "f"', 'slot = "f"\nroom = "assistant"', /door.*room/],
    ["[door] session_path", 'slot = "f"', 'slot = "f"\nsession_path = "/s"', /session_path/],
    [
      "[repo.*] quarantine",
      'guest_path = "/work/repos/satan"',
      'guest_path = "/w"\nquarantine = "/q"',
      /repo\.satan.*quarantine/,
    ],
    [
      "[repo.*] transfer_timeout_s",
      'guest_path = "/work/repos/satan"',
      'guest_path = "/w"\ntransfer_timeout_s = 600',
      /repo\.satan.*transfer_timeout_s/,
    ],
  ])("refuses a room key under kind = slot: %s", (_label, from, to, reason) => {
    expect(() => parseRunnerConfig(variant(from, to), HOME)).toThrow(reason);
  });

  // VT-6: the room's probe is the job's collect, bounded by transfer_timeout_s (design rev 63).
  it.each([
    ["slot", variant('slot = "f"', 'slot = "f"\nprobe_timeout_s = 15')],
    ["room", roomVariant('room = "assistant"', 'room = "assistant"\nprobe_timeout_s = 15')],
  ])("probe_timeout_s under kind = %s refuses start: the probe is a collect", (_kind, toml) => {
    expect(() => parseRunnerConfig(toml, HOME)).toThrow(/door.*probe_timeout_s/);
  });

  it("refuses a repo's room keys when there is no door", () => {
    const withRoomKey = variant(
      'guest_path = "/work/repos/satan"',
      'guest_path = "/w"\nquarantine = "/q"',
    ).replace(/\[door\][^]*$/, "");
    expect(() => parseRunnerConfig(withRoomKey, HOME)).toThrow(/repo\.satan.*quarantine/);
  });

  it.each([
    ["slot", 'room = "assistant"', 'room = "assistant"\nslot = "f"', /door.*slot/],
    ["host", 'room = "assistant"', 'room = "assistant"\nhost = "10.99.0.2"', /door.*host/],
    ["profile", 'room = "assistant"', 'room = "assistant"\nprofile = "satan"', /door.*profile/],
    [
      "[door] quarantine",
      'room = "assistant"',
      'room = "assistant"\nquarantine = "/q"',
      /door.*quarantine/,
    ],
  ])("refuses a slot key under kind = room: %s", (_label, from, to, reason) => {
    expect(() => parseRunnerConfig(roomVariant(from, to), HOME)).toThrow(reason);
  });

  it.each([
    ["slot", 'slot = "f"\n'],
    ["quarantine", 'quarantine = "~/state/collect/f.git"\n'],
    ["host", 'host = "10.99.0.2"\n'],
    ["user", 'user = "agent"\n'],
    ["known_hosts", 'known_hosts = "~/.ssh/known_hosts"\n'],
    ["host_key_alias", 'host_key_alias = "pi-env-f"\n'],
  ])("refuses a slot door without %s: nothing is derived (I13)", (key, line) => {
    expect(() => parseRunnerConfig(variant(line, ""), HOME)).toThrow(new RegExp(`door.*${key}`));
  });

  it.each([
    ["room", 'room = "assistant"\n'],
    ["user", 'user = "agent"\n'],
    ["ssh_config", 'ssh_config = "~/.ssh/room-assistant.conf"\n'],
    ["identity", 'identity = "~/.ssh/runner"\n'],
    ["known_hosts", 'known_hosts = "/var/lib/capsule/room/assistant/known_hosts"\n'],
    ["host_key_alias", 'host_key_alias = "room-assistant"\n'],
    ["session_path", 'session_path = "/run/current-system/sw/bin/session"\n'],
  ])("refuses a room door without %s: nothing is derived (I13)", (key, line) => {
    expect(() => parseRunnerConfig(roomVariant(line, ""), HOME)).toThrow(
      new RegExp(`door.*${key}`),
    );
  });

  it.each([
    ["quarantine", 'quarantine = "/var/lib/capsule/collect/assistant/satan.git"\n'],
    ["transfer_timeout_s", "transfer_timeout_s = 600\n"],
  ])("refuses a room repo without %s", (key, line) => {
    expect(() => parseRunnerConfig(roomVariant(line, ""), HOME)).toThrow(
      new RegExp(`repo\\.satan.*${key}`),
    );
  });

  it.each([
    ["a negative transfer_timeout_s", "transfer_timeout_s = 600", "transfer_timeout_s = -1"],
    ["a string transfer_timeout_s", "transfer_timeout_s = 600", 'transfer_timeout_s = "600"'],
  ])("refuses %s", (_label, from, to) => {
    expect(() => parseRunnerConfig(roomVariant(from, to), HOME)).toThrow(/timeout_s/);
  });
});
