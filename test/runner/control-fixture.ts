// An NDJSON client of the runner's control socket: numbered requests, each
// answered by the response echoing its id; everything received is recorded.

import { isRecord, type JsonRecord } from "../../src/json.ts";
import { encodeLine, lineSplitter } from "../../src/ndjson.ts";
import { connectUnix } from "../../src/unix-socket.ts";
import { recorder } from "../fixtures.ts";

export interface ControlClient {
  /** Sends `op` with `fields` and a fresh `requestId`; resolves with the response. */
  call: (op: string, fields?: JsonRecord) => Promise<JsonRecord>;
  /** Sends `value` as one line, as is. */
  send: (value: unknown) => void;
  /** The first message, received or still to come, that matches. */
  next: (match: (message: JsonRecord) => boolean) => Promise<JsonRecord>;
  /** Watch frames received so far. */
  frames: () => JsonRecord[];
  /** Resolves when the runner closes the connection. */
  closed: Promise<void>;
  close: () => void;
}

const asRecord = (value: unknown): JsonRecord => {
  if (!isRecord(value)) {
    throw new Error(`not an object: ${JSON.stringify(value)}`);
  }
  return value;
};

export async function controlClient(socketPath: string): Promise<ControlClient> {
  const socket = await connectUnix(socketPath);
  const messages = recorder<JsonRecord>();
  socket.on(
    "data",
    lineSplitter((line) => {
      messages.push(asRecord(JSON.parse(line)));
    }),
  );
  const closed = new Promise<void>((resolve) => {
    socket.once("close", () => {
      resolve();
    });
  });
  const send = (value: unknown): void => {
    socket.write(encodeLine(value));
  };
  let sent = 0;
  return {
    call: (op, fields = {}): Promise<JsonRecord> => {
      const requestId = `r${String(++sent)}`;
      send({ op, requestId, ...fields });
      return messages.next((message) => message["requestId"] === requestId);
    },
    send,
    next: messages.next,
    frames: () => messages.items.filter((message) => message["event"] !== undefined),
    closed,
    close: (): void => {
      socket.destroy();
    },
  };
}

/** The error code of a refused response; fails on success. */
export function errorCode(response: JsonRecord): unknown {
  const error = response["error"];
  if (response["ok"] !== false || !isRecord(error)) {
    throw new Error(`expected a refusal: ${JSON.stringify(response)}`);
  }
  return error["code"];
}
