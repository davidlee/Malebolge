import { describe, expect, it } from "vitest";
import type { JsonRecord } from "../../src/json.ts";
import { type Ceilings, parseRunnerConfig } from "../../src/runner/config.ts";
import {
  checkCeilingsWithinMaxima,
  pickTagRule,
  type PolicyJob,
  recordedPolicy,
  resolvePolicy,
} from "../../src/runner/policy.ts";
import { checkSubmit, parseRequest, type SubmitRequest } from "../../src/runner/protocol.ts";
import { exampleConfig, FIX_SCOPE, HOME, scopedConfig, variant } from "./config-fixture.ts";
import { codeOf } from "./refusal-fixture.ts";

const MAXIMA: Ceilings = {
  model_requests: 200,
  cost_usd: 2,
  tokens: 2_000_000,
  active_wall_clock_s: 3600,
};

const JOB: PolicyJob = { mode: "fix", tags: [], repo: "satan" };

/** The example config with extra TOML appended (new tables only). */
const withTables = (toml: string): ReturnType<typeof exampleConfig> =>
  parseRunnerConfig(variant("[door]", `${toml}\n[door]`), HOME);

describe("policy ladder: layers", () => {
  it("starts from built-in ceilings equal to the maxima, model from [defaults]", () => {
    const config = parseRunnerConfig(variant('thinking_level = "low"\ncost_usd = 1.5', ""), HOME);
    const policy = resolvePolicy(config, JOB);
    expect(policy.model).toBe("gateway/test-model");
    expect(policy.ceilings).toEqual(MAXIMA);
    expect(policy).not.toHaveProperty("thinkingLevel");
  });

  it("[defaults] applies, the rest falls through to built-in", () => {
    const policy = resolvePolicy(exampleConfig(), JOB);
    expect(policy.thinkingLevel).toBe("low");
    expect(policy.ceilings).toEqual({ ...MAXIMA, cost_usd: 1.5 });
  });

  it("mode layer wins over [defaults]", () => {
    const config = withTables(
      `[mode.deep]\nmodel = "gateway/deep"\nthinking_level = "high"\n${FIX_SCOPE}`,
    );
    const policy = resolvePolicy(config, { ...JOB, mode: "deep" });
    expect(policy.model).toBe("gateway/deep");
    expect(policy.thinkingLevel).toBe("high");
  });

  it("a mode's scope stays outside the ladder: the policy carries neither axis", () => {
    const config = scopedConfig('repos = ["satan"]\nallowed_paths = ["src/"]');
    const policy = resolvePolicy(config, JOB);
    expect(policy).not.toHaveProperty("repos");
    expect(policy).not.toHaveProperty("allowedPaths");
  });

  it("tag rule wins over mode", () => {
    const config = withTables(`[mode.deep]\nmodel = "gateway/deep"\n${FIX_SCOPE}`);
    const policy = resolvePolicy(config, { ...JOB, mode: "deep", tags: ["code", "cheap"] });
    expect(policy.model).toBe("gateway/cheap");
    expect(policy.ceilings.tokens).toBe(500_000);
  });

  it("repo entry beats tag", () => {
    const config = parseRunnerConfig(
      variant('default_branch = "main"', 'default_branch = "main"\nmodel = "gateway/pinned"'),
      HOME,
    );
    const policy = resolvePolicy(config, { ...JOB, tags: ["cheap", "code"] });
    expect(policy.model).toBe("gateway/pinned");
  });

  it("a layer overlays only the keys it sets", () => {
    const policy = resolvePolicy(exampleConfig(), { ...JOB, tags: ["cheap", "code"] });
    expect(policy.thinkingLevel).toBe("low");
    expect(policy.ceilings.cost_usd).toBe(1.5);
  });

  it("collects mode then repo prompt fragments", () => {
    expect(resolvePolicy(exampleConfig(), JOB).promptFragments).toEqual([
      "Fix mode: keep the change small.",
      "Repo note.",
    ]);
  });

  it("is JSON-serialisable for the jobs.policy column", () => {
    const policy = resolvePolicy(exampleConfig(), JOB);
    expect(JSON.parse(JSON.stringify(policy))).toEqual(policy);
  });

  it("refuses a mode or repo the config does not name", () => {
    expect(codeOf(() => resolvePolicy(exampleConfig(), { ...JOB, repo: "nope" }))).toBe(
      "invalid_request",
    );
    expect(codeOf(() => resolvePolicy(exampleConfig(), { ...JOB, mode: "nope" }))).toBe(
      "invalid_request",
    );
  });
});

