import { once } from "node:events";
import type { Socket } from "node:net";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  type FauxResponseFactory,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import {
  type AgentEventStream,
  type Conversation,
  type ConversationId,
  type EntryRecord,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { context } from "../src/context.ts";
import {
  type ConversationDefaults,
  type Conversations,
  conversations,
  isConversationKey,
  LIST_PAGE,
  toolsetInit,
} from "../src/conversations.ts";
import { type Daemon, serve } from "../src/daemon.ts";
import { isRecord, type JsonRecord } from "../src/json.ts";
import { encodeLine } from "../src/ndjson.ts";
import type { ConversationsMessage, TopicSummary, TopicsMessage } from "../src/protocol.ts";
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
  createTaskOwned,
  FAUX_CATALOG,
  FAUX_MODEL,
  forkConversation,
  NAME_RULE,
  indexOf,
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
  /**
   * A fresh entered/gate pair, the outgoing gate settled first, so re-arming never
   * orphans a call already waiting; `opened` false holds the next call instead.
   */
  const rearm = (opened: boolean): void => {
    gate.resolve(undefined);
    entered = Promise.withResolvers<undefined>();
    gate = Promise.withResolvers<undefined>();
    if (opened) {
      gate.resolve(undefined);
    }
  };
  rearm(true); // Open by default: only a holding test sees a pause.
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
      rearm(false);
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
      rearm(true);
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

const noGate = (): Promise<void> => Promise.resolve();
const noOrientation = (): Promise<string> => Promise.resolve("");
const noLog = (): void => undefined;

describe("daemon", () => {
  let cleanup: () => Promise<void>;
  let test: TestHarness;
  let daemon: Daemon;
  let socketPath: string;
  let dir: string;
  const clients: { close: () => void }[] = [];
  const extraStops: (() => Promise<void>)[] = [];

  /** The daemon on this test's socket, over a session that may not be ready yet. */
  const serveSession = (
    session: Promise<TestHarness>,
    beforeInput: () => Promise<void>,
    orientation: (conversation: ConversationId) => Promise<string> = noOrientation,
  ): Promise<Daemon> =>
    serve({
      socketPath,
      conversations: session.then((harness) =>
        conversations(harness, DEFAULTS, "host", FAUX_CATALOG),
      ),
      beforeInput,
      orientation,
    });

  const start = async (
    session: Promise<TestHarness> = openTestHarness([]),
    beforeInput: () => Promise<void> = noGate,
    orientation: (conversation: ConversationId) => Promise<string> = noOrientation,
  ): Promise<TestHarness> => {
    test = await session;
    daemon = await serveSession(session, beforeInput, orientation);
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

  /** The `conversations` reply, strictly: PHASE-01's frame, which no renderer knows yet. */
  const listingFrame = (value: unknown): ConversationsMessage => {
    const ids = isRecord(value) ? value["conversations"] : undefined;
    const truncated = isRecord(value) ? value["truncated"] : undefined;
    if (
      !isRecord(value) ||
      value["type"] !== "conversations" ||
      !Array.isArray(ids) ||
      !ids.every((id: unknown): id is number => typeof id === "number") ||
      typeof truncated !== "boolean"
    ) {
      throw new Error(`not a listing: ${JSON.stringify(value)}`);
    }
    return { type: "conversations", conversations: ids, truncated };
  };

  /**
   * One `list` frame's reply as the daemon wrote it, before any parser: the keys a
   * listing carries on the wire are what an older client reads (DEC-007).
   */
  const wireList = async (): Promise<JsonRecord> => {
    const client = await lineClient<unknown>(socketPath, (value) => value);
    clients.push(client);
    client.send({ type: "list" });
    const reply = await client.next(() => true);
    await client.closed();
    if (!isRecord(reply) || reply["type"] !== "conversations") {
      throw new Error(`not a listing: ${JSON.stringify(reply)}`);
    }
    return reply;
  };

  /** One topic as a `topics` reply shows it, strictly. */
  const topicSummary = (value: unknown): TopicSummary => {
    const name = isRecord(value) ? value["name"] : undefined;
    const cwd = isRecord(value) ? value["cwd"] : undefined;
    if (typeof name !== "string" || (cwd !== undefined && typeof cwd !== "string")) {
      throw new Error(`not a topic: ${JSON.stringify(value)}`);
    }
    return cwd === undefined ? { name } : { name, cwd };
  };

  /** The `topics` reply, strictly: its records and the profile their `cwd`s live in. */
  const topicsFrame = (value: unknown): TopicsMessage => {
    const profile = isRecord(value) ? value["profile"] : undefined;
    const topics = isRecord(value) ? value["topics"] : undefined;
    if (
      !isRecord(value) ||
      value["type"] !== "topics" ||
      (profile !== "host" && profile !== "room") ||
      !Array.isArray(topics)
    ) {
      throw new Error(`not a topics reply: ${JSON.stringify(value)}`);
    }
    return { type: "topics", profile, topics: topics.map(topicSummary) };
  };

  /** Anything the daemon sends on a first-line connection: its reply, or a `Printable`. */
  type Frame = Printable | ConversationsMessage | TopicsMessage;

  const isListing = (frame: Frame): frame is ConversationsMessage => frame.type === "conversations";

  const isTopics = (frame: Frame): frame is TopicsMessage => frame.type === "topics";

  const isError = (frame: Frame): frame is EventOf<"error"> => frame.type === "error";

  const toFrame = (value: unknown): Frame => {
    if (isRecord(value) && value["type"] === "conversations") {
      return listingFrame(value);
    }
    return isRecord(value) && value["type"] === "topics" ? topicsFrame(value) : toPrintable(value);
  };

  /** A client that understands the first-line replies; every one is closed by the afterEach. */
  const listClient = async (): Promise<LineClient<Frame>> => {
    const client = await lineClient(socketPath, toFrame);
    clients.push(client);
    return client;
  };

  /**
   * One first-line frame on a fresh connection, read through `read`: its single
   * reply, then a clean close. A second frame, or a hang-up, fails here (EX-1).
   */
  const replyTo = async <T extends Frame>(
    frame: unknown,
    read: (value: Frame) => value is T,
  ): Promise<T> => {
    const client = await listClient();
    client.send(frame);
    const reply = await client.next(read);
    await client.closed();
    expect(client.received()).toHaveLength(1);
    return reply;
  };

  /** Attach with `frame`, answering the conversation the daemon announced. */
  const attachWith = async (frame: unknown): Promise<number> => {
    const client = await lineClient(socketPath, toPrintable);
    clients.push(client);
    client.send(frame);
    const attached = await client.next(isType("attached"));
    await client.next(isType("snapshot"));
    return attached.conversation;
  };

  /** The cwd a conversation's own agent carries: the one D1 says is never rewritten. */
  const cwdOf = async (id: number): Promise<string | undefined> => {
    if (!isConversationKey(id)) {
      throw new Error(`no conversation ${String(id)}`);
    }
    const conversation = await test.harness.conversation(id, context);
    if (conversation === undefined) {
      throw new Error(`no conversation ${String(id)}`);
    }
    return (await conversation.agent(context)).cwd;
  };

  /**
   * `client` leaves and resolves once the daemon's own socket has seen the hang-up
   * (a receipt, not a timer). Armed before the close, so this is its own close.
   */
  const departReceipt = async (
    client: LineClient<Printable>,
    serverSocket: Socket,
  ): Promise<void> => {
    const closed = once(serverSocket, "close");
    client.close();
    await closed;
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
    await departReceipt(client, serverSocket);
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
      await departReceipt(client, serverSocket);
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

  /** The visible text of `message`: string content, or its text blocks joined. */
  const textOf = (message: Message): string =>
    typeof message.content === "string"
      ? message.content
      : message.content.map((block) => (block.type === "text" ? block.text : "")).join("");

  /** The visible text of `entry`'s one message; `""` for an entry with none. */
  const entryText = (entry: EntryRecord): string => {
    const message = entry.model?.[0];
    return message === undefined ? "" : textOf(message);
  };

  /** The last user message's text: which conversation called the faux factory. */
  const lastUserText = (messages: readonly Message[]): string => {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message?.role === "user") {
        return textOf(message);
      }
    }
    return "";
  };

  /** Every message entry `conversation` holds, joined. */
  const entriesText = async (conversation: Conversation): Promise<string> => {
    const page = await conversation.entries({}, 50, undefined, context);
    return page.items.map(entryText).join("\n");
  };

  /**
   * A faux factory that reads which conversation called it from the transcript it
   * receives: the `alpha` turn is held until `release`, every other turn answers.
   */
  const heldTurn =
    (entered: () => void, release: Promise<undefined>): FauxResponseFactory =>
    async (transcript) => {
      const text = lastUserText(transcript.messages);
      if (text !== "alpha") {
        return fauxAssistantMessage([fauxText(`${text} answer`)]);
      }
      entered();
      await release;
      return fauxAssistantMessage([fauxText("alpha answer")]);
    };

  /** Every entry `client` was sent as a completed message, joined. */
  const streamText = (client: LineClient<Printable>): string =>
    client
      .received()
      .filter(isType("message_end"))
      .map((event) => entryText(event.entry))
      .join("\n");

  /** A client bound with `frame`, once its attached reply and snapshot have arrived. */
  const attachTo = async (
    frame: unknown,
  ): Promise<{
    client: LineClient<Printable>;
    attached: EventOf<"attached">;
    snapshot: EventOf<"snapshot">;
  }> => {
    const client = await lineClient(socketPath, toPrintable);
    clients.push(client);
    client.send(frame);
    const attached = await client.next(isType("attached"));
    const snapshot = await client.next(isType("snapshot"));
    return { client, attached, snapshot };
  };

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

  it("a connection that never sends is never bound and receives nothing (DEC-108)", async () => {
    await start();
    const passive = await lineClient(socketPath, toPrintable);
    clients.push(passive);
    // The control attaches and gets its snapshot: the session is ready, so silence means something.
    const control = await attach();
    expect(passive.received()).toEqual([]);
    await settle(control);
    expect(watched.streams).toHaveLength(1);
    expect(await conversationIds()).toEqual([test.root.id]);
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

  it.each([
    { type: "attach", conversation: 1, new: true },
    { type: "attach", cwd: "/x" },
    { type: "attach", new: 1 },
    { type: "attach", new: "true" },
    { type: "attach", conversation: 0 },
    { type: "attach", conversation: "3" },
    { type: "attach", conversation: 1.5 },
    { type: "attach", new: true, cwd: 3 },
    { type: "attach", extra: 1 },
  ])("refuses the attach shape %j, creating nothing (V-1)", async (frame) => {
    await start();
    const client = await lineClient(socketPath, toPrintable);
    clients.push(client);
    await client.write(encodeLine(frame) + encodeLine({ type: "input", content: "dropped" }));
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
    const owned = await createTaskOwned(test);
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
    const api = conversations(test, DEFAULTS, "host", FAUX_CATALOG);
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
    const other = await conversations(test, DEFAULTS, "host", FAUX_CATALOG).open({ kind: "new" });
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

  it("answers a list frame with one page of ids, then closes cleanly (DEC-007)", async () => {
    await start();
    const api = conversations(test, DEFAULTS, "host", FAUX_CATALOG);
    const first = await api.open({ kind: "new" });
    const second = await api.open({ kind: "new" });
    const client = await listClient();
    client.send({ type: "list" });
    const reply = await client.next(isListing);
    await client.closed();
    // Newest first, and the whole reply is one frame: no snapshot, no error, no notice.
    expect(reply.conversations).toEqual([second.id, first.id, test.root.id]);
    expect(reply.truncated).toBe(false);
    expect(client.received()).toHaveLength(1);
    // A listing binds nothing and creates nothing.
    expect(await conversationIds()).toEqual([test.root.id, first.id, second.id]);
  });

  it("refuses every first-line frame on a bound connection, writing nothing (EX-5, F-11)", async () => {
    await start();
    test.faux.setResponses([fauxAssistantMessage([fauxText("hello")])]);
    const client = await attach();
    // Well-formed and malformed alike: the rule is about the connection, not the frame.
    const later = [
      { type: "list" },
      { type: "list", page: 2 },
      { type: "topic", name: "work", cwd: "/w" },
      { type: "attach", topic: "work" },
    ];
    for (const frame of later) {
      client.send(frame);
      const error = await client.next(isType("error"));
      expect(error.message).toBe("already attached to conversation 1");
    }
    // `topic` is the one first-line frame that writes: refused, it wrote no topic.
    expect((await indexOf(test.harness)).topics).toEqual({});
    // The control: the binding survived, so an input still lands on it.
    client.send({ type: "input", content: "hi" });
    await client.next(isType("run_end"));
  });

  it("answers a topic listing for a topic nobody wrote with one error, then closes (EX-5)", async () => {
    await start();
    const error = await replyTo({ type: "list", topic: "work" }, isError);
    expect(error.message).toBe("no topic work");
    expect(await conversationIds()).toEqual([test.root.id]);
  });

  it("refuses a list key this daemon does not know, naming the frame (EX-5)", async () => {
    await start();
    expect((await replyTo({ type: "list", page: 2 }, isError)).message).toBe(
      "list: unknown key page",
    );
  });

  it("passes a listed thread's mark through, and marks nothing when no id is a thread (EX-1)", async () => {
    await start();
    const api = conversations(test, DEFAULTS, "host", FAUX_CATALOG);
    const operator = await api.open({ kind: "new" });
    // A store with no thread: the reply has no `marks` key at all.
    expect(Object.hasOwn(await wireList(), "marks")).toBe(false);
    const forked = await forkConversation(test.harness, operator);
    expect((await wireList())["marks"]).toEqual({ [String(forked.id)]: { forkOf: operator.id } });
  });

  it("keeps the shipped list reply's shape, so SL-002's clients still read it (EX-4)", async () => {
    await start();
    const reply = await replyTo({ type: "list" }, isListing);
    expect(Object.keys(reply).sort()).toEqual(["conversations", "truncated", "type"]);
    expect(reply.conversations).toEqual([test.root.id]);
  });

  it("binds a topic's latest conversation, creating only with `new` or in an empty topic (EX-3)", async () => {
    await start();
    await replyTo({ type: "topic", name: "work", cwd: "/A" }, isTopics);
    // An empty topic gets its first conversation, in the topic's directory.
    const first = await attachWith({ type: "attach", topic: "work" });
    expect(await cwdOf(first)).toBe("/A");
    // Without `new` the same conversation binds; `new` creates the next one.
    expect(await attachWith({ type: "attach", topic: "work" })).toBe(first);
    const second = await attachWith({ type: "attach", topic: "work", new: true });
    expect(second).toBeGreaterThan(first);
    expect(await attachWith({ type: "attach", topic: "work" })).toBe(second);
    expect(await conversationIds()).toEqual([test.root.id, first, second]);
  });

  it("binds root for a plain attach, and default's latest for the name (EX-3)", async () => {
    await start();
    expect(await attachWith({ type: "attach" })).toBe(test.root.id);
    expect(await attachWith({ type: "attach", topic: "default" })).toBe(test.root.id);
    const created = await attachWith({ type: "attach", topic: "default", new: true });
    expect(await attachWith({ type: "attach", topic: "default" })).toBe(created);
    // A plain attach still binds root, whatever joined default.
    expect(await attachWith({ type: "attach" })).toBe(test.root.id);
  });

  it("copies a topic's directory once, never rewriting the conversation (EX-2, D1)", async () => {
    await start();
    await replyTo({ type: "topic", name: "work", cwd: "/A" }, isTopics);
    const first = await attachWith({ type: "attach", topic: "work" });
    await replyTo({ type: "topic", name: "work", cwd: "/B" }, isTopics);
    const second = await attachWith({ type: "attach", topic: "work", new: true });
    expect(await cwdOf(first)).toBe("/A");
    expect(await cwdOf(second)).toBe("/B");
  });

  it.each([
    [
      { type: "attach", topic: "work", conversation: 1 },
      "attach: conversation and topic are exclusive",
    ],
    [{ type: "attach", topic: "work", cwd: "/tmp" }, "attach: cwd needs new"],
    [{ type: "attach", topic: "Work" }, `attach: ${NAME_RULE}`],
    [{ type: "attach", topic: "nope" }, "no topic nope"],
    [{ type: "list", topic: "work", topics: true }, "list: topic and topics are exclusive"],
    [{ type: "list", topics: false }, "list: topics must be true"],
    [{ type: "list", topic: "Work" }, `list: ${NAME_RULE}`],
    [{ type: "list", topic: "nope" }, "no topic nope"],
    [{ type: "topic", name: "default" }, "topic: default is reserved"],
    [{ type: "topic", name: "work", cwd: true }, "topic: cwd must be a string or null"],
    [{ type: "topic", name: "Work" }, `topic: ${NAME_RULE}`],
  ])("answers %j with one refusal, then closes (EX-1)", async (frame, refusal) => {
    await start();
    expect((await replyTo(frame, isError)).message).toBe(refusal);
    // A refusal creates nothing and binds nothing.
    expect(await conversationIds()).toEqual([test.root.id]);
  });

  it("answers a topic listing with that topic's ids, newest first (EX-4)", async () => {
    await start();
    await replyTo({ type: "topic", name: "work" }, isTopics);
    const first = await attachWith({ type: "attach", topic: "work" });
    const second = await attachWith({ type: "attach", topic: "work", new: true });
    const outside = await attachWith({ type: "attach", new: true });
    expect(outside).toBeGreaterThan(second);
    expect(await replyTo({ type: "list", topic: "work" }, isListing)).toEqual({
      type: "conversations",
      conversations: [second, first],
      truncated: false,
    });
  });

  it(`cuts a topic listing at LIST_PAGE (${String(LIST_PAGE)}) and says so (EX-4)`, async () => {
    await start();
    await replyTo({ type: "topic", name: "many" }, isTopics);
    for (let made = 0; made < LIST_PAGE + 1; made += 1) {
      await test.harness.createConversation(
        { ownership: { kind: "ownerless" }, init: toolsetInit("room", "many") },
        context,
      );
    }
    const page = await replyTo({ type: "list", topic: "many" }, isListing);
    expect(page.conversations).toHaveLength(LIST_PAGE);
    expect(page.truncated).toBe(true);
  });

  it("answers a topics listing with default first and the daemon's profile (EX-4)", async () => {
    await start();
    await replyTo({ type: "topic", name: "work", cwd: "/w" }, isTopics);
    await replyTo({ type: "topic", name: "bare" }, isTopics);
    expect(await replyTo({ type: "list", topics: true }, isTopics)).toEqual({
      type: "topics",
      profile: "host",
      topics: [{ name: "default" }, { name: "bare" }, { name: "work", cwd: "/w" }],
    });
  });

  it("names the profile its own conversations were built for, room here (EX-4)", async () => {
    test = await openTestHarness([]);
    daemon = await serve({
      socketPath,
      conversations: Promise.resolve(conversations(test, DEFAULTS, "room", FAUX_CATALOG)),
      beforeInput: noGate,
      orientation: noOrientation,
    });
    expect((await replyTo({ type: "list", topics: true }, isTopics)).profile).toBe("room");
  });

  it("creates a topic idempotently, sets its directory, and clears it (EX-5)", async () => {
    await start();
    const bare: TopicsMessage = {
      type: "topics",
      profile: "host",
      topics: [{ name: "work" }],
    };
    expect(await replyTo({ type: "topic", name: "work" }, isTopics)).toEqual(bare);
    expect(await replyTo({ type: "topic", name: "work" }, isTopics)).toEqual(bare);
    const set: TopicsMessage = { ...bare, topics: [{ name: "work", cwd: "/A" }] };
    expect(await replyTo({ type: "topic", name: "work", cwd: "/A" }, isTopics)).toEqual(set);
    // Absent `cwd` leaves what is there, so a write is never a silent clear.
    expect(await replyTo({ type: "topic", name: "work" }, isTopics)).toEqual(set);
    expect(await replyTo({ type: "topic", name: "work", cwd: null }, isTopics)).toEqual(bare);
    // A topic write is a commit on the index only: no conversation, no binding.
    expect(await conversationIds()).toEqual([test.root.id]);
  });

  it("a failed listing answers one error and closes", async () => {
    test = await openTestHarness([]);
    const api = conversations(test, DEFAULTS, "host", FAUX_CATALOG);
    const failing = {
      ...api,
      list: (): Promise<never> => Promise.reject(new Error("listing failed")),
    };
    daemon = await serve({
      socketPath,
      conversations: Promise.resolve(failing),
      beforeInput: noGate,
      orientation: noOrientation,
    });
    const client = await lineClient(socketPath, toPrintable);
    clients.push(client);
    client.send({ type: "list" });
    const error = await client.next(isType("error"));
    expect(error.message).toBe("listing failed");
    await client.closed();
    expect(await conversationIds()).toEqual([test.root.id]);
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

  it("submits the bound conversation's orientation as an input, after beforeInput", async () => {
    let gated = 0;
    const oriented: ConversationId[] = [];
    await start(
      openTestHarness([]),
      () => {
        gated++;
        return Promise.resolve();
      },
      (conversation) => {
        oriented.push(conversation);
        return Promise.resolve("<orient>fresh</orient>");
      },
    );
    test.faux.setResponses([fauxAssistantMessage([fauxText("oriented")])]);
    const client = await attach();
    client.send({ type: "orient" });
    await client.next(isType("run_end"));
    expect(oriented).toEqual([test.root.id]);
    expect(gated).toBe(1);
    const page = await test.root.entries({}, 50, undefined, context);
    const users = page.items.filter((entry) => entry.kind === "pi.user");
    expect(JSON.stringify(users)).toContain("<orient>fresh</orient>");
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

  it("overlap: concurrent conversations stay isolated (V-4)", async () => {
    await start();
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    // Chosen from each call's own transcript, never from call order.
    test.faux.setResponses(
      Array.from({ length: 4 }, () =>
        heldTurn(() => {
          entered.resolve(undefined);
        }, release.promise),
      ),
    );
    const a = await attach();
    a.send({ type: "input", content: "alpha" });
    await entered.promise; // A is mid-turn: its factory is held.
    const b = await attachTo({ type: "attach", new: true, cwd: "/bravo" });
    b.client.send({ type: "input", content: "bravo" });
    await b.client.next(isType("run_end"));
    // B completed while A was still held: the two conversations overlap.
    expect(runEnds(a)).toBe(0);
    expect(runEnds(b.client)).toBe(1);
    release.resolve(undefined);
    await a.next(isType("run_end"));
    // Each stream holds only its own conversation's input and answer.
    expect(streamText(a)).toContain("alpha answer");
    expect(streamText(a)).not.toContain("bravo answer");
    expect(streamText(b.client)).toContain("bravo answer");
    expect(streamText(b.client)).not.toContain("alpha answer");
    // Root is A; the conversation B attached to is read by the id it was given.
    expect(await entriesText(test.root)).toContain("alpha answer");
    expect(await entriesText(test.root)).not.toContain("bravo answer");
    const created = await conversations(test, DEFAULTS, "host", FAUX_CATALOG).open({
      kind: "existing",
      id: b.attached.conversation,
    });
    expect(await entriesText(created)).toContain("bravo answer");
    expect(await entriesText(created)).not.toContain("alpha answer");
  });

  it("aborts a created A while overlapping root B, leaving B intact and A aborted (V-4)", async () => {
    test = await openTestHarness([]);
    const api = conversations(test, DEFAULTS, "host", FAUX_CATALOG);
    // The daemon opens A through this seam, so the spy below holds the very instance
    // it binds and aborts; only the one created target resolves `opened`.
    const opened = Promise.withResolvers<Conversation>();
    const seam: Conversations = {
      root: api.root,
      profile: api.profile,
      open: async (target) => {
        const conversation = await api.open(target);
        if (target.kind === "new") {
          opened.resolve(conversation);
        }
        return conversation;
      },
      watch: (conversation) => api.watch(conversation),
      list: (query) => api.list(query),
      topics: () => api.topics(),
      setTopic: (topic) => api.setTopic(topic),
    };
    daemon = await serve({
      socketPath,
      conversations: Promise.resolve(seam),
      beforeInput: noGate,
      orientation: noOrientation,
    });
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    test.faux.setResponses(
      Array.from({ length: 4 }, () =>
        heldTurn(() => {
          entered.resolve(undefined);
        }, release.promise),
      ),
    );
    const a = await attachTo({ type: "attach", new: true, cwd: "/alpha" });
    a.client.send({ type: "input", content: "alpha", requestId: "alpha-turn" });
    await entered.promise; // A is mid-turn: its factory is held.
    // B is root, attached and idle before the abort, so a mis-scoped abort would hit it.
    const b = await attach();
    const bound = await opened.promise;
    expect(bound.id).not.toBe(test.root.id); // A is created; root is B.
    expect(a.attached.conversation).toBe(bound.id); // The spy holds the bound one.
    // A receipt that the daemon called abort on the bound conversation; it does not
    // await abort's resolution.
    const abortEntered = Promise.withResolvers<undefined>();
    const originalAbort = bound.abort.bind(bound);
    const spy = vi.spyOn(bound, "abort").mockImplementation((ctx, options) => {
      abortEntered.resolve(undefined);
      return originalAbort(ctx, options);
    });
    try {
      await a.client.write(encodeLine({ type: "abort" }));
      await abortEntered.promise; // Abort waits for A's scope, which the barrier holds.
      b.send({ type: "input", content: "bravo" });
      await b.next(isType("run_end"));
      // B ran to its end while A was held: abort on A did not serialise B.
      expect(runEnds(b)).toBe(1);
      expect(runEnds(a.client)).toBe(0);
      release.resolve(undefined);
      await a.client.next(isType("run_end"));
      // A's held answer was never delivered; pi settled A's input as aborted.
      expect(streamText(a.client)).not.toContain("alpha answer");
      const entries = await bound.entries({}, 50, undefined, context);
      // Any assistant entry A did commit carries the abort; no partial lands here.
      const assistants = entries.items
        .filter((entry) => entry.kind === "pi.assistant")
        .flatMap((entry) => [...(entry.model ?? [])])
        .filter((message) => message.role === "assistant");
      expect(assistants.every((message) => message.stopReason === "aborted")).toBe(true);
      expect(entries.items.some((entry) => entry.kind === "pi.user")).toBe(true);
      expect(await entriesText(bound)).not.toContain("alpha answer");
      const submission = await test.harness.commit(
        (tx) => tx.submissionByRequest(bound.id, "alpha-turn"),
        context,
      );
      expect(submission?.status).toBe("unanswered");
      const reason = submission?.status === "unanswered" ? submission.reason : undefined;
      expect(reason).toBe("aborted");
      // B's run and transcript are untouched by A's abort.
      expect(runEnds(b)).toBe(1);
      expect(streamText(b)).toContain("bravo answer");
      expect(streamText(b)).not.toContain("alpha answer");
      expect(await entriesText(test.root)).not.toContain("alpha");
    } finally {
      release.resolve(undefined);
      spy.mockRestore();
    }
  });

  it("reattach: A by id streams only A's history (V-4)", async () => {
    await start();
    // Every answer echoes the transcript's last user text: chosen per call, not per order.
    const answer: FauxResponseFactory = (transcript) =>
      fauxAssistantMessage([fauxText(`${lastUserText(transcript.messages)} answer`)]);
    test.faux.setResponses(Array.from({ length: 6 }, () => answer));
    const a = await attach();
    a.send({ type: "input", content: "alpha" });
    await a.next(isType("run_end"));
    const b = await attachTo({ type: "attach", new: true, cwd: "/bravo" });
    b.client.send({ type: "input", content: "bravo" });
    await b.client.next(isType("run_end"));
    const again = await attachTo({ type: "attach", conversation: test.root.id });
    const history = again.snapshot.entries.map(entryText).join("\n");
    expect(history).toContain("alpha answer");
    expect(history).not.toContain("bravo");
    // The reattached client's next run lands on A, and B hears none of it.
    again.client.send({ type: "input", content: "alpha-two" });
    await again.client.next(isType("run_end"));
    expect(runEnds(b.client)).toBe(1);
    expect(streamText(b.client)).not.toContain("alpha-two");
    expect(await entriesText(test.root)).toContain("alpha-two answer");
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
