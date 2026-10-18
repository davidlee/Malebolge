import { describe, expect, it } from "vitest";
import {
  activeWallClockMs,
  type Budget,
  closeSegment,
  exhausted,
  maxTokens,
  remaining,
  shouldWarn,
} from "../../src/runner/ceilings.ts";

const MINUTE = 60_000;

/** A budget with nothing spent; `overrides` replace whole fields. */
const budget = (overrides: Partial<Budget> = {}): Budget => ({
  ceilings: { model_requests: 100, cost_usd: 10, tokens: 1_000_000, active_wall_clock_s: 3600 },
  softThreshold: 0.8,
  used: { modelRequests: 0, tokens: 0, costUsd: 0 },
  activeMs: 0,
  now: 1_000_000,
  model: { maxOutputTokens: 32_000, outputCostPerToken: 0.000_01 },
  ...overrides,
});

const used = (part: Partial<NonNullable<Budget["used"]>>): Partial<Budget> => ({
  used: { modelRequests: 0, tokens: 0, costUsd: 0, ...part },
});

describe("active wall-clock (active_ms + current running segment)", () => {
  it("closeSegment adds the running segment to active_ms", () => {
    expect(closeSegment(5 * MINUTE, 1_000, 1_000 + 2 * MINUTE)).toBe(7 * MINUTE);
  });

  it("charges the current segment while running", () => {
    expect(activeWallClockMs(5 * MINUTE, 1_000, 1_000 + MINUTE)).toBe(6 * MINUTE);
  });

  it("waiting time is excluded: no runningSince, no accrual", () => {
    expect(activeWallClockMs(5 * MINUTE, undefined, 99 * MINUTE)).toBe(5 * MINUTE);
  });

  it("a crash interval is charged: now long after runningSince counts", () => {
    const afterCrash = activeWallClockMs(0, 0, 50 * MINUTE);
    expect(afterCrash).toBe(50 * MINUTE);
    expect(remaining(budget({ runningSince: 0, now: 50 * MINUTE })).active_wall_clock_s).toBe(600);
  });
});

describe("remaining and exhausted", () => {
  it("remaining is each ceiling less what is spent, wall clock in seconds", () => {
    const spent = budget({
      ...used({ modelRequests: 40, tokens: 250_000, costUsd: 2.5 }),
      activeMs: 600_000,
    });
    expect(remaining(spent)).toEqual({
      model_requests: 60,
      cost_usd: 7.5,
      tokens: 750_000,
      active_wall_clock_s: 3000,
    });
  });

  it("nothing is exhausted with budget left", () => {
    expect(exhausted(budget())).toBeUndefined();
  });

  it.each([
    ["model_requests", used({ modelRequests: 100 })],
    ["cost_usd", used({ costUsd: 10.01 })],
    ["tokens", used({ tokens: 1_000_000 })],
    ["active_wall_clock_s", { activeMs: 3_600_000 }],
  ])("a spent %s ceiling is ceiling_exceeded", (_key, overrides) => {
    expect(exhausted(budget(overrides))).toBe("ceiling_exceeded");
  });

  it("unreadable usage denies (usage_unavailable)", () => {
    const unread = budget({ used: undefined });
    expect(exhausted(unread)).toBe("usage_unavailable");
    expect(remaining(unread)).toEqual({ active_wall_clock_s: 3600 });
  });

  it("a spent wall clock is ceiling_exceeded even with usage unreadable", () => {
    expect(exhausted(budget({ used: undefined, activeMs: 3_600_000 }))).toBe("ceiling_exceeded");
  });
});

describe("maxTokens", () => {
  it("is the model limit when budget is ample", () => {
    expect(maxTokens(budget())).toBe(32_000);
  });

  it("is the remaining tokens when fewer than the model limit", () => {
    expect(maxTokens(budget(used({ tokens: 990_000 })))).toBe(10_000);
  });

  it("is what the remaining cost buys at the output price, rounded down", () => {
    expect(maxTokens(budget(used({ costUsd: 9.950_005 })))).toBe(4999);
  });

  it("is 0 when usage is unreadable or the budget is spent", () => {
    expect(maxTokens(budget({ used: undefined }))).toBe(0);
    expect(maxTokens(budget(used({ tokens: 2_000_000 })))).toBe(0);
  });

  it("a free model is bounded by tokens alone", () => {
    expect(maxTokens(budget({ model: { maxOutputTokens: 8000, outputCostPerToken: 0 } }))).toBe(
      8000,
    );
  });
});

describe("warning: soft_threshold or one request's allowance", () => {
  it("does not warn below the soft_threshold with allowance left", () => {
    expect(shouldWarn(budget(used({ modelRequests: 79, tokens: 799_999, costUsd: 7.9 })))).toBe(
      false,
    );
  });

  it.each([
    ["model_requests", used({ modelRequests: 80 })],
    ["cost_usd", used({ costUsd: 8 })],
    ["tokens", used({ tokens: 800_000 })],
    ["active_wall_clock_s", { activeMs: 2_880_000 }],
  ])("warns at exactly the soft_threshold of %s", (_key, overrides) => {
    expect(shouldWarn(budget(overrides))).toBe(true);
  });

  const small = budget({
    ceilings: { model_requests: 3, cost_usd: 1, tokens: 50_000, active_wall_clock_s: 3600 },
  });

  it.each([
    ["model_requests (remaining <= 1)", { ...small, ...used({ modelRequests: 2 }) }],
    ["tokens (remaining < model max output)", { ...small, ...used({ tokens: 20_000 }) }],
    ["cost (remaining < max output x price)", { ...small, ...used({ costUsd: 0.7 }) }],
  ])("warns before the threshold from one request's allowance: %s", (_name, warned) => {
    expect(shouldWarn(warned)).toBe(true);
  });

  it("wall clock warns from the threshold only", () => {
    expect(shouldWarn({ ...small, activeMs: 3_599_000 })).toBe(true);
    expect(shouldWarn({ ...small, activeMs: 2_879_000 })).toBe(false);
  });

  it("unreadable usage warns from wall clock alone", () => {
    expect(shouldWarn(budget({ used: undefined }))).toBe(false);
    expect(shouldWarn(budget({ used: undefined, activeMs: 2_880_000 }))).toBe(true);
  });
});
