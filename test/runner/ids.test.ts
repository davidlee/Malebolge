import { describe, expect, it } from "vitest";
import { newJobId, systemJobIds } from "../../src/runner/ids.ts";

const bytes =
  (fill: number): ((size: number) => Uint8Array) =>
  (size) =>
    new Uint8Array(size).fill(fill);

describe("newJobId", () => {
  it("encodes the time as the ULID spec's example and the randomness after it", () => {
    expect(newJobId(1_469_918_176_385, bytes(0))).toBe("pj-01ARYZ6S410000000000000000");
    expect(newJobId(1_469_918_176_385, bytes(0xff))).toBe("pj-01ARYZ6S41ZZZZZZZZZZZZZZZZ");
  });

  it("is pj- and 26 Crockford base32 characters", () => {
    expect(newJobId(Date.UTC(2026, 9, 18), bytes(0x5a))).toMatch(/^pj-[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("sorts lexically in time order", () => {
    const times = [0, 1, 31, 32, 1_000_000, Date.UTC(2026, 9, 18), 2 ** 48 - 1];
    const ids = times.map((time) => newJobId(time, bytes(0xff)));
    expect(ids.toSorted()).toEqual(ids);
  });

  it("refuses a time outside 48 bits", () => {
    expect(() => newJobId(-1, bytes(0))).toThrow(/time/);
    expect(() => newJobId(2 ** 48, bytes(0))).toThrow(/time/);
    expect(() => newJobId(1.5, bytes(0))).toThrow(/time/);
  });

  it("refuses a short random source", () => {
    expect(() => newJobId(0, () => new Uint8Array(9))).toThrow(/random/);
  });
});

describe("systemJobIds", () => {
  it("mints distinct ids for the same instant", () => {
    const now = Date.UTC(2026, 9, 18);
    const [a, b] = [systemJobIds(now), systemJobIds(now)];
    expect(a).not.toBe(b);
    expect(a.slice(0, 13)).toBe(newJobId(now, bytes(0)).slice(0, 13));
  });
});
