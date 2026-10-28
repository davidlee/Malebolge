// Two-step dependency binding for extensions built before the session (SL-006 design § Components
// and boundaries).

import { describe, expect, it } from "vitest";
import { lateBinding } from "../src/late-binding.ts";

interface Early {
  settings: string;
}
interface Late {
  harness: number;
}

const early: Early = { settings: "policy" };
const late: Late = { harness: 7 };

describe("lateBinding", () => {
  it("throws when read before both binding steps", () => {
    const message = "threads dependencies read before the daemon bound them";
    const unbound = lateBinding<Early, Late>("threads");
    expect(() => unbound.deps()).toThrow(message);

    const earlyOnly = lateBinding<Early, Late>("threads");
    earlyOnly.bindEarly(early);
    expect(() => earlyOnly.deps()).toThrow(message);

    const lateOnly = lateBinding<Early, Late>("threads");
    lateOnly.bindLate(late);
    expect(() => lateOnly.deps()).toThrow(message);
  });

  it("merges early and late once bound, and reads the later late binding at use", () => {
    const binding = lateBinding<Early, Late>("threads");
    binding.bindEarly(early);
    binding.bindLate(late);
    expect(binding.deps()).toEqual({ settings: "policy", harness: 7 });

    binding.bindLate({ harness: 9 });
    expect(binding.deps()).toEqual({ settings: "policy", harness: 9 });
  });
});
