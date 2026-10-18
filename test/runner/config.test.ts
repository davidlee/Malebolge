import { describe, expect, it } from "vitest";
import { parseRunnerConfig } from "../../src/runner/config.ts";
import { EXAMPLE_TOML as EXAMPLE, HOME, variant } from "./config-fixture.ts";

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
      path: "/home/test/dev/satan",
      guestPath: "/work/repos/satan",
      defaultBranch: "main",
      prompt: "Repo note.",
      ceilings: {},
    });
    expect(config.door).toEqual({
      slot: "f",
      quarantine: "/home/test/state/collect/f.git",
      host: "10.99.0.2",
      user: "agent",
      sshConfig: "/home/test/.ssh/config",
      identity: "/home/test/.ssh/id",
      knownHosts: "/home/test/.ssh/known_hosts",
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
    expect(parseRunnerConfig(text, HOME).door?.profile).toBe("satan");
  });

  it("leaves paths without a leading ~ alone", () => {
    const text = variant('path = "~/dev/satan"', 'path = "/srv/satan"');
    expect(parseRunnerConfig(text, HOME).repos.get("satan")?.path).toBe("/srv/satan");
  });
});
