// The job's tool set (design §5.2, DEC-054): pi-durable's coding tools,
// running in the job's environment. Only `read` is replay-safe: after a
// restart an interrupted read reruns, while an interrupted write, edit or bash
// reports `interrupted` (pi-durable's default, `unsafe`), since it may have
// partly run.

import { defineExtension, type ToolRegistration } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";

const REPLAY_SAFE: ReadonlySet<string> = new Set(["read"]);

function withReplay<Tool extends ToolRegistration>(tool: Tool): Tool {
  return REPLAY_SAFE.has(tool.name) ? { ...tool, replay: "safe" } : tool;
}

export const JobTools = defineExtension({
  name: "job-tools",
  tools: (CodingTools.tools ?? []).map(withReplay),
});
