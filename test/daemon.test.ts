import { once } from "node:events";
import type { Socket } from "node:net";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  type FauxResponseFactory,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { type AgentEventStream, defineTask, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { context } from "../src/context.ts";
import { type ConversationDefaults, conversations } from "../src/conversations.ts";
import { type Daemon, serve } from "../src/daemon.ts";
import { encodeLine } from "../src/ndjson.ts";
import { type Printable, toPrintable } from "../src/render.ts";
import { registryOf } from "../src/registry.ts";
import { satanTools } from "../src/satan-tools.ts";
import {
  type FakeTool,
  fakeMcpServer,
  type LineClient,
  lineClient,
  type Recorder,
  recorder,
  tempDir,
} from "./fixtures.ts";
import {
  FAUX_MODEL,
  openFauxHarness,
  openTestHarness,
  type TestHarness,
} from "./harness-fixture.ts";

/**
 * The event streams the daemon watches, so a test can read their `closed` promise,
 * which streams had `start` called, and a barrier that can hold `watch` pending.
 */
const watched = vi.hoisted(() => {
  const streams: AgentEventStream[] = [];
  const started: AgentEventStream[] = [];
  let next = Promise.withResolvers<AgentEventStream>();
  let entered = Promise.withResolvers<undefined>();
  let gate = Promise.withResolvers<undefined>();
  gate.resolve(undefined); // Open by default: only a holding test sees a pause.
  return {
    streams,
    started,
    next: (): Promise<AgentEventStream> => next.promise,
    push: (stream: AgentEventStream): void => {
      streams.push(stream);
      next.resolve(stream);
    },
    /** Hold the next `watchEvents` call, just before it returns its stream. */
    hold: (): void => {
      entered = Promise.withResolvers<undefined>();
      gate = Promise.withResolvers<undefined>();
    },
    entered: (): Promise<undefined> => entered.promise,
    enter: (): void => {
      entered.resolve(undefined);
    },
    gate: (): Promise<undefined> => gate.promise,
    release: (): void => {
      gate.resolve(undefined);
    },
    reset: (): void => {
      streams.length = 0;
      started.length = 0;
      next = Promise.withResolvers<AgentEventStream>();
      entered = Promise.withResolvers<undefined>();
      gate = Promise.withResolvers<undefined>();
      gate.resolve(undefined);
    },
  };
});

/** Every socket the daemon accepted, so a test can await its server-side close. */
const accepted = vi.hoisted(() => {
  let current: Recorder<Socket> | undefined;
  return {
    set: (value: Recorder<Socket>): void => {
      current = value;
    },
    push: (value: Socket): void => {
      current?.push(value);
    },
    next: (match: (value: Socket) => boolean): Promise<Socket> =>
      current?.next(match) ?? Promise.reject(new Error("accepted recorder is not set")),
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
      const start = stream.start.bind(stream);
      stream.start = (...startArgs: Parameters<typeof start>): void => {
        watched.started.push(stream);
        start(...startArgs);
      };
      // The stream exists (bind has reached `watch`): signal, then hold until released.
      watched.enter();
      await watched.gate();
      watched.push(stream);
      return stream;
    },
  };
});

vi.mock("../src/unix-socket.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/unix-socket.ts")>();
  return {
    ...actual, // connectUnix/listenUnix stay real for test/fixtures.ts.
    serveUnix: (
      ...args: Parameters<typeof actual.serveUnix>
    ): ReturnType<typeof actual.serveUnix> => {
      const [path, onConnection] = args;
      return actual.serveUnix(path, (socket) => {
        accepted.push(socket);
        onConnection(socket);
      });
    },
  };
});

/** One write holding the attach frame and the input behind it. */
const attachAndInput = (): string =>
  encodeLine({ type: "attach" }) + encodeLine({ type: "input", content: "hi" });

/** The daemon's creation defaults for the tests' conversations. */
const DEFAULTS: ConversationDefaults = { model: FAUX_MODEL, cwd: process.cwd() };

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

