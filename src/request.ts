// One frame out, one typed reply in: the listing lifecycle, and the skew an
// older daemon answers it with. The topic and `--here` requests share this
// path (SL-003 design sec-5); the caller renders each reply.

import type { Socket } from "node:net";
import type { Writable } from "node:stream";
import { isRecord } from "./json.ts";
import { encodeLine, lineSplitter } from "./ndjson.ts";
import type { ErrorMessage } from "./protocol.ts";
import {
  type ClientNotice,
  createRenderer,
  type Presentation,
  type Printable,
  toPrintable,
} from "./render.ts";
import { type ConnectWait, codeOf, connectUnixWaiting } from "./unix-socket.ts";

/** A listing the daemon never answered; `attach-main` exits 1. */
export class NotListedError extends Error {
  readonly code = "NOT_LISTED";

  constructor(message: string) {
    super(message);
    this.name = "NotListedError";
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

/** A daemon that does not know a first-line frame answers `unknown message type "<frame>"`. */
const SKEW = /^unknown message type "([^"]+)"$/;

/** The frame the daemon did not know, when `message` says it predates one. */
export function skewFrameOf(message: string): string | undefined {
  return SKEW.exec(message)?.[1];
}

/** What a skew means for the user: restart onto a daemon that knows `frame`. */
export const skewHint = (frame: string): string =>
  `the daemon predates ${frame}: restart it (malebolge-stop, then malebolge-start)`;

const CLOSED_BEFORE_LISTING = "the daemon closed before the listing completed";
const TRUNCATED_HINT = "the listing was truncated: older conversations are not shown";

/** The one line a listing sends: SL-002's exact wire frame, still only `type`. */
const LIST_FRAME = { type: "list" };

/** One listing connection: its two streams, the renderer, and how it settles. */
interface ListingState {
  socket: Socket;
  output: Writable;
  errors: Writable;
  render: Render;
  answered: boolean;
  failure?: NotListedError;
  resolve: (value: undefined) => void;
  reject: (error: Error) => void;
}

/** The daemon refused or failed the listing: say so on stderr, then leave. */
function failListing(state: ListingState, event: ErrorMessage): void {
  state.errors.write(state.render(event));
  const frame = skewFrameOf(event.message);
  if (frame !== undefined) {
    state.errors.write(noticeText(state.render, skewHint(frame)));
  }
  state.failure = new NotListedError(event.message);
  // The old daemon bound root and left the connection open: its close will not come.
  state.socket.end();
}

/**
 * One frame on a listing connection. Only two are its own — the reply and an
 * error; everything else is ignored, because a daemon that predates `list`
 * binds root and sends root's whole snapshot before saying so.
 */
function handleListingFrame(state: ListingState, value: unknown): void {
  if (!isRecord(value) || typeof value["type"] !== "string") {
    return;
  }
  const event = toPrintable(value);
  if (event.type === "error") {
    failListing(state, event);
  } else if (event.type === "conversations") {
    state.answered = true;
    state.output.write(state.render(event));
    if (event.truncated) {
      state.errors.write(`${TRUNCATED_HINT}\n`);
    }
  }
}

/** The daemon closed: a reply settles, a failure rejects, silence is its own failure. */
function settleListing(state: ListingState): void {
  if (state.failure !== undefined) {
    state.reject(state.failure);
    return;
  }
  if (!state.answered) {
    state.errors.write(noticeText(state.render, CLOSED_BEFORE_LISTING));
    state.reject(new NotListedError(CLOSED_BEFORE_LISTING));
    return;
  }
  state.resolve(undefined);
}

/** Wire the socket: a reset destroys it; each accepted frame is handled; close settles. */
function wireListing(state: ListingState): void {
  state.socket.on("error", () => {
    state.socket.destroy();
  });
  state.socket.on(
    "data",
    lineSplitter((line) => {
      handleListingFrame(state, JSON.parse(line));
    }),
  );
  state.socket.on("close", () => {
    settleListing(state);
  });
}

/**
 * List the store's conversation ids: one `list` frame in, one `conversations`
 * reply out, then a clean close. Ids go to `output` through the renderer and
 * nothing else does; every refusal, skew and truncation goes to `errors`, so a
 * `--list` reading stdout sees ids and only ids (DEC-008).
 */
export async function listConversations(
  socketPath: string,
  output: Writable,
  errors: Writable,
  wait: ConnectWait,
  presentation: Presentation = "terminal",
): Promise<void> {
  const render = createRenderer({ presentation });
  // A dead daemon is told on `errors`: stdout stays reserved for ids.
  const socket = await connectOrExplain(socketPath, errors, render, wait);
  const { promise, resolve, reject } = Promise.withResolvers<undefined>();
  const state: ListingState = { socket, output, errors, render, answered: false, resolve, reject };
  socket.write(encodeLine(LIST_FRAME));
  wireListing(state);
  await promise;
}
