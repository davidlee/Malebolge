import { describe, expect, it } from "vitest";
import { ceilingLatch } from "../../src/runner/ceiling-latch.ts";

describe("ceilingLatch", () => {
  it("is open until tripped", () => {
    const latch = ceilingLatch();
    expect(latch.signal.aborted).toBe(false);
    expect(latch.reason()).toBeUndefined();
  });

  it("the first trip wins: its reason stands, the signal aborts once", () => {
    const latch = ceilingLatch();
    let aborts = 0;
    latch.signal.addEventListener("abort", () => {
      aborts++;
    });

    latch.trip("usage_unavailable");
    latch.trip("ceiling_exceeded");

    expect(latch.reason()).toBe("usage_unavailable");
    expect(latch.signal.aborted).toBe(true);
    expect(aborts).toBe(1);
  });
});
