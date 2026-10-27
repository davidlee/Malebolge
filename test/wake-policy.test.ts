// VT-2: the wake policy is clock arithmetic plus a dice roll, so its tests drive
// it through a fake environment: a stopped clock, a scripted random sequence and
// a scripted presence probe (SL-034 design § WakePolicy; PHASE-01 VT-2).

import { describe, expect, it } from "vitest";
import {
  JITTER,
  PRESENCE_WEIGHT,
  type EpisodeClass,
  type Gate,
  type Presence,
  type QuietWindow,
  type WakeEnv,
  type WakePolicy,
  type WakeSettings,
  v0Policy,
} from "../src/wake/policy.ts";

const FLOOR = 300_000;
const CEILING = 7_200_000;
/** 13:00-14:00: a window that does not wrap midnight. */
const AFTERNOON: QuietWindow = { startMin: 13 * 60, endMin: 14 * 60 };
const CLASSES: readonly EpisodeClass[] = ["attend", "seclude"];

/** Wake settings: the contract's defaults, with `overrides` replacing them. */
function settings(overrides: Partial<WakeSettings> = {}): WakeSettings {
  return {
    enabled: true,
    floorMs: FLOOR,
    ceilingMs: CEILING,
    quiet: { startMin: 23 * 60 + 20, endMin: 7 * 60 },
    topic: "room",
    ...overrides,
  };
}

/** A local wall-clock instant, built locally so the tests hold in any zone. */
const local = (day: number, hour: number, minute: number): number =>
  new Date(2026, 9, day, hour, minute).getTime();

interface Probe {
  readonly env: WakeEnv;
  /** How many times the policy asked presence. */
  readonly presenceCalls: { count: number };
}

/** A fake environment: the clock stopped at `now`, `random` and presence scripted. */
function probe(now: number, random: () => number, presence: () => Promise<Presence>): Probe {
  const presenceCalls = { count: 0 };
  return {
    presenceCalls,
    env: {
      now: () => now,
      random,
      presence: (): Promise<Presence> => {
        presenceCalls.count += 1;
        return presence();
      },
    },
  };
}

/** A random source drawing `draws` in order, repeating the last once they run out. */
function scripted(draws: readonly number[]): () => number {
  let index = 0;
  return () => {
    const draw = draws[Math.min(index, draws.length - 1)];
    index += 1;
    return draw ?? 0.5;
  };
}

/** A seeded PRNG (mulberry32), for a reproducible sweep of draws. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const PRESENT = (): Promise<Presence> => Promise.resolve("present");
const AWAY = (): Promise<Presence> => Promise.resolve("away");
const UNKNOWN = (): Promise<Presence> => Promise.resolve("unknown");
const FAILED = (): Promise<Presence> => Promise.reject(new Error("satan-mcp unavailable"));

/** When a deferring gate next wakes. */
function untilOf(gate: Gate): number {
  if (gate.kind !== "defer") {
    throw new Error(`expected a deferring gate, got ${gate.kind}`);
  }
  return gate.until;
}

interface GateOptions {
  readonly at: number;
  readonly draws: readonly number[];
  readonly presence?: () => Promise<Presence>;
  readonly episodeClass?: EpisodeClass;
  readonly policy?: WakePolicy;
}

interface GateRun {
  readonly gate: Gate;
  readonly presenceCalls: number;
}

/** The gate reached at `at`, with `draws` and `presence` scripted. */
async function gateAt(options: GateOptions): Promise<GateRun> {
  const fake = probe(options.at, scripted(options.draws), options.presence ?? PRESENT);
  const policy = options.policy ?? v0Policy(settings());
  const gate = await policy.gate({ episodeClass: options.episodeClass ?? "attend" }, fake.env);
  return { gate, presenceCalls: fake.presenceCalls.count };
}

