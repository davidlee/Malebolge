// VT-1: the classification cache, its LRU bound, and the read-through that fills
// it. Contract fixtures only; the port is the shared fake, which records calls.

import { describe, expect, it } from "vitest";
import {
  type Cached,
  CLASSIFICATIONS_MAX,
  classificationCache,
  classificationsOf,
} from "../../src/mail/classifications.ts";
import type { Classification } from "../../src/mail/source.ts";
import {
  fakeMailSource,
  type FakeMailSource,
  loadData,
  mustCheck,
  setAt,
} from "./mail-fixtures.ts";

const TEMPLATE = loadData("classify", "contract/classify.json");

/** A contract-valid classification of `id`. */
function classificationOf(id: string): Classification {
  return mustCheck("classify", setAt(TEMPLATE, ["id"], id));
}

/** `id`'s classification, as the cache stores it and a Map returns it. */
function classified(id: string): Cached {
  return { id, classified: classificationOf(id) };
}

/** What a fake source answers for each of `ids`. */
function allClassified(ids: readonly string[]): Record<string, Classification> {
  return Object.fromEntries(ids.map((id): [string, Classification] => [id, classificationOf(id)]));
}

/** The query of every classify call the fake source recorded, in call order. */
function classifyQueries(source: FakeMailSource): object[] {
  return source.calls.filter((call) => call.verb === "classify").map((call) => call.query);
}

describe("classificationsOf", () => {
  it("asks for every uncached id in one classify call and returns a Map by id", async () => {
    const source = fakeMailSource({ classify: allClassified(["Msg1", "Msg2", "Msg3"]) });
    const cache = classificationCache();

    const outcomes = await classificationsOf(source, cache, ["Msg1", "Msg2", "Msg3"], undefined);

    expect(classifyQueries(source)).toEqual([{ ids: ["Msg1", "Msg2", "Msg3"] }]);
    expect(outcomes.size).toBe(3);
    expect(outcomes.get("Msg1")).toEqual(classified("Msg1"));
    expect(outcomes.get("Msg2")).toEqual(classified("Msg2"));
    expect(outcomes.get("Msg3")).toEqual(classified("Msg3"));
  });

  it("asks for each duplicated id once", async () => {
    const source = fakeMailSource({ classify: allClassified(["Msg1", "Msg2"]) });
    const cache = classificationCache();

    const outcomes = await classificationsOf(
      source,
      cache,
      ["Msg1", "Msg2", "Msg1", "Msg1"],
      undefined,
    );

    expect(classifyQueries(source)).toEqual([{ ids: ["Msg1", "Msg2"] }]);
    expect(outcomes.size).toBe(2);
  });

  it("asks nothing when every id is cached, and returns the stored outcome", async () => {
    const source = fakeMailSource({ classify: allClassified(["Msg1", "Msg2"]) });
    const cache = classificationCache();
    cache.set("Msg1", classified("Msg1"));
    cache.set("Msg2", { id: "Msg2", unclassified: "too_large" });

    const outcomes = await classificationsOf(source, cache, ["Msg1", "Msg2"], undefined);

    expect(classifyQueries(source)).toEqual([]);
    expect(outcomes.get("Msg1")).toEqual(classified("Msg1"));
    expect(outcomes.get("Msg2")).toEqual({ id: "Msg2", unclassified: "too_large" });
  });

  it("stores classified and too_large, so a second call asks nothing", async () => {
    const source = fakeMailSource({
      classify: { Msg1: classificationOf("Msg1"), Msg2: "too_large" },
    });
    const cache = classificationCache();

    const first = await classificationsOf(source, cache, ["Msg1", "Msg2"], undefined);
    const second = await classificationsOf(source, cache, ["Msg1", "Msg2"], undefined);

    expect(cache.get("Msg1")).toEqual(classified("Msg1"));
    expect(cache.get("Msg2")).toEqual({ id: "Msg2", unclassified: "too_large" });
    expect(second.get("Msg1")).toEqual(first.get("Msg1"));
    expect(second.get("Msg2")).toEqual({ id: "Msg2", unclassified: "too_large" });
    expect(classifyQueries(source)).toEqual([{ ids: ["Msg1", "Msg2"] }]);
  });

  it("does not store unavailable or failed, so a second call asks for them again", async () => {
    const source = fakeMailSource({ classify: { Msg1: "unavailable", Msg2: "failed" } });
    const cache = classificationCache();

    await classificationsOf(source, cache, ["Msg1", "Msg2"], undefined);
    expect(cache.get("Msg1")).toBeUndefined();
    expect(cache.get("Msg2")).toBeUndefined();

    await classificationsOf(source, cache, ["Msg1", "Msg2"], undefined);
    expect(classifyQueries(source)).toEqual([{ ids: ["Msg1", "Msg2"] }, { ids: ["Msg1", "Msg2"] }]);
  });

  it("asks only for the uncached ids in a mix, keeping the cached ones", async () => {
    const source = fakeMailSource({ classify: allClassified(["Msg2", "Msg4"]) });
    const cache = classificationCache();
    cache.set("Msg1", classified("Msg1"));
    cache.set("Msg3", { id: "Msg3", unclassified: "too_large" });

    const outcomes = await classificationsOf(
      source,
      cache,
      ["Msg1", "Msg2", "Msg3", "Msg4"],
      undefined,
    );

    expect(classifyQueries(source)).toEqual([{ ids: ["Msg2", "Msg4"] }]);
    expect(outcomes.size).toBe(4);
    expect(outcomes.get("Msg1")).toEqual(classified("Msg1"));
    expect(outcomes.get("Msg2")).toEqual(classified("Msg2"));
    expect(outcomes.get("Msg3")).toEqual({ id: "Msg3", unclassified: "too_large" });
    expect(outcomes.get("Msg4")).toEqual(classified("Msg4"));
  });

  it("passes the signal to classify", async () => {
    const source = fakeMailSource({ classify: allClassified(["Msg1"]) });
    const controller = new AbortController();

    await classificationsOf(source, classificationCache(), ["Msg1"], controller.signal);

    const [call] = source.calls;
    expect(source.calls).toHaveLength(1);
    expect(call?.verb).toBe("classify");
    expect(call?.signal).toBe(controller.signal);
  });
});

describe("classificationCache", () => {
  it("returns undefined on a miss, and what set stored after it", () => {
    const cache = classificationCache();

    expect(cache.get("Msg1")).toBeUndefined();
    cache.set("Msg1", classified("Msg1"));
    expect(cache.get("Msg1")).toEqual(classified("Msg1"));
  });

  it(`evicts the least recently used at CLASSIFICATIONS_MAX, and a get refreshes recency`, () => {
    const cache = classificationCache();
    const key = (index: number): string => `msg-${String(index)}`;
    const value = (index: number): Cached => ({ id: key(index), unclassified: "too_large" });

    for (let index = 0; index < CLASSIFICATIONS_MAX; index += 1) {
      cache.set(key(index), value(index));
    }
    expect(cache.get(key(0))).toBeDefined();

    cache.set("one-more", { id: "one-more", unclassified: "too_large" });

    expect(cache.get(key(0))).toBeDefined();
    expect(cache.get(key(1))).toBeUndefined();
    expect(cache.get(key(2))).toBeDefined();
    expect(cache.get(key(CLASSIFICATIONS_MAX - 1))).toBeDefined();
    expect(cache.get("one-more")).toEqual({ id: "one-more", unclassified: "too_large" });
  });
});
