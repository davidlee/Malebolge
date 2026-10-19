import { describe, expect, it } from "vitest";
import { escapeXml } from "../src/xml.ts";

describe("escapeXml", () => {
  it("escapes the five XML characters", () => {
    expect(escapeXml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&apos;");
  });

  it("escapes & first, so entities are not doubled", () => {
    expect(escapeXml("<&>")).toBe("&lt;&amp;&gt;");
  });
});