/** A task whose only phase waits: a stub, never run on a passive harness. */
const stubTask = defineTask({
  name: "stub",
  version: 1,
  initial: () => ({ phase: "waiting" as const }),
  phases: { waiting: () => Promise.resolve() },
  abort: () => Promise.resolve(),
});

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

  /** The daemon on this test's socket, over a session that may not be ready yet. */
  const serveSession = (
    session: Promise<TestHarness>,
    beforeInput: () => Promise<void>,
  ): Promise<Daemon> =>
    serve({
      socketPath,
      conversations: session.then((harness) => conversations(harness, DEFAULTS)),
      beforeInput,
    });

  const start = async (
    session: Promise<TestHarness> = openTestHarness([]),
    beforeInput: () => Promise<void> = noGate,
  ): Promise<TestHarness> => {
    test = await session;
    daemon = await serveSession(session, beforeInput);
    return test;
  };

  const attach = async (): Promise<LineClient<Printable>> => {
    const client = await lineClient(socketPath, toPrintable);
    clients.push(client);
    client.send({ type: "attach" });
    await client.next(isType("attached"));
    await client.next(isType("snapshot"));
    return client;
  };

  /**
   * A raw client writes `frame` and leaves before the session is ready. Resolves
   * once the daemon's own socket has seen the hang-up (a receipt, not a timer).
   */
  const depart = async (frame: unknown): Promise<void> => {
    const pending = Promise.withResolvers<TestHarness>();
    test = await openTestHarness([]);
    daemon = await serveSession(pending.promise, noGate);
    const client = await lineClient(socketPath, toPrintable);
    clients.push(client);
    const serverSocket = await accepted.next(() => true);
    await client.write(encodeLine(frame));
    // Armed before the hang-up, so this close is the departing connection's own.
    const closed = once(serverSocket, "close");
    client.close();
    await closed;
    pending.resolve(test);
  };

  /**
   * A raw client attaches, its turn reaches `watch` (the barrier holds it there),
   * then it leaves; the gate is released only once the daemon's own socket has
   * seen the hang-up. Returns the one stream the bind acquired.
   */
  const midBindDepart = async (frame: unknown): Promise<AgentEventStream> => {
    await start();
    watched.hold();
    const client = await lineClient(socketPath, toPrintable);
    clients.push(client);
    const serverSocket = await accepted.next(() => true);
    try {
      await client.write(encodeLine(frame));
      await watched.entered(); // the turn has started: bind is held inside `watch`
      // Armed before the hang-up, so this close is the departing connection's own.
      const closed = once(serverSocket, "close");
      client.close();
      await closed;
    } finally {
      watched.release();
    }
    return watched.next();
  };

  /** The control connection's one completed input: the settle point for a negative assertion. */
  const settle = async (control: LineClient<Printable>): Promise<void> => {
    test.faux.setResponses([fauxAssistantMessage([fauxText("hello")])]);
    control.send({ type: "input", content: "control" });
    await control.next(isType("run_end"));
    expect(watched.streams).toHaveLength(1);
    expect(test.faux.state.callCount).toBe(1);
  };

  /** The conversations the daemon's store holds, oldest first. */
  const conversationIds = async (): Promise<readonly number[]> => {
    const page = await test.harness.commit(
      (tx) => tx.scanConversations({}, 50, undefined),
      context,
    );
    return page.items.map((record) => record.id);
  };

  const runEnds = (client: LineClient<Printable>): number =>
    client.received().filter(isType("run_end")).length;

  /** Where in the received order the first event of `type` arrived; -1 if never. */
  const at = (client: LineClient<Printable>, type: Printable["type"]): number =>
    client.received().findIndex((event) => event.type === type);

  beforeEach(async () => {
    const tmp = await tempDir();
    cleanup = tmp.cleanup;
    dir = tmp.dir;
    socketPath = join(tmp.dir, "durable.sock");
    watched.reset();
    accepted.set(recorder<Socket>());
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
    late.send({ type: "attach" });
    await late.next(isType("attached"));
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

  it("binds a connection silently and in order once ready (V-13)", async () => {
    const pending = Promise.withResolvers<TestHarness>();
    test = await openTestHarness([]);
    daemon = await serveSession(pending.promise, noGate);
    const client = await lineClient(socketPath, toPrintable);
    clients.push(client);
    // One write: the attach frame and the input behind it arrive together.
    await client.write(attachAndInput());
    expect(client.received()).toEqual([]);
    test.faux.setResponses([fauxAssistantMessage([fauxText("hello")])]);
    pending.resolve(test);
    await client.next(isType("attached"));
    await client.next(isType("snapshot"));
    await client.next(isType("run_end"));
    expect(at(client, "attached")).toBeLessThan(at(client, "snapshot"));
    expect(at(client, "snapshot")).toBeLessThan(at(client, "run_end"));
  });

  it("refuses an attach frame that names both a conversation and a new one (V-1)", async () => {
    await start();
    const client = await lineClient(socketPath, toPrintable);
    clients.push(client);
    await client.write(
      encodeLine({ type: "attach", conversation: 1, new: true }) +
        encodeLine({ type: "input", content: "dropped" }),
    );
    const error = await client.next(isType("error"));
    expect(error.message).toMatch(/^attach: /);
    await client.closed();
    expect(client.received().some(isType("snapshot"))).toBe(false);
    expect(test.faux.state.callCount).toBe(0);
    expect(await conversationIds()).toEqual([test.root.id]);
  });

  it("refuses an attach frame naming an unknown conversation (V-1)", async () => {
    await start();
    const client = await lineClient(socketPath, toPrintable);
    clients.push(client);
    client.send({ type: "attach", conversation: 999999 });
    const error = await client.next(isType("error"));
    expect(error.message).toBe("no conversation 999999");
    await client.closed();
    expect(client.received().some(isType("snapshot"))).toBe(false);
    expect(await conversationIds()).toEqual([test.root.id]);
  });

  it("refuses an attach frame naming a task-owned conversation (V-1)", async () => {
    await start(openFauxHarness(new MemoryStorage(), { resume: false }));
    const owned = await test.harness.commit(async (tx) => {
      const taskId = await tx.createTask(
        stubTask,
        {},
        { ownership: { kind: "conversation" }, conversationId: test.root.id },
      );
      return (await tx.createConversation({ ownership: { kind: "task", taskId } })).id;
    }, context);
    const client = await lineClient(socketPath, toPrintable);
    clients.push(client);
    client.send({ type: "attach", conversation: owned });
    const error = await client.next(isType("error"));
    expect(error.message).toBe(`conversation ${String(owned)} belongs to a task`);
    await client.closed();
    expect(client.received().some(isType("snapshot"))).toBe(false);
    expect(await conversationIds()).toEqual([test.root.id, owned]);
  });

  it("attaches a created conversation, then resolves it by id (V-1, V-3)", async () => {
    await start();
    const creator = await lineClient(socketPath, toPrintable);
    clients.push(creator);
    creator.send({ type: "attach", new: true, cwd: "/own" });
    const attached = await creator.next(isType("attached"));
    const snapshot = await creator.next(isType("snapshot"));
    expect(creator.received().filter(isType("attached"))).toHaveLength(1);
    expect(at(creator, "attached")).toBeLessThan(at(creator, "snapshot"));
    expect(snapshot.agent.cwd).toBe("/own");
    const api = conversations(test, DEFAULTS);
    const created = await api.open({ kind: "existing", id: attached.conversation });
    expect((await created.agent(context)).cwd).toBe("/own");
    const second = await lineClient(socketPath, toPrintable);
    clients.push(second);
    second.send({ type: "attach", conversation: attached.conversation });
    const again = await second.next(isType("attached"));
    expect(again.conversation).toBe(attached.conversation);
    expect((await second.next(isType("snapshot"))).agent.cwd).toBe("/own");
    const plain = await lineClient(socketPath, toPrintable);
    clients.push(plain);
    plain.send({ type: "attach" });
    expect((await plain.next(isType("attached"))).conversation).toBe(test.root.id);
  });

  it("binds root for a first line that is a command, with no attached (V-2)", async () => {
    await start();
    test.faux.setResponses([fauxAssistantMessage([fauxText("hello")])]);
    const client = await lineClient(socketPath, toPrintable);
    clients.push(client);
    client.send({ type: "input", content: "hi" });
    await client.next(isType("snapshot"));
    await client.next(isType("run_end"));
    expect(client.received().some(isType("attached"))).toBe(false);
  });

  it.each(["not json", '{"type":"warp"}'])(
    "binds root, reports the bad first line and stays open: %j (V-2)",
    async (raw) => {
      await start();
      test.faux.setResponses([fauxAssistantMessage([fauxText("hello")])]);
      const client = await lineClient(socketPath, toPrintable);
      clients.push(client);
      await client.write(`${raw}\n`);
      await client.next(isType("snapshot"));
      await client.next(isType("error"));
      expect(at(client, "snapshot")).toBeLessThan(at(client, "error"));
      client.send({ type: "input", content: "hi" });
      await client.next(isType("run_end"));
    },
  );

  it("handles attach and input written in one write, in order (V-5)", async () => {
    await start();
    test.faux.setResponses([fauxAssistantMessage([fauxText("hello")])]);
    const client = await lineClient(socketPath, toPrintable);
    clients.push(client);
    await client.write(attachAndInput());
    await client.next(isType("attached"));
    await client.next(isType("snapshot"));
    await client.next(isType("run_end"));
    expect(at(client, "attached")).toBeLessThan(at(client, "snapshot"));
    expect(at(client, "snapshot")).toBeLessThan(at(client, "run_end"));
  });

  it("handles one frame split across two writes, in order (V-5)", async () => {
    await start();
    test.faux.setResponses([fauxAssistantMessage([fauxText("hello")])]);
    const client = await lineClient(socketPath, toPrintable);
    clients.push(client);
    await client.write('{"type":"attach"}\n{"type":"inp');
    await client.write('ut","content":"hi"}\n');
    await client.next(isType("attached"));
    await client.next(isType("snapshot"));
    await client.next(isType("run_end"));
    expect(at(client, "attached")).toBeLessThan(at(client, "snapshot"));
    expect(at(client, "snapshot")).toBeLessThan(at(client, "run_end"));
  });

  it("answers a second attach with already attached and keeps the binding (V-6)", async () => {
    await start();
    test.faux.setResponses([fauxAssistantMessage([fauxText("hello")])]);
    // A conversation this connection is not bound to: a re-bind would be visible.
    const other = await conversations(test, DEFAULTS).open({ kind: "new" });
    const client = await attach();
    client.send({ type: "attach", conversation: other.id });
    const error = await client.next(isType("error"));
    expect(error.message).toBe("already attached to conversation 1");
    expect(watched.streams).toHaveLength(1);
    client.send({ type: "input", content: "hi" });
    await client.next(isType("run_end"));
    expect((await test.root.entries({}, 50, undefined, context)).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "pi.user" })]),
    );
    expect((await other.entries({}, 50, undefined, context)).items).toHaveLength(0);
  });

  it("answers a malformed second attach with already attached (V-6)", async () => {
    await start();
    const client = await attach();
    client.send({ type: "attach", conversation: 0 });
    const error = await client.next(isType("error"));
    expect(error.message).toBe("already attached to conversation 1");
    client.send({ type: "nonsense" });
    const garbage = await client.next(
      (e): e is EventOf<"error"> => isType("error")(e) && e.message.includes("nonsense"),
    );
    expect(garbage.message).toMatch(/nonsense/);
  });

  it("stops watching a bound conversation when its client leaves (EX-3)", async () => {
    await start();
    const client = await attach();
    const stream = await watched.next();
    client.close();
    expect(await stream.closed).toEqual({ reason: "stopped" });
  });

  it("drops a root attach that departs before the session is ready (V-11)", async () => {
    await depart({ type: "attach" });
    await settle(await attach());
    expect(await conversationIds()).toEqual([test.root.id]);
  });

  it("drops a new attach that departs before ready, creating nothing (V-11)", async () => {
    await depart({ type: "attach", new: true, cwd: "/departed" });
    await settle(await attach());
    expect(await conversationIds()).toEqual([test.root.id]);
  });

  it("drops an input from a client that departs before the session is ready (V-14)", async () => {
    await depart({ type: "input", content: "departed" });
    await settle(await attach());
  });

  it("stops the stream of a root attach that departs mid-bind (V-15)", async () => {
    const stream = await midBindDepart({ type: "attach" });
    // Bind finished: the destroyed branch stopped the stream, so this resolves.
    expect(await stream.closed).toEqual({ reason: "stopped" });
    expect(watched.streams).toHaveLength(1);
    // `start` never ran: the destroyed branch stopped it, not the close handler.
    expect(watched.started).toHaveLength(0);
  });

  it("leaves the created conversation when a new attach departs mid-bind (V-15)", async () => {
    const stream = await midBindDepart({ type: "attach", new: true, cwd: "/own" });
    expect(await stream.closed).toEqual({ reason: "stopped" });
    expect(watched.streams).toHaveLength(1);
    expect(watched.started).toHaveLength(0);
    // The accepted DEC-108 strand: created before `watch`, still there, ownerless.
    const page = await test.harness.commit(
      (tx) => tx.scanConversations({}, 50, undefined),
      context,
    );
    const created = page.items.filter((record) => record.id !== test.root.id);
    expect(created).toHaveLength(1);
    expect(created[0]?.owner).toBeUndefined();
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
