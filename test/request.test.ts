// One frame out, one typed reply in: the request path `--list`, `--topics` and
// `--set-topic` share, and the skew an older daemon answers it with (SL-003
// EX-1 and EX-4).

import { PassThrough } from "node:stream";
import { describe, expect, it, onTestFinished } from "vitest";
import { attachInvocationOf, isResolved } from "../src/attach-invocation.ts";
import { context } from "../src/context.ts";
import { conversations } from "../src/conversations.ts";
import { encodeLine } from "../src/ndjson.ts";
import type { ConversationsMessage, TopicsMessage } from "../src/protocol.ts";
import { createRenderer } from "../src/render.ts";
import {
  requestFrameOf,
  replyTypeOf,
  request,
  type ReplyMessage,
  RequestFailedError,
  skewOf,
} from "../src/request.ts";
import { collect, fakeDaemon, rejection, socketPath } from "./fixtures.ts";
import { FAUX_MODEL, openTestHarness, serveTest } from "./harness-fixture.ts";

/** A request for `args`'s mode of `path`: its reply, and what it wrote to stderr. */
function requested(
  path: string,
  args: string[],
): { reply: Promise<ReplyMessage>; errors: () => string } {
  const errors = new PassThrough();
  const errorText = collect(errors);
  const invocation = attachInvocationOf(args);
  if (invocation.mode === undefined || !isResolved(invocation)) {
    throw new Error(`${args.join(" ")} attaches rather than requests`);
  }
  const reply = request(
    path,
    requestFrameOf(invocation),
    replyTypeOf(invocation),
    errors,
    invocation.wait,
  );
  return { reply, errors: errorText };
}

/** A mode's reply as `attach-main` prints it: one renderer per reply, as the CLI makes one. */
const printed = (reply: ConversationsMessage | TopicsMessage): string => createRenderer()(reply);

// ---------------------------------------------------------------------------
// `malebolge-attach --list`: one frame, the typed reply out, its own wait (DEC-008).
// ---------------------------------------------------------------------------

