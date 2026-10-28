import type { CallToolResult } from "@earendil-works/pi-mcp";
import type { ConversationId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { bootContextOf, orientationOf } from "../src/boot-context.ts";
import type { PoolKey } from "../src/satan-pool.ts";
import type { SatanTools } from "../src/satan-tools.ts";

interface Call {
  key: PoolKey;
  tool: string;
  args: Record<string, unknown>;
}

type Answer = () => Promise<CallToolResult>;

/** A satan-mcp `call` that answers `answer` and records each call. */
const calling = (answer: Answer): { calls: Call[]; call: SatanTools["call"] } => {
  const calls: Call[] = [];
  const call: SatanTools["call"] = (key, tool, args) => {
    calls.push({ key, tool, args });
    return answer();
  };
  return { calls, call };
};

const text = (value: string, isError = false): CallToolResult => ({
  content: [{ type: "text", text: value }],
  ...(isError ? { isError } : {}),
});

// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- no decimal literal is a branded id
const ROOT = 1 as ConversationId;
const KEY: PoolKey = { conversation: ROOT, kind: "scheduled" };

describe("bootContextOf", () => {
  it("asks satan-mcp for a refreshed boot context over the given key", async () => {
    const { calls, call } = calling(() => Promise.resolve(text("# Now")));
    expect(await bootContextOf(call, KEY, 10)).toBe("# Now");
    expect(calls).toEqual([{ key: KEY, tool: "satan_boot_context", args: { refresh: true } }]);
  });

  const failures: [string, Answer, string][] = [
    [
      "an error result",
      (): Promise<CallToolResult> => Promise.resolve(text("db down", true)),
      "db down",
    ],
    [
      "a failed call",
      (): Promise<CallToolResult> => Promise.reject(new Error("unreachable")),
      "unreachable",
    ],
  ];
  it.each(failures)("degrades %s to percept unavailable", async (_, answer, reason) => {
    const { call } = calling(answer);
    expect(await bootContextOf(call, KEY, 10)).toBe(`percept unavailable: ${reason}`);
  });
});

describe("orientationOf", () => {
  it("wraps the conversation's interactive boot context in an orient block", async () => {
    const { calls, call } = calling(() => Promise.resolve(text("# Now")));
    const content = await orientationOf(call, ROOT);
    expect(calls[0]?.key).toEqual({ conversation: ROOT, kind: "interactive" });
    expect(content).toMatch(/^<orient>/);
    expect(content).toContain("<percept># Now</percept>");
    expect(content).toMatch(/tool/);
    expect(content).toMatch(/<\/orient>$/);
  });
});
