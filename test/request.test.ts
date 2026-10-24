// One frame out, one typed reply in: the listing lifecycle over a socket, and
// the skew an older daemon answers it with (SL-003 EX-6's split).

import { PassThrough } from "node:stream";
import { describe, expect, it, onTestFinished } from "vitest";
import { attachInvocationOf } from "../src/attach-invocation.ts";
import { context } from "../src/context.ts";
import { conversations } from "../src/conversations.ts";
import { encodeLine } from "../src/ndjson.ts";
import { listConversations, NotListedError } from "../src/request.ts";
import type { ConnectWait } from "../src/unix-socket.ts";
import { collect, fakeDaemon, rejection, skewMessage, socketPath } from "./fixtures.ts";
import { FAUX_MODEL, openTestHarness, serveTest } from "./harness-fixture.ts";

/** What a listing client wrote to each of its two streams, and its completion. */
interface Listing {
  done: Promise<void>;
  printed: () => string;
  errors: () => string;
}

/** A listing client of `path`: ids on stdout, prose on stderr. */
const listing = (path: string, wait: ConnectWait): Listing => {
  const [output, errors] = [new PassThrough(), new PassThrough()];
  const [printed, errorText] = [collect(output), collect(errors)];
  return { done: listConversations(path, output, errors, wait), printed, errors: errorText };
};

// ---------------------------------------------------------------------------
// `malebolge-attach --list`: one frame, ids on stdout, its own wait (DEC-008).
// ---------------------------------------------------------------------------

describe("attach --list", () => {
  const wait: ConnectWait = { intervalMs: 20, timeoutMs: 200 };

  it("prints the ids one per line, prints no notice, and sends exactly one list frame", async () => {
    const path = await socketPath();
    const test = await openTestHarness([]);
    onTestFinished(() => test.harness.close(context));
    const daemon = await serveTest(test, path);
    onTestFinished(daemon.close);
    const api = conversations(test, { model: FAUX_MODEL, cwd: process.cwd() }, "host");
    const first = await api.open({ kind: "new" });
    const second = await api.open({ kind: "new" });
    const l = listing(path, wait);
    await l.done;
    // Newest first, the shared reply type either side of the wire.
    expect(l.printed()).toBe(
      `${String(second.id)}\n${String(first.id)}\n${String(test.root.id)}\n`,
    );
    expect(l.errors()).toBe("");
  });

  it("writes one truncated line to stderr for --list, leaving stdout ids only", async () => {
    const path = await socketPath();
    await fakeDaemon(path, (socket) => {
      socket.end(encodeLine({ type: "conversations", conversations: [9, 7], truncated: true }));
    });
    const l = listing(path, wait);
    await l.done;
    expect(l.printed()).toBe("9\n7\n");
    expect(
      l
        .errors()
        .split("\n")
        .filter((line) => line !== ""),
    ).toHaveLength(1);
  });

  it("ignores the snapshot a pre-list daemon sends first, names `unknown message type` and exits 1 through NOT_LISTED", async () => {
    const path = await socketPath();
    const skew = skewMessage("list");
    const fake = await fakeDaemon(path, (socket) => {
      socket.write(
        encodeLine({
          type: "snapshot",
          entries: [{ kind: "pi.user", model: [{ role: "user", content: "earlier" }] }],
        }),
      );
      socket.write(encodeLine({ type: "error", message: skew }));
    });
    const l = listing(path, wait);
    expect(await rejection(l.done)).toMatchObject({ code: "NOT_LISTED" });
    // The old daemon bound root and sent its whole transcript first: none of it prints.
    expect(l.printed()).toBe("");
    expect(l.errors()).not.toContain("» earlier");
    expect(l.errors()).toContain(`[error: ${skew}]\n`);
    expect(l.errors()).toContain(
      "[the daemon predates list: restart it (malebolge-stop, then malebolge-start)]\n",
    );
    await fake.closed;
  });

  it("answers an error frame with one line on stderr, ends its own socket, and exits 1", async () => {
    const path = await socketPath();
    const fake = await fakeDaemon(path, (socket) => {
      socket.write(encodeLine({ type: "error", message: "listing failed" }));
    });
    const l = listing(path, wait);
    expect(await rejection(l.done)).toBeInstanceOf(NotListedError);
    expect(l.printed()).toBe("");
    expect(l.errors()).toBe("[error: listing failed]\n");
    // The old daemon leaves the connection open: waiting for its close would hang.
    await fake.closed;
  });

  it("reports a close before any reply through NOT_LISTED", async () => {
    const path = await socketPath();
    const fake = await fakeDaemon(path);
    const l = listing(path, wait);
    await fake.lines.next((line) => line.includes('"list"'));
    fake.destroy();
    expect(await rejection(l.done)).toMatchObject({ code: "NOT_LISTED" });
    expect(l.printed()).toBe("");
    expect(l.errors()).not.toBe("");
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
    const l = listing(path, listingWait);
    expect(await rejection(l.done)).toMatchObject({ code: "ENOENT" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(l.printed()).toBe("");
    expect(l.errors()).toContain(`cannot connect to ${path}`);
  });
});