describe("request --list", () => {
  it("resolves to the typed conversations reply and writes no ids itself: the caller renders them", async () => {
    const path = await socketPath();
    const test = await openTestHarness([]);
    onTestFinished(() => test.harness.close(context));
    const daemon = await serveTest(test, path);
    onTestFinished(daemon.close);
    const api = conversations(test, { model: FAUX_MODEL, cwd: process.cwd() }, "host");
    const first = await api.open({ kind: "new" });
    const second = await api.open({ kind: "new" });

    const { reply, errors } = requested(path, ["--list"]);
    const conversationsReply = await reply;
    const ids = [second.id, first.id, test.root.id];
    expect(conversationsReply).toEqual({
      type: "conversations",
      conversations: ids,
      truncated: false,
    });
    // SL-002's bytes, still: newest first, one id per line, nothing else.
    expect(printed(conversationsReply)).toBe(ids.map((id) => `${String(id)}\n`).join(""));
    expect(errors()).toBe("");
  });

  it("writes one truncated line to stderr, leaving the ids to the caller", async () => {
    const path = await socketPath();
    await fakeDaemon(path, (socket) => {
      socket.end(encodeLine({ type: "conversations", conversations: [9, 7], truncated: true }));
    });
    const { reply, errors } = requested(path, ["--list"]);
    const truncated = await reply;
    expect(truncated).toEqual({ type: "conversations", conversations: [9, 7], truncated: true });
    // The ids are the caller's to print; the truncation is the only line stderr gets.
    expect(printed(truncated)).toBe("9\n7\n");
    expect(
      errors()
        .split("\n")
        .filter((line) => line !== ""),
    ).toHaveLength(1);
  });

  it("ignores the snapshot a pre-list daemon sends first, names `unknown message type` and exits 1 through REQUEST_FAILED", async () => {
    const path = await socketPath();
    const skew = 'unknown message type "list"';
    const fake = await fakeDaemon(path, (socket) => {
      socket.write(
        encodeLine({
          type: "snapshot",
          entries: [{ kind: "pi.user", model: [{ role: "user", content: "earlier" }] }],
        }),
      );
      socket.write(encodeLine({ type: "error", message: skew }));
    });
    const { reply, errors } = requested(path, ["--list"]);
    expect(await rejection(reply)).toMatchObject({ code: "REQUEST_FAILED" });
    // The old daemon bound root and sent its whole transcript first: none of it is rendered.
    expect(errors()).not.toContain("» earlier");
    expect(errors()).toContain(`[error: ${skew}]\n`);
    expect(errors()).toContain(
      "[the daemon predates list: restart it (malebolge-stop, then malebolge-start)]\n",
    );
    await fake.closed;
  });

  it("answers an error frame with one line on stderr, ends its own socket, and rejects", async () => {
    const path = await socketPath();
    const fake = await fakeDaemon(path, (socket) => {
      socket.write(encodeLine({ type: "error", message: "listing failed" }));
    });
    const { reply, errors } = requested(path, ["--list"]);
    expect(await rejection(reply)).toBeInstanceOf(RequestFailedError);
    expect(errors()).toBe("[error: listing failed]\n");
    // The old daemon leaves the connection open: waiting for its close would hang.
    await fake.closed;
  });

  it("stays refused when a reply follows the error: one request, one outcome", async () => {
    const path = await socketPath();
    await fakeDaemon(path, (socket) => {
      socket.write(encodeLine({ type: "error", message: "listing failed" }));
      socket.write(encodeLine({ type: "conversations", conversations: [1], truncated: false }));
    });
    const { reply, errors } = requested(path, ["--list"]);
    expect(await rejection(reply)).toBeInstanceOf(RequestFailedError);
    expect(errors()).toBe("[error: listing failed]\n");
  });

  it("ignores an error after the reply: the request was already answered", async () => {
    const path = await socketPath();
    await fakeDaemon(path, (socket) => {
      socket.write(encodeLine({ type: "conversations", conversations: [1], truncated: false }));
      socket.write(encodeLine({ type: "error", message: "late" }));
      socket.end();
    });
    const { reply, errors } = requested(path, ["--list"]);
    expect(await reply).toMatchObject({ conversations: [1] });
    expect(errors()).toBe("");
  });

  it("refuses a line that is not JSON with one stderr line, never a stack trace", async () => {
    const path = await socketPath();
    const fake = await fakeDaemon(path, (socket) => {
      socket.write("not json\n");
    });
    const { reply, errors } = requested(path, ["--list"]);
    expect(await rejection(reply)).toMatchObject({ code: "REQUEST_FAILED" });
    expect(errors()).toBe("[the daemon sent a line that is not JSON]\n");
    await fake.closed;
  });

  it("reports a close before any reply through REQUEST_FAILED", async () => {
    const path = await socketPath();
    const fake = await fakeDaemon(path);
    const { reply, errors } = requested(path, ["--list"]);
    await fake.lines.next((line) => line.includes('"list"'));
    fake.destroy();
    expect(await rejection(reply)).toMatchObject({ code: "REQUEST_FAILED" });
    expect(errors()).not.toBe("");
  });

  it("gives up on its own short LIST_WAIT, not the attach wait", async () => {
    const path = await socketPath();
    const invocation = attachInvocationOf(["--list"]);
    const listingWait = invocation.mode === "list" ? invocation.wait : undefined;
    expect(listingWait).toEqual({ intervalMs: 200, timeoutMs: 1_000 });
    const started = Date.now();
    if (listingWait === undefined) {
      throw new Error("--list is not a list invocation");
    }
    const errors = new PassThrough();
    const errorText = collect(errors);
    const reply = request(path, { type: "list" }, "conversations", errors, listingWait);
    expect(await rejection(reply)).toMatchObject({ code: "ENOENT" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(errorText()).toContain(`cannot connect to ${path}`);
  });
});

// ---------------------------------------------------------------------------
// `--topics` and `--set-topic`: the same path, a `topics` reply (design sec-4).
// ---------------------------------------------------------------------------

describe("request --topics and --set-topic", () => {
  it("resolves a topics request to the `topics` reply, whose profile is the daemon's", async () => {
    const path = await socketPath();
    const test = await openTestHarness([]);
    onTestFinished(() => test.harness.close(context));
    const daemon = await serveTest(test, path);
    onTestFinished(daemon.close);
    const { reply, errors } = requested(path, ["--topics"]);
    const topics = await reply;
    expect(topics).toEqual({ type: "topics", profile: "host", topics: [{ name: "default" }] });
    expect(printed(topics)).toBe("default\t\n");
    expect(errors()).toBe("");
  });

  it("resolves a topic write to the one record it wrote", async () => {
    const path = await socketPath();
    const test = await openTestHarness([]);
    onTestFinished(() => test.harness.close(context));
    const daemon = await serveTest(test, path);
    onTestFinished(daemon.close);
    const { reply } = requested(path, ["--set-topic", "work", "--dir", "/tmp/work"]);
    expect(await reply).toEqual({
      type: "topics",
      profile: "host",
      topics: [{ name: "work", cwd: "/tmp/work" }],
    });
  });
});

// ---------------------------------------------------------------------------
// Skew (inq-7): an older daemon fails a new shape in one of two ways.
// ---------------------------------------------------------------------------

describe("skewOf", () => {
  it.each<[string, string | undefined]>([
    ['unknown message type "topic"', "topic"],
    ['unknown message type "list"', "list"],
    ["attach: unknown key topic", "topic"],
    ["list: unknown key topics", "topics"],
    ["list: unknown key topic", "topic"],
    // Not a skew: an ordinary failure, a refusal of a key we still know, and a name rule.
    ["listing failed", undefined],
    ["list: unknown key page", undefined],
    ["list: topic and topics are exclusive", undefined],
    ['attach: unknown key "topic"', undefined],
  ])("%j → %j", (message, feature) => {
    expect(skewOf(message)).toEqual(feature);
  });
});

describe("request: version skew", () => {
  it.each<[string[], string, string]>([
    // A `topic` first line is not a frame the old daemon knows: it binds root and says so.
    [["--set-topic", "work"], 'unknown message type "topic"', "topic"],
    [["--topics"], "list: unknown key topics", "topics"],
    [["--list", "--topic", "work"], "list: unknown key topic", "topic"],
  ])("%j prints the restart hint for %j", async (args, message, feature) => {
    const path = await socketPath();
    const fake = await fakeDaemon(path, (socket) => {
      socket.write(encodeLine({ type: "error", message }));
    });
    const { reply, errors } = requested(path, args);
    expect(await rejection(reply)).toBeInstanceOf(RequestFailedError);
    expect(errors()).toBe(
      `[error: ${message}]\n[the daemon predates ${feature}: restart it (malebolge-stop, then malebolge-start)]\n`,
    );
    await fake.closed;
  });
});
