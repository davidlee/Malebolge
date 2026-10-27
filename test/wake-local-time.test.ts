// `localIso` (SL-034 design § Tools): the ISO-8601 local time with its offset
// that the wake tools, the wake input and the journal show. Zone-independent
// assertions only: the running zone is whatever the machine (or TZ) says.

import { describe, expect, it } from "vitest";
import { localIso } from "../src/wake/local-time.ts";

const pad = (n: number, width = 2): string => String(Math.trunc(Math.abs(n))).padStart(width, "0");

/** The string built from `Date`'s own getters, i.e. for whatever zone is running. */
const fromGetters = (ms: number): string => {
  const date = new Date(ms);
  const offset = -date.getTimezoneOffset();
  const zone =
    offset === 0 ? "Z" : `${offset > 0 ? "+" : "-"}${pad(offset / 60)}:${pad(offset % 60)}`;
  return (
    `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}${zone}`
  );
};

const FIXED = [0, Date.UTC(2024, 0, 2, 3, 4, 5, 6), 1_726_000_000_000];

describe("localIso: local time with its offset", () => {
  it("matches the running zone's own getters for fixed instants", () => {
    for (const ms of FIXED) {
      expect(localIso(ms)).toBe(fromGetters(ms));
    }
  });

  it("is ISO-8601 with milliseconds and a zone suffix", () => {
    for (const ms of FIXED) {
      expect(localIso(ms)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}([+-]\d\d:\d\d|Z)$/);
    }
  });

  it('ends with "Z" only where the zone offset is zero', () => {
    for (const ms of FIXED) {
      const iso = localIso(ms);
      expect(iso.endsWith("Z")).toBe(new Date(ms).getTimezoneOffset() === 0);
    }
  });

  it("names the same instant it was given", () => {
    for (const ms of FIXED) {
      expect(new Date(localIso(ms)).getTime()).toBe(ms);
    }
  });
});
