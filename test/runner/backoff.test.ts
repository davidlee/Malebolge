// Backoff for a room that is down: the pause schedule, and a sleep a stop
// cuts short without rejecting.

import { describe, expect, it } from "vitest";
import { abortableSleep, roomRetryDelay } from "../../src/runner/backoff.ts";
import { within } from "./runner-fixture.ts";

describe("roomRetryDelay", () => {
  it("doubles from a second and stops at a minute", () => {
    expect([0, 1, 2, 5, 6, 20].map(roomRetryDelay)).toEqual([
      1000, 2000, 4000, 32_000, 60_000, 60_000,
    ]);
  });
});

describe("abortableSleep", () => {
  it("resolves once its time is up", async () => {
    await within(1000, "sleep", abortableSleep(1, new AbortController().signal));
  });

  it("resolves, not rejects, as soon as its signal aborts", async () => {
    const stop = new AbortController();
    const sleeping = abortableSleep(60_000, stop.signal);

    stop.abort();

    await within(1000, "aborted sleep", sleeping);
  });
});