describe("v0Policy.schedule", () => {
  const now = local(28, 10, 0);
  const policy = v0Policy(settings());
  // A draw of 0.5 is a jitter of exactly 0: two times the draw, less one, is zero.
  const scheduled = (draw: number, requested: number | undefined): number =>
    policy.schedule(requested, probe(now, scripted([draw]), PRESENT).env);

  it("clamps a request before the floor up to now + floor", () => {
    expect(scheduled(0.5, now - 60_000)).toBe(now + FLOOR);
  });

  it("clamps a request past the ceiling down to now + ceiling", () => {
    expect(scheduled(0.5, now + 10 * CEILING)).toBe(now + CEILING);
  });

  it("defaults an absent request to now + ceiling", () => {
    expect(scheduled(0.5, undefined)).toBe(now + CEILING);
  });

  it("leaves a request between the bounds where it was asked for", () => {
    expect(scheduled(0.5, now + 3_600_000)).toBe(now + 3_600_000);
  });

  it("keeps a thousand seeded draws inside the bounds and within ±10%", () => {
    const env = probe(now, mulberry32(20_261_028), PRESENT).env;
    for (let draw = 0; draw < 1000; draw += 1) {
      const requested = draw % 2 === 0 ? undefined : now + (draw / 1000) * CEILING;
      const wake = policy.schedule(requested, env);
      const wanted = Math.min(Math.max((requested ?? now + CEILING) - now, FLOOR), CEILING);
      expect(wake).toBeGreaterThanOrEqual(now + FLOOR);
      expect(wake).toBeLessThanOrEqual(now + CEILING);
      expect(Math.abs(wake - now - wanted)).toBeLessThanOrEqual(wanted * JITTER + 1);
    }
  });

  it("makes a draw of 0 -10% and a draw near 1 +10% of the offset", () => {
    const wanted = CEILING / 2;
    expect(scheduled(0, now + wanted) - now).toBeCloseTo(wanted * 0.9, -3);
    expect(scheduled(0.999999, now + wanted) - now).toBeCloseTo(wanted * 1.1, -3);
  });

  it("stays inside the bounds at the extreme draws", () => {
    for (const draw of [0, 0.999999]) {
      const wake = scheduled(draw, undefined);
      expect(wake).toBeGreaterThanOrEqual(now + FLOOR);
      expect(wake).toBeLessThanOrEqual(now + CEILING);
    }
  });
});

describe("the quiet window", () => {
  const afternoon = v0Policy(settings({ quiet: AFTERNOON }));
  const wrapped = v0Policy(settings());
  /** The gate `policy` reaches at local instant `at`, with `draws` scripted. */
  const gateIn = (policy: WakePolicy, at: number, draws: readonly number[]): Promise<GateRun> =>
    gateAt({ at, draws, policy });

  it("fires before a window that does not wrap", async () => {
    const { gate, presenceCalls } = await gateIn(afternoon, local(28, 12, 59), [0.5]);
    expect(gate).toEqual({ kind: "fire" });
    expect(presenceCalls).toBe(1);
  });

  it("defers inside it to its end, plus a draw below the floor", async () => {
    const { gate, presenceCalls } = await gateIn(afternoon, local(28, 13, 30), [0.5]);
    expect(gate).toEqual({ kind: "defer", until: local(28, 14, 0) + FLOOR / 2, reason: "quiet" });
    expect(presenceCalls).toBe(0);
  });

  it("is quiet exactly at the window's start", async () => {
    const { gate, presenceCalls } = await gateIn(afternoon, local(28, 13, 0), [0]);
    expect(gate).toEqual({ kind: "defer", until: local(28, 14, 0), reason: "quiet" });
    expect(presenceCalls).toBe(0);
  });

  it("fires exactly at the window's end", async () => {
    const { gate } = await gateIn(afternoon, local(28, 14, 0), [0.5]);
    expect(gate).toEqual({ kind: "fire" });
  });

  it("defers before midnight to the next day's end", async () => {
    const { gate, presenceCalls } = await gateIn(wrapped, local(28, 23, 30), [0.5]);
    expect(gate).toEqual({ kind: "defer", until: local(29, 7, 0) + FLOOR / 2, reason: "quiet" });
    expect(presenceCalls).toBe(0);
  });

  it("defers after midnight to the same day's end", async () => {
    const { gate, presenceCalls } = await gateIn(wrapped, local(28, 2, 0), [0.5]);
    expect(gate).toEqual({ kind: "defer", until: local(28, 7, 0) + FLOOR / 2, reason: "quiet" });
    expect(presenceCalls).toBe(0);
  });

  it("is quiet exactly at a wrapped window's start", async () => {
    const { gate, presenceCalls } = await gateIn(wrapped, local(28, 23, 20), [0]);
    expect(gate).toEqual({ kind: "defer", until: local(29, 7, 0), reason: "quiet" });
    expect(presenceCalls).toBe(0);
  });

  it("fires exactly at a wrapped window's end", async () => {
    const { gate } = await gateIn(wrapped, local(28, 7, 0), [0.5]);
    expect(gate).toEqual({ kind: "fire" });
  });

  it("holds nothing when the window is empty", async () => {
    const empty = v0Policy(settings({ quiet: { startMin: 600, endMin: 600 } }));
    const { gate } = await gateIn(empty, local(28, 10, 0), [0.5]);
    expect(gate).toEqual({ kind: "fire" });
  });

  it("fires just before a wrapped window's start", async () => {
    const { gate } = await gateIn(wrapped, local(28, 23, 19), [0.5]);
    expect(gate).toEqual({ kind: "fire" });
  });
});

