// One frame out, one typed reply in: the request path `--list`, `--topics` and
// `--set-topic` share, and the skew an older daemon answers it with. Nothing
// here renders a reply — its caller does (SL-003 design sec-5).

import type { Socket } from "node:net";
import type { Writable } from "node:stream";
import type { RequestInvocation } from "./attach-invocation.ts";
import { isRecord, type JsonRecord } from "./json.ts";
import { messageOf } from "./message-of.ts";
import { encodeLine, lineSplitter } from "./ndjson.ts";
import type { ConversationsMessage, ErrorMessage, TopicsMessage } from "./protocol.ts";
import { type ClientNotice, createRenderer, type Printable, toPrintable } from "./render.ts";
import { type ConnectWait, codeOf, connectUnixWaiting } from "./unix-socket.ts";

/** A request the daemon never answered; `attach-main` exits 1. */
export class RequestFailedError extends Error {
  readonly code = "REQUEST_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "RequestFailedError";
  }
}

/** How a frame becomes text: the one path every line of output takes. */
export type Render = (event: Printable) => string;

/** A client-local notice as `render` prints it: the one path every notice takes. */
export function noticeText(render: Render, text: string): string {
  const event: ClientNotice = { type: "client_notice", text };
  return render(event);
}

/** Connect, or say on `output` why not and rethrow the connect error. */
export async function connectOrExplain(
  socketPath: string,
  output: Writable,
  render: Render,
  wait: ConnectWait,
): Promise<Socket> {
  try {
    return await connectUnixWaiting(socketPath, wait);
  } catch (error) {
    const cause = String(codeOf(error) ?? error);
    output.write(noticeText(render, `cannot connect to ${socketPath}: ${cause}`));
    throw error;
  }
}

/** What a client says when the daemon breaks the line protocol itself. */
export const MALFORMED_LINE = "the daemon sent a line that is not JSON";

/** How a client connection reacts: to each parsed line, to a line that is not JSON, to the close. */
export interface ClientWiring {
  value: (value: unknown) => void;
  malformed: () => void;
  /** `cause` is the socket error that closed the connection, if one did. */
  close: (cause?: unknown) => void;
}

/** Wire a client socket: a reset destroys it, each line parses once, and close settles. */
export function wireClient(socket: Socket, wiring: ClientWiring): void {
  let cause: unknown;
  socket.on("error", (error) => {
    cause = error;
    socket.destroy();
  });
  socket.on(
    "data",
    lineSplitter((line) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        wiring.malformed();
        return;
      }
      wiring.value(value);
    }),
  );
  socket.on("close", () => {
    wiring.close(cause);
  });
}

/** A daemon that does not know a first-line frame answers `unknown message type "<frame>"`. */
const UNKNOWN_TYPE = /^unknown message type "([^"]+)"$/;

/** A daemon that does not know a key refuses the frame that carried it: `<frame>: unknown key <key>`. */
const UNKNOWN_KEY = /^[a-z-]+: unknown key ([A-Za-z0-9_]+)$/;

/** The keys whose refusal means the daemon predates the feature the key carries. */
const SKEWED_KEYS = ["topic", "topics"] as const;

/**
 * The feature the answering daemon predates, when `message` says it predates
 * one (design sec-5 Skew): an unknown first-line frame, or an unknown key on a
 * frame that gained one. `undefined` for every other failure, so a caller hints
 * a restart only where a restart would help.
 */
export function skewOf(message: string): string | undefined {
  const frame = UNKNOWN_TYPE.exec(message)?.[1];
  if (frame !== undefined) {
    return frame;
  }
  const key = UNKNOWN_KEY.exec(message)?.[1];
  return SKEWED_KEYS.find((skewed) => skewed === key);
}

/** What a skew means for the user: restart onto a daemon that knows `feature`. */
export const skewHint = (feature: string): string =>
  `the daemon predates ${feature}: restart it (malebolge-stop, then malebolge-start)`;

/** The replies a request is answered with: ids for a listing, topic records for the rest. */
export type ReplyMessage = ConversationsMessage | TopicsMessage;

/** The frame a request-reply invocation sends, as it goes on the wire (design sec-4). */
export function requestFrameOf(invocation: RequestInvocation): JsonRecord {
  switch (invocation.mode) {
    case "list":
      return invocation.topic === undefined
        ? { type: "list" }
        : { type: "list", topic: invocation.topic };
    case "topics":
      return { type: "list", topics: true };
    case "set-topic":
      // `cwd` absent creates the topic, or leaves its directory unchanged.
      return invocation.cwd === undefined
        ? { type: "topic", name: invocation.name }
        : { type: "topic", name: invocation.name, cwd: invocation.cwd };
  }
}

