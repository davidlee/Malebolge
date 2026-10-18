// The daemon socket protocol, one JSON message per line.
//
//   client → daemon   ClientMessage
//   daemon → client   AgentEvent (pi-durable `watchEvents`, the first a `snapshot`)
//                     | ErrorMessage, for a line the daemon could not act on

import { isRecord, type JsonRecord } from "./json.ts";

export type ClientMessage =
  | { type: "input"; content: string; requestId?: string }
  | { type: "abort" }
  | { type: "compact"; instructions?: string };

export interface ErrorMessage {
  type: "error";
  message: string;
}

function optionalString(fields: JsonRecord, key: string): string | undefined {
  const value = fields[key];
  if (value === undefined || typeof value === "string") {
    return value;
  }
  throw new Error(`${key} must be a string`);
}

function withOptional<T extends JsonRecord>(base: T, key: string, value: string | undefined): T {
  return value === undefined ? base : { ...base, [key]: value };
}

function parseObject(line: string): JsonRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("line is not JSON");
  }
  if (!isRecord(value)) {
    throw new Error("message must be an object");
  }
  return value;
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
