// The job's tool set (EX-3, DEC-054): pi-durable's coding tools, `read` the only
// one an interrupted run may rerun after a restart.

import type { ToolRegistration } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { describe, expect, it } from "vitest";
import { JobTools } from "../../src/runner/tools.ts";

const replayOf = (name: string): string | undefined =>
  JobTools.tools?.find((tool) => tool.name === name)?.replay;

describe("the job's tools", () => {
  it("are read, write, edit and bash", () => {
    expect(JobTools.tools?.map((tool) => tool.name)).toEqual(["read", "write", "edit", "bash"]);
  });

  it("rerun only read after a restart", () => {
    expect(replayOf("read")).toBe("safe");
    // Unset is pi-durable's default, `unsafe`: the call reports `interrupted`.
    expect(["write", "edit", "bash"].map(replayOf)).toEqual([undefined, undefined, undefined]);
  });

  it("are pi-durable's coding tools, unchanged but for replay", () => {
    const replayUnset = (tool: ToolRegistration): object => ({
      ...tool,
      replay: undefined,
    });
    expect(JobTools.tools?.map(replayUnset)).toEqual(CodingTools.tools?.map(replayUnset));
  });
});
