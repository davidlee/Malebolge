// The job's tool set (design §5.2, DEC-054; SL-026 design §4.5): pi-durable's
// coding tools and grep, running in the job's environment. `read` and `grep`
// are replay-safe: after a restart an interrupted read or search reruns, while
// an interrupted write, edit or bash reports `interrupted` (pi-durable's
// default, `unsafe`), since it may have partly run. grepTool declares its own.

import { defineExtension, type ToolRegistration } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { grepTool } from "../grep.ts";

const REPLAY_SAFE: ReadonlySet<string> = new Set(["read"]);

function withReplay<Tool extends ToolRegistration>(tool: Tool): Tool {
  return REPLAY_SAFE.has(tool.name) ? { ...tool, replay: "safe" } : tool;
}

export const JobTools = defineExtension({
  name: "job-tools",
  tools: [...(CodingTools.tools ?? []).map(withReplay), grepTool],
});
