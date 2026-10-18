import { describe, expect, it } from "vitest";
import { type Ceilings, parseRunnerConfig } from "../../src/runner/config.ts";
import {
  checkCeilingsWithinMaxima,
  pickTagRule,
  type PolicyJob,
  resolvePolicy,
} from "../../src/runner/policy.ts";
import { composePrompt, type PromptJob } from "../../src/runner/prompt.ts";
import { checkSubmit, parseRequest, type SubmitRequest } from "../../src/runner/protocol.ts";
import { exampleConfig, HOME, variant } from "./config-fixture.ts";
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
    const config = withTables('[mode.deep]\nmodel = "gateway/deep"\nthinking_level = "high"');
    const policy = resolvePolicy(config, { ...JOB, mode: "deep" });
    expect(policy.model).toBe("gateway/deep");
    expect(policy.thinkingLevel).toBe("high");
  });

  it("tag rule wins over mode", () => {
    const config = withTables('[mode.deep]\nmodel = "gateway/deep"');
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

const PROMPT_JOB: PromptJob = {
  id: "pj-1",
  mode: "fix",
  directive: "Fix the lint warning.",
  allowedPaths: ["satan/satan-db.el", "satan/test/"],
  baseRef: "main",
  context: {},
  source: {},
};

const POLICY = resolvePolicy(exampleConfig(), JOB);

const compose = (job: Partial<PromptJob> = {}): string =>
  composePrompt("Corpus prompt.\n", POLICY, { ...PROMPT_JOB, ...job });

describe("prompt", () => {
  it("is a pure function: same inputs give identical output", () => {
    expect(compose()).toBe(compose());
  });

  it("puts the corpus prompt first, then fragments in order, then the job block", () => {
    const text = compose();
    const order = ["Corpus prompt.", "Fix mode:", "Repo note.", "# patch-agent job pj-1"].map(
      (part) => text.indexOf(part),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("names the job, mode, base branch and job branch", () => {
    const text = compose();
    expect(text).toContain(
      "# patch-agent job pj-1\nMode: fix\nBase branch: main\nJob branch: job/pj-1",
    );
  });

  it("carries the directive and the allowed paths as bullets", () => {
    const text = compose();
    expect(text).toContain("## Directive\n\nFix the lint warning.");
    expect(text).toContain("## Allowed paths\n\n- satan/satan-db.el\n- satan/test/");
  });

  it("states the commit-your-work and notes conventions", () => {
    const text = compose();
    expect(text).toContain("Commit your work on `job/pj-1`");
    expect(text).toContain("Uncommitted work never leaves the room");
    expect(text).toMatch(/notes/i);
  });

  it("gives the commit footer and subject format", () => {
    const text = compose();
    expect(text).toContain("    Patch-agent job: pj-1\n    Source: none");
    expect(text).toContain(
      "Subject line format: `<mode>: <short imperative summary>`, with mode=fix.",
    );
  });

  it("drops the elisp Checks and Branch sections (DEC-059)", () => {
    const text = compose();
    expect(text).not.toContain("## Checks");
    expect(text).not.toMatch(/^Branch:/m);
  });

  it("omits the context section when no context key renders", () => {
    expect(compose()).not.toContain("## Context");
    expect(compose({ context: { unknown: "x", proposal_id: { nested: true } } })).not.toContain(
      "## Context",
    );
  });
});

describe("prompt: context and source", () => {
  it("renders each known context key in a fixed order, dropping unknown keys", () => {
    const text = compose({
      context: {
        source: { kind: "note" },
        mode_run_id: "m-9",
        proposal_id: "p-3",
        memory_matches: [{}, {}, {}],
        note_context: "a note",
        extra: "dropped",
      },
    });
    expect(text).toContain(
      '## Context\n\nnote context:\na note\n\nmemory matches: 3\n\nproposal: p-3\n\nmode run: m-9\n\nsource: {"kind":"note"}',
    );
    expect(text).not.toContain("dropped");
  });

  it.each([
    [{}, "none"],
    [{ kind: "journal", file: "j.org", line: 12 }, "journal j.org:12"],
    [{ kind: "journal", file: "j.org" }, "j.org"],
    [{ kind: "inbox" }, "inbox"],
    [{ ref: "x" }, '{"ref":"x"}'],
  ])("source line for %j is %s", (source, line) => {
    expect(compose({ source })).toContain(`    Source: ${line}\n`);
  });
});