describe("disabled wakes", () => {
  const start = local(28, 10, 0);
  const disabled = v0Policy(settings({ enabled: false }));

  it("defers by one step, without asking presence", async () => {
    const { gate, presenceCalls } = await gateAt({ at: start, draws: [0.5], policy: disabled });
    expect(gate).toEqual({ kind: "defer", until: start + FLOOR, reason: "disabled" });
    expect(presenceCalls).toBe(0);
  });

  it("are checked before the quiet window", async () => {
    const inside = local(28, 23, 30);
    const { gate, presenceCalls } = await gateAt({ at: inside, draws: [0.5], policy: disabled });
    expect(gate).toEqual({ kind: "defer", until: inside + FLOOR, reason: "disabled" });
    expect(presenceCalls).toBe(0);
  });

  it("scale the step by the same jitter", async () => {
    const low = await gateAt({ at: start, draws: [0], policy: disabled });
    const high = await gateAt({ at: start, draws: [0.999999], policy: disabled });
    expect(untilOf(low.gate)).toBeCloseTo(start + FLOOR * 0.9, 0);
    expect(untilOf(high.gate)).toBeCloseTo(start + FLOOR * 1.1, 0);
  });
});

describe("the presence gate", () => {
  const start = local(28, 10, 0);

  it("fires an attending agent that is present", async () => {
    const { gate, presenceCalls } = await gateAt({ at: start, draws: [0.5] });
    expect(gate).toEqual({ kind: "fire" });
    expect(presenceCalls).toBe(1);
  });

  it("fires a secluded agent that is away", async () => {
    const { gate } = await gateAt({
      at: start,
      draws: [0.5],
      presence: AWAY,
      episodeClass: "seclude",
    });
    expect(gate).toEqual({ kind: "fire" });
  });

  it.each(CLASSES)("fires a %s agent whose presence is unknown", async (episodeClass) => {
    const { gate } = await gateAt({ at: start, draws: [0.5], presence: UNKNOWN, episodeClass });
    expect(gate).toEqual({ kind: "fire" });
  });

  it("fires when the presence probe rejects, as if unknown", async () => {
    const { gate } = await gateAt({ at: start, draws: [0.5], presence: FAILED });
    expect(gate).toEqual({ kind: "fire" });
  });

  it("fires an attending away agent on a draw under the weight", async () => {
    const { gate } = await gateAt({ at: start, draws: [0.3], presence: AWAY });
    expect(gate).toEqual({ kind: "fire" });
  });

  it("defers an attending away agent on a draw at the weight", async () => {
    const { gate, presenceCalls } = await gateAt({
      at: start,
      draws: [PRESENCE_WEIGHT, 0.5],
      presence: AWAY,
    });
    expect(gate).toEqual({ kind: "defer", until: start + FLOOR, reason: "presence" });
    expect(presenceCalls).toBe(1);
  });

  it("defers an attending away agent on a draw above the weight, by one step", async () => {
    const { gate } = await gateAt({ at: start, draws: [0.9, 0], presence: AWAY });
    expect(untilOf(gate)).toBeCloseTo(start + FLOOR * 0.9, 0);
  });

  it("defers a secluded agent that is present", async () => {
    const { gate } = await gateAt({
      at: start,
      draws: [0.5, 0.5],
      presence: PRESENT,
      episodeClass: "seclude",
    });
    expect(gate).toEqual({ kind: "defer", until: start + FLOOR, reason: "presence" });
  });
});

describe("the tuning constants", () => {
  it("jitters by 10% and favours presence at 40%", () => {
    expect(JITTER).toBe(0.1);
    expect(PRESENCE_WEIGHT).toBe(0.4);
  });
});
