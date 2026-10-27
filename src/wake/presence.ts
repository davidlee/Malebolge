// Presence from satan-mcp's answer: one text item holding the Lisp plist that
// prin1-to-string printed (satan satan-mcp.el:381). The regex is the whole
// contract — a plist reader would be a second parser with no fixture of its own.

import type { Presence } from "./policy.ts";

/** The text items of a satan-mcp tool result (the MCP CallToolResult shape). */
export interface ToolResultText {
  content: readonly { type: string; text?: string }[];
  isError?: boolean;
}

/** `:presence "..."` as satan-mcp prints it; an escaped \" in a title cannot match. */
const PRESENCE = /:presence "(typing|reading|mixed|idle)"/;

/** The presence each printed activity word means. */
const PRESENCE_OF: Record<string, Presence> = {
  typing: "present",
  reading: "present",
  mixed: "present",
  idle: "away",
};

/** The first presence fact printed across `result`'s text items, if any. */
const factOf = (result: ToolResultText): string | undefined => {
  for (const item of result.content) {
    if (item.type !== "text" || item.text === undefined) {
      continue;
    }
    const match = PRESENCE.exec(item.text);
    if (match !== null) {
      return match[1];
    }
  }
  return undefined;
};

/** What the room user is doing, as satan-mcp last reported it (VT-3). */
export function presenceOf(result: ToolResultText): Presence {
  const fact = result.isError === true ? undefined : factOf(result);
  return (fact === undefined ? undefined : PRESENCE_OF[fact]) ?? "unknown";
}
