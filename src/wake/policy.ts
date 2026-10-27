// When a wake happens (SL-034 design § WakePolicy): clock arithmetic plus a dice
// roll, with satan-mcp's presence probe as the last and dearest input. The clock,
// the dice and the probe arrive as WakeEnv so that later factors extend the
// environment rather than the policy (DEC-128).

/** What satan-mcp last saw the room user doing. */
export type Presence = "present" | "away" | "unknown";

/** How an episode would rather find the room user (SL-034). */
export type EpisodeClass = "attend" | "seclude";

/** The policy's impurities: the clock, the dice and the presence probe. */
export interface WakeEnv {
  now(): number;
  /** Uniform in [0, 1). */
  random(): number;
  /** Asks satan-mcp what the room user is doing; may reject. */
  presence(): Promise<Presence>;
}

/** Why a gate put the wake off. */
export type DeferReason = "disabled" | "quiet" | "presence";

/** Fire now, or wake again at `until` for `reason`. */
export type Gate = { kind: "fire" } | { kind: "defer"; until: number; reason: DeferReason };

/** A half-open [start, end) window of local minutes since midnight (VT-1). */
export interface QuietWindow {
  startMin: number;
  endMin: number;
}

export interface WakeSettings {
  enabled: boolean;
  floorMs: number;
  ceilingMs: number;
  quiet: QuietWindow;
  /** The heartbeat's topic. */
  topic: string;
}

export interface WakePolicy {
  /** The decided fire time for a request; `requested` absent means one ceiling on. */
  schedule(requested: number | undefined, env: WakeEnv): number;
  /** At fire: fire now, or defer until a later time. */
  gate(wake: { episodeClass: EpisodeClass }, env: WakeEnv): Promise<Gate>;
}

/** How far the dice move a decided time, either way. */
export const JITTER = 0.1;

/** How often a wake fires anyway when the room user is not the one its class favours. */
export const PRESENCE_WEIGHT = 0.4;

const MINUTE = 60_000;

/** `value` held between `low` and `high`. */
const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);

/** One draw, spread over ±JITTER. */
const jitterOf = (env: WakeEnv): number => (2 * env.random() - 1) * JITTER;

/** `now` as milliseconds since local midnight; a DST change shows as skipped or repeated ones. */
const timeOfDayOf = (now: number): number => {
  const at = new Date(now);
  return (
    at.getHours() * 3_600_000 +
    at.getMinutes() * MINUTE +
    at.getSeconds() * 1000 +
    at.getMilliseconds()
  );
};

/** Whether local time-of-day `now` is inside `window`; an empty window holds nothing. */
const insideQuiet = (window: QuietWindow, now: number): boolean => {
  const start = window.startMin * MINUTE;
  const end = window.endMin * MINUTE;
  const at = timeOfDayOf(now);
  if (start === end) {
    return false;
  }
  return start < end ? at >= start && at < end : at >= start || at < end;
};

/**
 * The next local occurrence of `window.endMin` after `now`. On a DST change an
 * end inside the skipped or repeated hour lands on its first instant, so a
 * window ending there may run an hour long or, rarely, to the next day's end.
 */
const nextEnd = (window: QuietWindow, now: number): number => {
  const end = new Date(now);
  const hours = Math.floor(window.endMin / 60);
  const minutes = window.endMin % 60;
  end.setHours(hours, minutes, 0, 0);
  if (end.getTime() <= now) {
    // Local wall-clock arithmetic: a DST change before tomorrow's end leaves it at its wall time.
    end.setDate(end.getDate() + 1);
    end.setHours(hours, minutes, 0, 0);
  }
  return end.getTime();
};

/** One step: a floor, jittered like a decided time. */
const stepOf = (settings: WakeSettings, env: WakeEnv): number =>
  settings.floorMs * (1 + jitterOf(env));

/** The decided time: `requested` (or one ceiling on) bounded, jittered, then bounded again. */
const scheduleOf = (settings: WakeSettings, env: WakeEnv, requested?: number): number => {
  const now = env.now();
  const low = now + settings.floorMs;
  const high = now + settings.ceilingMs;
  const want = clamp(requested ?? high, low, high);
  return clamp(now + (want - now) * (1 + jitterOf(env)), low, high);
};

/** Whether `episodeClass` would rather wake into this `presence`. */
const favours = (episodeClass: EpisodeClass, presence: Presence): boolean =>
  (episodeClass === "attend" && presence === "present") ||
  (episodeClass === "seclude" && presence === "away");

/** The probe's answer, a rejection read as "unknown": a broken probe must not stall every wake. */
const probed = async (env: WakeEnv): Promise<Presence> => {
  try {
    return await env.presence();
  } catch {
    return "unknown";
  }
};

/** The gate at `env.now()`: cheapest checks first, the satan-mcp call last. */
const gateOf = async (
  settings: WakeSettings,
  wake: { episodeClass: EpisodeClass },
  env: WakeEnv,
): Promise<Gate> => {
  const now = env.now();
  if (!settings.enabled) {
    return { kind: "defer", until: now + stepOf(settings, env), reason: "disabled" };
  }
  if (insideQuiet(settings.quiet, now)) {
    const until = nextEnd(settings.quiet, now) + env.random() * settings.floorMs;
    return { kind: "defer", until, reason: "quiet" };
  }
  const presence = await probed(env);
  if (
    presence === "unknown" ||
    favours(wake.episodeClass, presence) ||
    env.random() < PRESENCE_WEIGHT
  ) {
    return { kind: "fire" };
  }
  return { kind: "defer", until: now + stepOf(settings, env), reason: "presence" };
};

/** The v0 policy for `settings` (SL-034): floor, ceiling, quiet window, presence. */
export const v0Policy = (settings: WakeSettings): WakePolicy => ({
  schedule: (requested: number | undefined, env: WakeEnv): number =>
    scheduleOf(settings, env, requested),
  gate: (wake: { episodeClass: EpisodeClass }, env: WakeEnv): Promise<Gate> =>
    gateOf(settings, wake, env),
});
