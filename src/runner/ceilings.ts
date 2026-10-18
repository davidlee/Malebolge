// Ceiling arithmetic (design §5.4, DEC-057). Pure: the model gate, the
// deadline timer and the warning read these; none of them does arithmetic of
// its own. Times are epoch milliseconds. `modelRequests` is the gate's one
// durable count over every gated entry point; here it is an opaque integer.

import { CEILING_KEYS, type Ceilings, type CeilingKey } from "./config.ts";
import type { EndReason } from "./vocab.ts";

/** Spend so far: the gate's attempt count, and tokens and cost from `pi.usage`. */
export interface Usage {
  modelRequests: number;
  tokens: number;
  costUsd: number;
}

/** What one request to the job's model can cost at most. */
export interface ModelLimits {
  maxOutputTokens: number;
  outputCostPerToken: number;
}

export interface Budget {
  ceilings: Ceilings;
  /** `[maxima].soft_threshold`, in (0, 1). */
  softThreshold: number;
  /** `undefined` when usage cannot be read: the gate denies (I10). */
  used: Usage | undefined;
  /** `active_ms`: closed running segments. */
  activeMs: number;
  /** Start of the current running segment; absent when not running. */
  runningSince?: number;
  now: number;
  model: ModelLimits;
}

export type Exhaustion = Extract<EndReason, "ceiling_exceeded" | "usage_unavailable">;

/** `active_ms` with the running segment that started at `runningSince` closed at `now`. */
export const closeSegment = (activeMs: number, runningSince: number, now: number): number =>
  activeMs + (now - runningSince);

/**
 * Active wall-clock so far. Waiting accrues nothing; a crash interval inside
 * the running segment is charged (fail closed).
 */
export const activeWallClockMs = (
  activeMs: number,
  runningSince: number | undefined,
  now: number,
): number => (runningSince === undefined ? activeMs : closeSegment(activeMs, runningSince, now));

/** Spend per ceiling key, in ceiling units; usage keys absent when usage is unreadable. */
function spent(budget: Budget): Partial<Ceilings> {
  const wallClock = {
    active_wall_clock_s: activeWallClockMs(budget.activeMs, budget.runningSince, budget.now) / 1000,
  };
  const { used } = budget;
  return used === undefined
    ? wallClock
    : {
        ...wallClock,
        model_requests: used.modelRequests,
        cost_usd: used.costUsd,
        tokens: used.tokens,
      };
}

/** What is left of each ceiling whose spend is known. */
export function remaining(budget: Budget): Partial<Ceilings> {
  const spend = spent(budget);
  const left: Partial<Ceilings> = {};
  for (const key of CEILING_KEYS) {
    const value = spend[key];
    if (value !== undefined) {
      left[key] = budget.ceilings[key] - value;
    }
  }
  return left;
}

/** Why the gate must refuse the next request, if it must. */
export function exhausted(budget: Budget): Exhaustion | undefined {
  if (Object.values(remaining(budget)).some((left) => left <= 0)) {
    return "ceiling_exceeded";
  }
  return budget.used === undefined ? "usage_unavailable" : undefined;
}

/**
 * The next request's output cap: the least of the model's limit, the
 * remaining tokens, and the tokens the remaining cost buys. 0 when usage is
 * unreadable.
 */
export function maxTokens(budget: Budget): number {
  const { tokens, cost_usd: cost } = remaining(budget);
  if (tokens === undefined || cost === undefined) {
    return 0;
  }
  const price = budget.model.outputCostPerToken;
  const affordable = price > 0 ? Math.floor(cost / price) : Number.POSITIVE_INFINITY;
  return Math.max(0, Math.min(budget.model.maxOutputTokens, tokens, affordable));
}

/** Whether `left` of a ceiling is under one request's allowance (OQ-6). */
const UNDER_ONE_REQUEST: Record<CeilingKey, (left: number, model: ModelLimits) => boolean> = {
  model_requests: (left) => left <= 1,
  tokens: (left, model) => left < model.maxOutputTokens,
  cost_usd: (left, model) => left < model.maxOutputTokens * model.outputCostPerToken,
  active_wall_clock_s: () => false,
};

/**
 * Whether the one warning is due: any ceiling spent to its soft threshold,
 * or left under one request's allowance, whichever comes first.
 */
export function shouldWarn(budget: Budget): boolean {
  const spend = spent(budget);
  return CEILING_KEYS.some((key) => {
    const value = spend[key];
    if (value === undefined) {
      return false;
    }
    const ceiling = budget.ceilings[key];
    return (
      value >= budget.softThreshold * ceiling ||
      UNDER_ONE_REQUEST[key](ceiling - value, budget.model)
    );
  });
}
