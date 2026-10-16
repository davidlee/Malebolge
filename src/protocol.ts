// The daemon socket protocol, one JSON message per line.
//
//   client → daemon   ClientMessage
//   daemon → client   AgentEvent (pi-durable `watchEvents`, the first a `snapshot`)
//                     | ErrorMessage, for a line the daemon could not act on

export type ClientMessage =
  | { type: "input"; content: string; requestId?: string }
  | { type: "abort" }
  | { type: "compact"; instructions?: string };

export type ErrorMessage = { type: "error"; message: string };

type Fields = Record<string, unknown>;

function optionalString(fields: Fields, key: string): string | undefined {
  const value = fields[key];
  if (value === undefined || typeof value === "string") return value;
  throw new Error(`${key} must be a string`);
}

function withOptional<T extends Fields>(base: T, key: string, value: string | undefined): T {
  return value === undefined ? base : { ...base, [key]: value };
}

export function parseClientMessage(line: string): ClientMessage {
  let fields: unknown;
  try {
    fields = JSON.parse(line);
  } catch {
    throw new Error("line is not JSON");
  }
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    throw new Error("message must be an object");
  }
  const message = fields as Fields;
  switch (message.type) {
    case "input": {
      if (typeof message.content !== "string") throw new Error("input needs string content");
      const requestId = optionalString(message, "requestId");
      return withOptional({ type: "input", content: message.content }, "requestId", requestId);
    }
    case "abort":
      return { type: "abort" };
    case "compact":
      return withOptional(
        { type: "compact" },
        "instructions",
        optionalString(message, "instructions"),
      );
    default:
      throw new Error(`unknown message type ${JSON.stringify(message.type)}`);
  }
}
