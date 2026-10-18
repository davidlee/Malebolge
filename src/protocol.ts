// The daemon socket protocol, one JSON message per line.
//
//   client → daemon   ClientMessage
//   daemon → client   AgentEvent (pi-durable `watchEvents`, the first a `snapshot`)
//                     | ErrorMessage, for a line the daemon could not act on

import { optionalString, parseObject, withOptional } from "./fields.ts";
import type { JsonRecord } from "./json.ts";

export type ClientMessage =
  | { type: "input"; content: string; requestId?: string }
  | { type: "abort" }
  | { type: "compact"; instructions?: string };

export interface ErrorMessage {
  type: "error";
  message: string;
}

function inputMessage(message: JsonRecord): ClientMessage {
  const content = message["content"];
  if (typeof content !== "string") {
    throw new Error("input needs string content");
  }
  return withOptional(
    { type: "input", content },
    "requestId",
    optionalString(message, "requestId"),
  );
}

export function parseClientMessage(line: string): ClientMessage {
  const message = parseObject(line);
  const type = message["type"];
  switch (type) {
    case "input":
      return inputMessage(message);
    case "abort":
      return { type: "abort" };
    case "compact":
      return withOptional(
        { type: "compact" },
        "instructions",
        optionalString(message, "instructions"),
      );
    default:
      throw new Error(`unknown message type ${JSON.stringify(type)}`);
  }
}