describe("policy ladder: tag rule", () => {
  const rules = new Map([
    ["cheap+code", { model: "joined", ceilings: {} }],
    ["cheap", { model: "single-cheap", ceilings: {} }],
    ["writing", { model: "single-writing", ceilings: {} }],
  ]);

  it("sorted-joined tag key is independent of tag order", () => {
    expect(pickTagRule(rules, ["code", "cheap"])?.model).toBe("joined");
    expect(pickTagRule(rules, ["cheap", "code"])?.model).toBe("joined");
  });

  it("falls back to the first single tag in sorted order", () => {
    expect(pickTagRule(rules, ["writing", "cheap"])?.model).toBe("single-cheap");
  });

  it("no tags or no matching tag rule skips the layer", () => {
    expect(pickTagRule(rules, [])).toBeUndefined();
    expect(pickTagRule(rules, ["other"])).toBeUndefined();
  });
});

describe("policy ladder: ceilings against maxima", () => {
  it("clamps a config ceiling above its maximum", () => {
    const config = withTables("[tag.big]\ntokens = 9_000_000\nmodel_requests = 999");
    const policy = resolvePolicy(config, { ...JOB, tags: ["big"] });
    expect(policy.ceilings.tokens).toBe(MAXIMA.tokens);
    expect(policy.ceilings.model_requests).toBe(MAXIMA.model_requests);
  });

  it("submit below the default lowers it", () => {
    const policy = resolvePolicy(exampleConfig(), { ...JOB, ceilings: { cost_usd: 0.25 } });
    expect(policy.ceilings.cost_usd).toBe(0.25);
  });

  it("submit ceiling overrides every config layer, up to the maximum", () => {
    const policy = resolvePolicy(exampleConfig(), {
      ...JOB,
      tags: ["cheap", "code"],
      ceilings: { tokens: 1_000_000 },
    });
    expect(policy.ceilings.tokens).toBe(1_000_000);
  });

  it("submit equal to the maximum is accepted", () => {
    const policy = resolvePolicy(exampleConfig(), { ...JOB, ceilings: { cost_usd: 2 } });
    expect(policy.ceilings.cost_usd).toBe(2);
  });

  it("submit above the maximum is refused with ceiling_above_maximum, not clamped", () => {
    const run = (): unknown =>
      resolvePolicy(exampleConfig(), { ...JOB, ceilings: { active_wall_clock_s: 3601 } });
    expect(codeOf(run)).toBe("ceiling_above_maximum");
  });

  it("checkCeilingsWithinMaxima names the offending key", () => {
    expect(() => {
      checkCeilingsWithinMaxima({ tokens: 2_000_001 }, MAXIMA);
    }).toThrow(/tokens/);
    expect(() => {
      checkCeilingsWithinMaxima({ ...MAXIMA }, MAXIMA);
    }).not.toThrow();
  });

  it("submit refuses early: checkSubmit raises ceiling_above_maximum", () => {
    const request = parseRequest(
      JSON.stringify({
        op: "submit",
        requestId: "r1",
        submissionId: "s1",
        mode: "fix",
        directive: "d",
        repo: "satan",
        allowedPaths: ["satan/"],
        ceilings: { cost_usd: 2.5 },
      }),
    );
    const submit: SubmitRequest | undefined = request.op === "submit" ? request : undefined;
    expect(submit).toBeDefined();
    if (submit !== undefined) {
      expect(codeOf(() => checkSubmit(submit, exampleConfig()))).toBe("ceiling_above_maximum");
    }
  });
});

describe("recordedPolicy: the policy a restarted run keeps (AS-2)", () => {
  const recorded = (): JsonRecord => ({ ...resolvePolicy(exampleConfig(), JOB) });

  it("reads back what resolvePolicy recorded", () => {
    expect(recordedPolicy(recorded())).toEqual(resolvePolicy(exampleConfig(), JOB));
    const thinking = { ...recorded(), thinkingLevel: "high" };
    expect(recordedPolicy(thinking).thinkingLevel).toBe("high");
  });

  it("refuses a record resolvePolicy could not have written", () => {
    expect(() => recordedPolicy({ ...recorded(), ceilings: undefined })).toThrow(/lacks ceiling/);
    expect(() => recordedPolicy({ ...recorded(), thinkingLevel: "loud" })).toThrow(/thinkingLevel/);
    expect(() => recordedPolicy({ ...recorded(), model: "" })).toThrow(/model/);
  });
});
