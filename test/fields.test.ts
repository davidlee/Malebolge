import { describe, expect, it } from "vitest";
import {
  expandHome,
  onlyKeys,
  optionalBoolean,
  optionalPositiveInt,
  optionalPositiveNumber,
  optionalRecord,
  optionalString,
  optionalStringArray,
  parseObject,
  required,
  requireString,
  requireStringArray,
  setDefined,
  withOptional,
} from "../src/fields.ts";

describe("parseObject", () => {
  it("returns the object a line holds", () => {
    expect(parseObject('{"a":1}')).toEqual({ a: 1 });
  });

  it.each([
    ["not json", /JSON/],
    ["[]", /object/],
    ["3", /object/],
  ])("rejects %s", (line, reason) => {
    expect(() => parseObject(line)).toThrow(reason);
  });
});

describe("string readers", () => {
  it("optionalString passes absent and strings, refuses others", () => {
    expect(optionalString({}, "k")).toBeUndefined();
    expect(optionalString({ k: "v" }, "k")).toBe("v");
    expect(() => optionalString({ k: 1 }, "k")).toThrow(/k must be a string/);
  });

  it("requireString refuses absent, empty and non-strings", () => {
    expect(requireString({ k: "v" }, "k")).toBe("v");
    expect(() => requireString({}, "k")).toThrow(/k must be a non-empty string/);
    expect(() => requireString({ k: "" }, "k")).toThrow(/k must be a non-empty string/);
    expect(() => requireString({ k: 1 }, "k")).toThrow(/k must be a non-empty string/);
  });

  it("withOptional adds the key only when the value is defined", () => {
    expect(withOptional({ a: 1 }, "k", "v")).toEqual({ a: 1, k: "v" });
    expect(withOptional({ a: 1 }, "k", undefined)).toEqual({ a: 1 });
  });
});

describe("string array readers", () => {
  it("optionalStringArray passes absent, [] and string arrays", () => {
    expect(optionalStringArray({}, "k")).toBeUndefined();
    expect(optionalStringArray({ k: [] }, "k")).toEqual([]);
    expect(optionalStringArray({ k: ["a"] }, "k")).toEqual(["a"]);
  });

  it.each([[1], ["a"], [["a", 2]]])("optionalStringArray refuses %j", (value) => {
    expect(() => optionalStringArray({ k: value }, "k")).toThrow(/k must be an array of strings/);
  });

  it("requireStringArray refuses absent and empty", () => {
    expect(requireStringArray({ k: ["a", "b"] }, "k")).toEqual(["a", "b"]);
    expect(() => requireStringArray({}, "k")).toThrow(/k must be a non-empty array/);
    expect(() => requireStringArray({ k: [] }, "k")).toThrow(/k must be a non-empty array/);
    expect(() => requireStringArray({ k: [1] }, "k")).toThrow(/k must be a non-empty array/);
  });
});

describe("other optional readers", () => {
  it("optionalRecord passes absent and objects", () => {
    expect(optionalRecord({}, "k")).toBeUndefined();
    expect(optionalRecord({ k: { a: 1 } }, "k")).toEqual({ a: 1 });
    expect(() => optionalRecord({ k: [] }, "k")).toThrow(/k must be an object/);
    expect(() => optionalRecord({ k: null }, "k")).toThrow(/k must be an object/);
  });

  it("optionalPositiveNumber refuses zero, negatives, NaN-ish and non-numbers", () => {
    expect(optionalPositiveNumber({}, "k")).toBeUndefined();
    expect(optionalPositiveNumber({ k: 0.5 }, "k")).toBe(0.5);
    for (const bad of [0, -1, "1", Number.POSITIVE_INFINITY]) {
      expect(() => optionalPositiveNumber({ k: bad }, "k")).toThrow(/k must be a positive number/);
    }
  });

  it("optionalPositiveInt refuses fractions", () => {
    expect(optionalPositiveInt({}, "k")).toBeUndefined();
    expect(optionalPositiveInt({ k: 3 }, "k")).toBe(3);
    expect(() => optionalPositiveInt({ k: 1.5 }, "k")).toThrow(/k must be a positive integer/);
    expect(() => optionalPositiveInt({ k: 0 }, "k")).toThrow(/k must be a positive integer/);
  });

  it("optionalBoolean passes absent and booleans", () => {
    expect(optionalBoolean({}, "k")).toBeUndefined();
    expect(optionalBoolean({ k: false }, "k")).toBe(false);
    expect(() => optionalBoolean({ k: 0 }, "k")).toThrow(/k must be a boolean/);
  });
});

describe("onlyKeys", () => {
  it("accepts a subset of the allowed keys", () => {
    expect(() => {
      onlyKeys({ a: 1 }, ["a", "b"], "x");
    }).not.toThrow();
  });

  it("names the first unknown key and where it appeared", () => {
    expect(() => {
      onlyKeys({ a: 1, z: 2, y: 3 }, ["a"], "submit");
    }).toThrow(/submit: unknown key z/);
  });
});

describe("required", () => {
  it("returns what the reader finds and names the field when it finds nothing", () => {
    expect(required({ k: 2 }, "k", optionalPositiveInt)).toBe(2);
    expect(() => required({}, "k", optionalPositiveInt)).toThrow(/k is required/);
    expect(() => required({ k: -1 }, "k", optionalPositiveInt)).toThrow(/positive integer/);
  });
});

describe("setDefined", () => {
  it("sets the defined entries and leaves out the undefined ones", () => {
    expect(
      setDefined<{ a: number; b?: string; c?: string }>({ a: 1 }, { b: "x", c: undefined }),
    ).toEqual({
      a: 1,
      b: "x",
    });
  });
});

describe("expandHome", () => {
  it("expands ~ and ~/x against home, and leaves every other path alone", () => {
    expect(expandHome("~", "/home/u")).toBe("/home/u");
    expect(expandHome("~/a/b", "/home/u")).toBe("/home/u/a/b");
    expect(expandHome("/abs/~/x", "/home/u")).toBe("/abs/~/x");
    expect(expandHome("~other/x", "/home/u")).toBe("~other/x");
  });
});
