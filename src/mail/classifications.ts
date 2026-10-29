// The daemon's classification cache (a private LRU) and the read-through that
// fills it (SL-007 design, § The classification cache).

import type { ClassifyOutcome, MailSource } from "./source.ts";

/** The most ids the daemon's classification cache holds. */
export const CLASSIFICATIONS_MAX = 2000;

/** An outcome the cache may hold: a classification, or screwtape's `too_large`. */
export type Cached =
  | Extract<ClassifyOutcome, { classified: unknown }>
  | { id: string; unclassified: "too_large" };

/** The daemon's classifications: at most `CLASSIFICATIONS_MAX` ids; a get or set refreshes, the oldest is evicted. */
export interface ClassificationCache {
  get(id: string): Cached | undefined;
  set(id: string, outcome: Cached): void;
}

/** An empty cache for one daemon: a `Map` ordered by recency, oldest first. */
export function classificationCache(): ClassificationCache {
  const entries = new Map<string, Cached>();

  /** Moves `id` to the young end: a `Map` keeps insertion order, so delete then set refreshes. */
  const refresh = (id: string, cached: Cached): Cached => {
    entries.delete(id);
    entries.set(id, cached);
    return cached;
  };

  const get = (id: string): Cached | undefined => {
    const cached = entries.get(id);
    return cached === undefined ? undefined : refresh(id, cached);
  };

  const evictOldest = (): void => {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) {
      entries.delete(oldest);
    }
  };

  const set = (id: string, outcome: Cached): void => {
    refresh(id, outcome);
    if (entries.size > CLASSIFICATIONS_MAX) {
      evictOldest();
    }
  };

  return { get, set };
}

/** What the cache may hold of `outcome`: transient reasons (`unavailable`, `failed`) are left out. */
const cacheable = (outcome: ClassifyOutcome): Cached | undefined => {
  if ("classified" in outcome) {
    return outcome;
  }
  return outcome.unclassified === "too_large"
    ? { id: outcome.id, unclassified: "too_large" }
    : undefined;
};

/** Every id's outcome: cached ones as stored, the rest from one classify call, then stored. */
export async function classificationsOf(
  source: Pick<MailSource, "classify">,
  cache: ClassificationCache,
  ids: readonly string[],
  signal: AbortSignal | undefined,
): Promise<Map<string, ClassifyOutcome>> {
  const outcomes = new Map<string, ClassifyOutcome>();
  const missing: string[] = [];
  for (const id of new Set(ids)) {
    const cached = cache.get(id);
    if (cached === undefined) {
      missing.push(id);
    } else {
      outcomes.set(id, cached);
    }
  }
  if (missing.length === 0) {
    return outcomes;
  }
  for (const outcome of await source.classify({ ids: missing, signal })) {
    outcomes.set(outcome.id, outcome);
    const cached = cacheable(outcome);
    if (cached !== undefined) {
      cache.set(outcome.id, cached);
    }
  }
  return outcomes;
}
