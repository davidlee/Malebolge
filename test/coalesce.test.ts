// One run at a time, and at most one more queued behind it (SL-028 design §4.3).

import { describe, expect, it } from "vitest";
import { coalesce } from "../src/coalesce.ts";

/** A promise a test lets go when it chooses, for holding the first run open. */
function hold(): { wait: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

describe("coalesce", () => {
  it("runs once for the first call and once more for everyone who asked meanwhile", async () => {
    const gate = hold();
    const runs: number[] = [];
    const coalesced = coalesce(async () => {
      runs.push(runs.length + 1);
      if (runs.length === 1) {
        await gate.wait;
      }
    });
    const seen: number[] = [];
    const observe = (): Promise<void> =>
      coalesced().then(() => {
        seen.push(runs.length);
      });
    const all = Promise.all([observe(), observe(), observe()]);
    gate.release();
    await all;
    expect(runs).toHaveLength(2);
    expect(seen).toEqual([1, 2, 2]);
  });

  it("starts a new run for a call made after the last one finished", async () => {
    const runs: number[] = [];
    const coalesced = coalesce(() => {
      runs.push(runs.length + 1);
      return Promise.resolve();
    });
    await coalesced();
    await coalesced();
    expect(runs).toHaveLength(2);
  });

  it("rejects the callers a failed run ran for, and still runs the next call", async () => {
    let runs = 0;
    const coalesced = coalesce((): Promise<void> => {
      runs += 1;
      return runs === 1 ? Promise.reject(new Error("boom")) : Promise.resolve();
    });
    await expect(coalesced()).rejects.toThrow("boom");
    await coalesced();
    expect(runs).toBe(2);
  });
});
