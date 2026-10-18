import { describe, expect, it } from "vitest";
import { isRecord } from "../src/json.ts";

describe("isRecord", () => {
  it.each([[{}], [{ a: 1 }], [JSON.parse('{"type":"x"}')]])("accepts the object %j", (value) => {
    expect(isRecord(value)).toBe(true);
  });

  it.each([[null], [undefined], [[]], [[1]], ["s"], [1], [true]])("rejects %j", (value) => {
    expect(isRecord(value)).toBe(false);
  });
});
