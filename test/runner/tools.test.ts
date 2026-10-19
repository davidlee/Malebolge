// The job's tool set (EX-3, DEC-054; SL-026 PHASE-05 EX-3): pi-durable's coding
// tools and grepTool, `read` and `grep` the ones an interrupted run may rerun
// after a restart.

import type { ToolRegistration } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { describe, expect, it } from "vitest";
import { grepTool } from "../../src/grep.ts";
import { JobTools } from "../../src/runner/tools.ts";

const replayOf = (name: string): string | undefined =>
  JobTools.tools?.find((tool) => tool.name === name)?.replay;

describe("the job's tools", () => {
  it("are read, write, edit, bash and grep", () => {
    expect(JobTools.tools?.map((tool) => tool.name)).toEqual([
      "read",
      "write",
      "edit",
      "bash",
      "grep",
    ]);
  });

  it("rerun only read and grep after a restart", () => {
    expect([replayOf("read"), replayOf("grep")]).toEqual(["safe", "safe"]);
    // Unset is pi-durable's default, `unsafe`: the call reports `interrupted`.
    expect(["write", "edit", "bash"].map(replayOf)).toEqual([undefined, undefined, undefined]);
  });

  it("are pi-durable's coding tools, unchanged but for replay", () => {
    const replayUnset = (tool: ToolRegistration): object => ({
      ...tool,
      replay: undefined,
    });
    expect(JobTools.tools?.slice(0, 4).map(replayUnset)).toEqual(
      CodingTools.tools?.map(replayUnset),
    );
  });

  it("end with grepTool, as defined", () => {
    expect(JobTools.tools?.at(-1)).toBe(grepTool);
  });
});
