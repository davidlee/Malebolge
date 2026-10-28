// SATAN's boot context (satan_boot_context): the percept a wake fires with, and
// the orientation an interactive conversation asks for once compaction has
// folded its first one away (IMP-016).

import type { ConversationId } from "@earendil-works/pi-durable";
import type { CallToolResult } from "@earendil-works/pi-mcp";
import { messageOf } from "./message-of.ts";
import type { PoolKey } from "./satan-pool.ts";
import { callsOf, type SatanTools } from "./satan-tools.ts";

/** How long an orientation's boot-context call may take. */
const ORIENT_DEADLINE_MS = 10_000;

/** The text items of a satan-mcp result, joined. */
const textOf = (result: CallToolResult): string =>
  result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");

/** A freshly built boot context over `key`, or why there is none: its caller goes on without one. */
export const bootContextOf = async (
  call: SatanTools["call"],
  key: PoolKey,
  deadlineMs: number,
): Promise<string> => {
  try {
    const result = await call(key, "satan_boot_context", { refresh: true }, deadlineMs);
    return result.isError === true ? `percept unavailable: ${textOf(result)}` : textOf(result);
  } catch (error) {
    return `percept unavailable: ${messageOf(error)}`;
  }
};

const ORIENT_NOTE =
  "Your context was refreshed on request. Your tool manifest is current: " +
  "trust it over any earlier claim, in this conversation or its summaries, " +
  "about which tools are available.";

/** The input an `orient` command submits to `conversation`. */
export const orientationOf = async (
  call: SatanTools["call"],
  conversation: ConversationId,
): Promise<string> =>
  [
    "<orient>",
    ORIENT_NOTE,
    `<percept>${await bootContextOf(call, callsOf(conversation), ORIENT_DEADLINE_MS)}</percept>`,
    "</orient>",
  ].join("\n");
