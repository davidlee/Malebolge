import { join } from "node:path";
import {
  fauxAssistantMessage,
  type FauxResponseFactory,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { type AgentEventStream, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { context } from "../src/context.ts";
import { type Daemon, serve } from "../src/daemon.ts";
import { type Printable, toPrintable } from "../src/render.ts";
import { registryOf } from "../src/registry.ts";
import { satanTools } from "../src/satan-tools.ts";
import {
  type FakeTool,
  fakeMcpServer,
  type LineClient,
  lineClient,
  recorder,
  tempDir,
} from "./fixtures.ts";
import { openFauxHarness, openTestHarness, type TestHarness } from "./harness-fixture.ts";

/** The event streams the daemon watches, so a test can read their `closed` promise. */
const watched = vi.hoisted(() => {
  const streams: AgentEventStream[] = [];
  let next = Promise.withResolvers<AgentEventStream>();
  return {
    streams,
    next: (): Promise<AgentEventStream> => next.promise,
    push: (stream: AgentEventStream): void => {
      streams.push(stream);
      next.resolve(stream);
    },
    reset: (): void => {
      streams.length = 0;
      next = Promise.withResolvers<AgentEventStream>();
    },
  };
});

vi.mock("@earendil-works/pi-durable", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-durable")>();
  return {
    ...actual,
    watchEvents: async (
      ...args: Parameters<typeof actual.watchEvents>
    ): Promise<AgentEventStream> => {
      const stream = await actual.watchEvents(...args);
      watched.push(stream);
      return stream;
    },
  };
});

type EventOf<K extends Printable["type"]> = Extract<Printable, { type: K }>;

const isType =
  <K extends Printable["type"]>(type: K) =>
  (event: Printable): event is EventOf<K> =>
    event.type === type;

const noteTool: FakeTool = {
  name: "notes_read",
  description: "Read a note",
  call: () => ({ text: "note" }),
};

const noGate = (): Promise<void> => Promise.resolve();
const noLog = (): void => undefined;

describe("daemon", () => {
  let cleanup: () => Promise<void>;
  let test: TestHarness;
  let daemon: Daemon;
  let socketPath: string;
  let dir: string;
  const clients: LineClient<Printable>[] = [];
  const extraStops: (() => Promise<void>)[] = [];

  const start = async (
    session: Promise<TestHarness> = openTestHarness([]),
    beforeInput: () => Promise<void> = noGate,
  ): Promise<TestHarness> => {
    test = await session;
    daemon = await serve(session, socketPath, beforeInput);
    return test;
  };

  const attach = async (): Promise<LineClient<Printable>> => {
    const client = await lineClient(socketPath, toPrintable);
    clients.push(client);
    await client.next(isType("snapshot"));
    return client;
  };

  const runEnds = (client: LineClient<Printable>): number =>
    client.received().filter(isType("run_end")).length;

  beforeEach(async () => {
    const tmp = await tempDir();
    cleanup = tmp.cleanup;
    dir = tmp.dir;
    socketPath = join(tmp.dir, "durable.sock");
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.close();
    }
    await daemon.close();
    await test.harness.close(context);
    for (const stop of extraStops.splice(0).reverse()) {
      await stop();
    }
    await cleanup();
  });

  it("answers input and streams the run to the client", async () => {
    await start();
    test.faux.setResponses([fauxAssistantMessage([fauxText("hello")])]);
    const client = await attach();
    client.send({ type: "input", content: "hi" });
    const answer = await client.next(
      (e): e is EventOf<"message_end"> =>
        isType("message_end")(e) && e.entry.kind === "pi.assistant",
    );
    expect(JSON.stringify(answer.entry.model)).toContain("hello");
    await client.next(isType("run_end"));
  });

  it("gives a late client the transcript so far as its snapshot", async () => {
    await start();
    test.faux.setResponses([fauxAssistantMessage([fauxText("hello")])]);
    const first = await attach();
    first.send({ type: "input", content: "hi" });
    await first.next(isType("run_end"));
    const late = await lineClient(socketPath, toPrintable);
    clients.push(late);
    const snapshot = await late.next(isType("snapshot"));
    expect(snapshot.entries.map((e) => e.kind)).toEqual(
      expect.arrayContaining(["pi.user", "pi.assistant"]),
    );
  });

  it("broadcasts one client's run to every attached client", async () => {
    await start();
    test.faux.setResponses([fauxAssistantMessage([fauxText("hello")])]);
    const [a, b] = [await attach(), await attach()];
    a.send({ type: "input", content: "hi" });
    await b.next(isType("run_end"));
  });

  it("answers a malformed line with an error and keeps the connection", async () => {
    await start();
    test.faux.setResponses([fauxAssistantMessage([fauxText("hello")])]);
    const client = await attach();
    client.send({ type: "nonsense" });
    const error = await client.next(isType("error"));
    expect(error.message).toMatch(/nonsense/);
    client.send({ type: "input", content: "hi" });
    await client.next(isType("run_end"));
  });

  it("removes the socket file on close", async () => {
    await start();
    const { existsSync } = await import("node:fs");
    expect(existsSync(socketPath)).toBe(true);
    await daemon.close();
    expect(existsSync(socketPath)).toBe(false);
  });

  it("waits for the session before sending a connection its snapshot", async () => {
    const pending = Promise.withResolvers<TestHarness>();
    test = await openTestHarness([]);
    daemon = await serve(pending.promise, socketPath, noGate);
    const client = await lineClient(socketPath, toPrintable);
    clients.push(client);
    expect(client.received().some(isType("snapshot"))).toBe(false);
    pending.resolve(test);
    await client.next(isType("snapshot"));
  });

  it("stops watching when a client leaves before the session resolves", async () => {
    const pending = Promise.withResolvers<TestHarness>();
    test = await openTestHarness([]);
    watched.reset();
    daemon = await serve(pending.promise, socketPath, noGate);
    const client = await lineClient(socketPath, toPrintable);
    client.close();
    // One macrotask lets the server read the hang-up; no fixed wait is involved.
    await new Promise((resolve) => setTimeout(resolve, 0));
    pending.resolve(test);
    const stream = await watched.next();
    expect(await stream.closed).toEqual({ reason: "stopped" });
  });

  it("holds an input until beforeInput resolves", async () => {
    const entered = Promise.withResolvers<undefined>();
    const gate = Promise.withResolvers<undefined>();
    await start(openTestHarness([]), () => {
      entered.resolve(undefined);
      return gate.promise;
    });
    test.faux.setResponses([fauxAssistantMessage([fauxText("hello")])]);
    const client = await attach();
    client.send({ type: "input", content: "hi" });
    await entered.promise;
    expect(test.faux.state.callCount).toBe(0);
    expect(client.received().some(isType("run_start"))).toBe(false);
    gate.resolve(undefined);
    const answer = await client.next(
      (e): e is EventOf<"message_end"> =>
        isType("message_end")(e) && e.entry.kind === "pi.assistant",
    );
    expect(JSON.stringify(answer.entry.model)).toContain("hello");
    await client.next(isType("run_end"));
  });

  it("does not run beforeInput for abort or compact", async () => {
    let calls = 0;
    await start(openTestHarness([]), () => {
      calls++;
      return Promise.resolve();
    });
    test.faux.setResponses([
      fauxAssistantMessage([fauxText("one")]),
      fauxAssistantMessage([fauxText("two")]),
      fauxAssistantMessage([fauxText("three")]),
      fauxAssistantMessage([fauxText("four")]),
    ]);
    const client = await attach();
    client.send({ type: "abort" });
    client.send({ type: "compact" });
    client.send({ type: "input", content: "hi" });
    await client.next(isType("run_end"));
    expect(calls).toBe(1);
  });

  it("submits concurrent inputs after one held SATAN refresh (VT-8)", async () => {
    const mcp = await fakeMcpServer(join(dir, "mcp.sock"), [noteTool], {
      silent: ["tools/list"],
    });
    extraStops.push(() => mcp.close());
    const registry = registryOf([]);
    const satan = satanTools(mcp.socketPath, registry, noLog, { deadlineMs: 5000 });
    extraStops.push(() => satan.close());
    const entered = recorder<number>();
    let refreshes = 0;
    const beforeInput = (): Promise<void> => {
      entered.push(++refreshes);
      return satan.refresh();
    };
    await start(openFauxHarness(new MemoryStorage(), { registry }), beforeInput);
    test.faux.setResponses([
      fauxAssistantMessage([fauxText("one")]),
      fauxAssistantMessage([fauxText("two")]),
    ]);
    const [a, b] = [await attach(), await attach()];
    a.send({ type: "input", content: "one" });
    await entered.next((count) => count === 1);
    await mcp.requests.next((method) => method === "tools/list");
    b.send({ type: "input", content: "two" });
    await entered.next((count) => count === 2);
    expect(test.faux.state.callCount).toBe(0);
    await mcp.release();
    await a.next(() => runEnds(a) === 2);
    const page = await test.root.entries({}, 50, undefined, context);
    expect(page.items.filter((entry) => entry.kind === "pi.user")).toHaveLength(2);
    const lists = mcp.requests.items.filter((method) => method === "tools/list");
    expect(lists.length).toBeGreaterThanOrEqual(1);
    expect(lists.length).toBeLessThanOrEqual(2);
  });

  it("offers SATAN tools at the next input once the server appears (VT-2/VT-3)", async () => {
    const mcpSocket = join(dir, "late-mcp.sock");
    const registry = registryOf([]);
    const satan = satanTools(mcpSocket, registry, noLog, { deadlineMs: 500 });
    extraStops.push(() => satan.close());
    const offered: string[][] = [];
    const observe: FauxResponseFactory = (transcript) => {
      offered.push(getCurrentTools(transcript.messages).map((tool) => tool.name));
      return fauxAssistantMessage([fauxText("ok")]);
    };
    await start(openFauxHarness(new MemoryStorage(), { registry }), satan.refresh);
    test.faux.setResponses([observe, observe]);
    const client = await attach();
    client.send({ type: "input", content: "one" });
    await client.next(isType("run_end"));
    expect(offered[0]).not.toContain("notes_read");
    const mcp = await fakeMcpServer(mcpSocket, [noteTool]);
    extraStops.push(() => mcp.close());
    client.send({ type: "input", content: "two" });
    await client.next(() => runEnds(client) === 2);
    expect(offered[1]).toContain("notes_read");
  });
});