/** The reply that answers `invocation`'s frame. */
export function replyTypeOf(invocation: RequestInvocation): ReplyMessage["type"] {
  return invocation.mode === "list" ? "conversations" : "topics";
}

const CLOSED_BEFORE_REPLY = "the daemon closed before the request was answered";
const TRUNCATED_HINT = "the listing was truncated: older conversations are not shown";

/** One request connection: where failures go, the reply it waits for, and how it settles. */
interface RequestState<K extends ReplyMessage["type"]> {
  socket: Socket;
  errors: Writable;
  render: Render;
  replyType: K;
  answered: boolean;
  failure?: RequestFailedError;
  resolve: (reply: Extract<ReplyMessage, { type: K }>) => void;
  reject: (error: Error) => void;
}

/** The daemon refused or failed the request: say so on stderr, then leave. */
function failRequest<K extends ReplyMessage["type"]>(
  state: RequestState<K>,
  event: ErrorMessage,
): void {
  state.errors.write(state.render(event));
  const feature = skewOf(event.message);
  if (feature !== undefined) {
    state.errors.write(noticeText(state.render, skewHint(feature)));
  }
  leaveFailed(state, event.message);
}

/** Record the request's one failure and end the connection. */
function leaveFailed<K extends ReplyMessage["type"]>(
  state: RequestState<K>,
  message: string,
): void {
  state.failure = new RequestFailedError(message);
  // The old daemon bound root and left the connection open: its close will not come.
  state.socket.end();
}

/** Whether the request has its one outcome: answered, or failed. */
const isSettled = <K extends ReplyMessage["type"]>(state: RequestState<K>): boolean =>
  state.answered || state.failure !== undefined;

/**
 * One frame on a request connection. Only two are its own — the reply it asked
 * for and an error; everything else is ignored, because a daemon that predates
 * the frame binds root and sends root's whole snapshot before saying so.
 */
function handleRequestFrame<K extends ReplyMessage["type"]>(
  state: RequestState<K>,
  value: unknown,
): void {
  if (isSettled(state) || !isRecord(value) || typeof value["type"] !== "string") {
    return;
  }
  const event = toPrintable(value);
  if (event.type === "error") {
    failRequest(state, event);
  } else if (event.type === state.replyType) {
    state.answered = true;
    // TypeScript cannot correlate `event.type === replyType` with `K`, so the wire's
    // discriminant is asserted here, once, where the match is made.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    state.resolve(event as Extract<ReplyMessage, { type: K }>);
    if (event.type === "conversations" && event.truncated) {
      state.errors.write(`${TRUNCATED_HINT}\n`);
    }
  }
}

/** The daemon closed: a failure rejects; a close with no reply is its own failure, cause named. */
function settleRequest<K extends ReplyMessage["type"]>(
  state: RequestState<K>,
  cause: unknown,
): void {
  if (state.failure !== undefined) {
    state.reject(state.failure);
    return;
  }
  if (!state.answered) {
    const text =
      cause === undefined
        ? CLOSED_BEFORE_REPLY
        : `${CLOSED_BEFORE_REPLY}: ${messageOf(codeOf(cause) ?? cause)}`;
    state.errors.write(noticeText(state.render, text));
    state.reject(new RequestFailedError(text));
  }
}

/** Wire the socket: each frame is handled, a line that is not JSON fails, close settles. */
function wireRequest<K extends ReplyMessage["type"]>(state: RequestState<K>): void {
  wireClient(state.socket, {
    value: (value) => {
      handleRequestFrame(state, value);
    },
    malformed: () => {
      if (!isSettled(state)) {
        state.errors.write(noticeText(state.render, MALFORMED_LINE));
        leaveFailed(state, MALFORMED_LINE);
      }
    },
    close: (cause) => {
      settleRequest(state, cause);
    },
  });
}

/**
 * Ask the daemon one question on a fresh connection: one frame out, one reply
 * of `replyType` in, then a clean close. Resolves to that reply and prints
 * nothing itself — the caller renders it on stdout, and every refusal, skew and
 * truncation goes to `errors` (DEC-008).
 */
export async function request<K extends ReplyMessage["type"]>(
  socketPath: string,
  frame: JsonRecord,
  replyType: K,
  errors: Writable,
  wait: ConnectWait,
): Promise<Extract<ReplyMessage, { type: K }>> {
  const render = createRenderer();
  // A dead daemon is told on `errors`: stdout stays reserved for the reply.
  const socket = await connectOrExplain(socketPath, errors, render, wait);
  const { promise, resolve, reject } = Promise.withResolvers<Extract<ReplyMessage, { type: K }>>();
  const state: RequestState<K> = {
    socket,
    errors,
    render,
    replyType,
    answered: false,
    resolve,
    reject,
  };
  socket.write(encodeLine(frame));
  wireRequest(state);
  return promise;
}
