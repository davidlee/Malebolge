// The daemon's conversation resolver: root, the conversation a wire id names,
// a new one carrying the daemon's defaults, and the stream that watches one.
// The reopen case proves a created conversation is never reconfigured.

import { join } from "node:path";
import { type Conversation, defineTask, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { afterEach, describe, expect, it } from "vitest";
import { context } from "../src/context.ts";
import {
  type ConversationDefaults,
  conversations,
  isConversationKey,
  LIST_PAGE,
} from "../src/conversations.ts";
import { registryOf } from "../src/registry.ts";
import { openSession, type Session } from "../src/session.ts";
import { indexConversation, IndexDocument } from "../src/topics.ts";
import { tempDir } from "./fixtures.ts";
import {
  callThenAnswer,
  FAUX_MODEL,
  fauxModels,
  type FauxHarnessOptions,
  indexOf,
  openFauxHarness,
  textOf,
  toolResults,
  type TestHarness,
} from "./harness-fixture.ts";

const DEFAULTS: ConversationDefaults = { model: FAUX_MODEL, cwd: "/daemon-default" };

const nodeEnv = ({ cwd }: { cwd?: string }): NodeExecutionEnv =>
  new NodeExecutionEnv({ cwd: cwd ?? process.cwd() });

/** A task whose only phase waits: a stub, never run on a passive harness. */
const stubTask = defineTask({
  name: "stub",
  version: 1,
  initial: () => ({ phase: "waiting" as const }),
  phases: { waiting: () => Promise.resolve() },
  abort: () => Promise.resolve(),
});

describe("conversations", () => {
  let test: TestHarness | undefined;

  afterEach(async () => {
    if (test !== undefined) {
      await test.harness.close(context);
    }
    test = undefined;
  });

  /**
   * A passive harness on memory storage: it only reads and creates, so nothing is
   * scheduled. The index's hook is installed as `openSession` installs it, so root
   * is filed in `default` and every creation is indexed.
   */
  const passive = async (options: FauxHarnessOptions = {}): Promise<TestHarness> => {
    test = await openFauxHarness(new MemoryStorage(), {
      resume: false,
      conversationCreated: indexConversation,
      ...options,
    });
    return test;
  };

  it("opens root", async () => {
    const session = await passive();
    expect(await conversations(session, DEFAULTS, "host").open({ kind: "root" })).toBe(
      session.root,
    );
  });

  it("opens an existing conversation by the id a wire frame names", async () => {
    const session = await passive();
    const opened = await conversations(session, DEFAULTS, "host").open({
      kind: "existing",
      id: session.root.id,
    });
    expect(opened.id).toBe(session.root.id);
  });

  it("refuses an unknown id", async () => {
    const session = await passive();
    const open = conversations(session, DEFAULTS, "host").open({ kind: "existing", id: 999999 });
    await expect(open).rejects.toThrow("no conversation 999999");
  });

  it("refuses an id no wire parser would accept", async () => {
    const session = await passive();
    const open = conversations(session, DEFAULTS, "host").open({ kind: "existing", id: 0 });
    await expect(open).rejects.toThrow("no conversation 0");
    expect(isConversationKey(0)).toBe(false);
    expect(isConversationKey(1)).toBe(true);
  });

  it("refuses a conversation that belongs to a task", async () => {
    const session = await passive();
    const id = await session.harness.commit(async (tx) => {
      const taskId = await tx.createTask(
        stubTask,
        {},
        { ownership: { kind: "conversation" }, conversationId: session.root.id },
      );
      return (await tx.createConversation({ ownership: { kind: "task", taskId } })).id;
    }, context);
    const open = conversations(session, DEFAULTS, "host").open({ kind: "existing", id });
    await expect(open).rejects.toThrow(`conversation ${String(id)} belongs to a task`);
  });

  it("creates a conversation with the daemon's defaults", async () => {
    const session = await passive();
    const created = await conversations(session, DEFAULTS, "host").open({ kind: "new" });
    const agent = await created.agent(context);
    expect(agent.model).toEqual(FAUX_MODEL);
    expect(agent.cwd).toBe("/daemon-default");
  });

  it("creates a conversation in its own cwd, the empty string included", async () => {
    const session = await passive();
    const api = conversations(session, DEFAULTS, "host");
    expect((await (await api.open({ kind: "new", cwd: "/own" })).agent(context)).cwd).toBe("/own");
    expect((await (await api.open({ kind: "new", cwd: "" })).agent(context)).cwd).toBe("");
  });

  it("runs a created conversation's tools in its own cwd, not the daemon's default", async () => {
    const tmp = await tempDir();
    try {
      const asked: (string | undefined)[] = [];
      const session = await passive({
        extensions: [CodingTools],
        env: (state) => {
          asked.push(state.cwd);
          return nodeEnv(state);
        },
      });
      session.faux.setResponses(callThenAnswer("bash", { command: "pwd" }, "done"));
      const created = await conversations(session, DEFAULTS, "host").open({
        kind: "new",
        cwd: tmp.dir,
      });
      await (await created.submit({ type: "input", content: "go" }, context)).wait(context);
      const [result] = await toolResults(session.harness, created);
      const text = result === undefined ? "" : textOf(result);
      expect(asked).toContain(tmp.dir);
      expect(asked).not.toContain(DEFAULTS.cwd);
      expect(text).toContain(tmp.dir);
      expect(text).not.toContain(DEFAULTS.cwd);
    } finally {
      await tmp.cleanup();
    }
  });

  it("leaves a created conversation's agent unchanged when the session reopens", async () => {
    const tmp = await tempDir();
    const path = join(tmp.dir, "conversations.sqlite");
    const own = join(tmp.dir, "own");
    const changedCwd = join(tmp.dir, "changed");
    const changedModel = { provider: "faux", modelId: "later" } as const;
    let session: Session | undefined;
    const close = async (): Promise<void> => {
      if (session !== undefined) {
        await session.harness.close(context);
      }
      session = undefined;
    };
    try {
      const first = await openSession(await openNodeSqliteStorage(path), {
        models: fauxModels().models,
        registry: registryOf([]),
        agent: { model: FAUX_MODEL, cwd: tmp.dir },
        env: nodeEnv,
      });
      session = first;
      const created = await conversations(first, { model: FAUX_MODEL, cwd: tmp.dir }, "host").open({
        kind: "new",
        cwd: own,
      });
      await close();

      const second = await openSession(await openNodeSqliteStorage(path), {
        models: fauxModels().models,
        registry: registryOf([]),
        agent: { model: changedModel, cwd: changedCwd },
        env: nodeEnv,
      });
      session = second;
      const reopened = await conversations(
        second,
        { model: changedModel, cwd: changedCwd },
        "host",
      ).open({ kind: "existing", id: created.id });
      const agent = await reopened.agent(context);
      expect(agent.model).toEqual(FAUX_MODEL);
      expect(agent.cwd).toBe(own);
    } finally {
      await close();
      await tmp.cleanup();
    }
  });

  it("watches the conversation it resolved, not root", async () => {
    const session = await passive();
    const api = conversations(session, DEFAULTS, "host");
    const created = await api.open({ kind: "new", cwd: "/watch" });
    const stream = await api.watch(created);
    try {
      expect(stream.snapshot.agent.model).toEqual(FAUX_MODEL);
      expect(stream.snapshot.agent.cwd).toBe("/watch");
      expect(stream.snapshot.entries).toEqual([]);
    } finally {
      await stream.stop();
    }
  });

  it("lists root alone in a fresh store", async () => {
    const session = await passive();
    expect(await conversations(session, DEFAULTS, "host").list({ kind: "all" })).toEqual({
      ids: [session.root.id],
      truncated: false,
    });
  });

  it("lists the ownerless conversations newest first", async () => {
    const session = await passive();
    const api = conversations(session, DEFAULTS, "host");
    const first = await api.open({ kind: "new" });
    const second = await api.open({ kind: "new" });
    expect((await api.list({ kind: "all" })).ids).toEqual([second.id, first.id, session.root.id]);
  });

  it("keeps a task-owned conversation out of the listing", async () => {
    const session = await passive();
    const api = conversations(session, DEFAULTS, "host");
    const owned = await session.harness.commit(async (tx) => {
      const taskId = await tx.createTask(
        stubTask,
        {},
        { ownership: { kind: "conversation" }, conversationId: session.root.id },
      );
      return (await tx.createConversation({ ownership: { kind: "task", taskId } })).id;
    }, context);
    const created = await api.open({ kind: "new" });
    const { ids } = await api.list({ kind: "all" });
    expect(ids).toContain(created.id);
    expect(ids).not.toContain(owned);
  });

  it(`stops at LIST_PAGE (${String(LIST_PAGE)}) and reports the cut`, async () => {
    const session = await passive();
    await session.harness.commit(async (tx) => {
      for (let created = 0; created < LIST_PAGE; created += 1) {
        await tx.createConversation({ ownership: { kind: "ownerless" } });
      }
    }, context);
    const page = await conversations(session, DEFAULTS, "host").list({ kind: "all" });
    expect(page.ids).toHaveLength(LIST_PAGE);
    expect(page.truncated).toBe(true);
  });
  it("starts a topic's first conversation in the topic's directory (EX-3, D1)", async () => {
    const session = await passive();
    const api = conversations(session, DEFAULTS, "host");
    await api.setTopic({ name: "work", cwd: "/topic-work" });
    const created = await api.open({ kind: "topic", name: "work", new: false });
    expect((await created.agent(context)).cwd).toBe("/topic-work");
    expect((await indexOf(session.harness)).conversations[String(created.id)]).toEqual({
      topic: "work",
    });
  });

  it("binds a topic's latest conversation, and creates only when asked or empty (EX-3)", async () => {
    const session = await passive();
    const api = conversations(session, DEFAULTS, "host");
    await api.setTopic({ name: "work" });
    const first = await api.open({ kind: "topic", name: "work", new: true });
    expect((await api.open({ kind: "topic", name: "work", new: false })).id).toBe(first.id);
    const second = await api.open({ kind: "topic", name: "work", new: true });
    expect(first.id).toBeLessThan(second.id);
    expect((await api.open({ kind: "topic", name: "work", new: false })).id).toBe(second.id);
  });

  it("starts one conversation when two attaches race on an empty topic", async () => {
    const session = await passive();
    const api = conversations(session, DEFAULTS, "host");
    await api.setTopic({ name: "work" });
    const open = (): Promise<Conversation> => api.open({ kind: "topic", name: "work", new: false });
    const [one, two] = await Promise.all([open(), open()]);
    expect(one.id).toBe(two.id);
    expect((await api.list({ kind: "topic", name: "work" })).ids).toEqual([one.id]);
  });

  it("refuses a topic whose latest entry is not a conversation key, creating nothing", async () => {
    const session = await passive();
    const api = conversations(session, DEFAULTS, "host");
    await api.setTopic({ name: "work" });
    // A damaged index: an entry no conversation id could ever be.
    await session.harness.commit(async (tx) => {
      const index = await tx.doc(IndexDocument);
      index.conversations["0"] = { topic: "work" };
    }, context);
    await expect(api.open({ kind: "topic", name: "work", new: false })).rejects.toThrow(
      "no conversation 0",
    );
    expect(Object.keys((await indexOf(session.harness)).conversations).sort()).toEqual([
      "0",
      String(session.root.id),
    ]);
  });

  // `constructor` is the one valid name an object literal already answers to.
  it.each(["nope", "constructor"])(
    "refuses a topic nobody wrote, creating neither topic nor conversation: %s (DEC-016)",
    async (name) => {
      const session = await passive();
      const api = conversations(session, DEFAULTS, "host");
      for (const fresh of [false, true]) {
        await expect(api.open({ kind: "topic", name, new: fresh })).rejects.toThrow(
          `no topic ${name}`,
        );
      }
      await expect(api.list({ kind: "topic", name })).rejects.toThrow(`no topic ${name}`);
      const index = await indexOf(session.harness);
      expect(index.topics).toEqual({});
      expect(Object.keys(index.conversations)).toEqual([String(session.root.id)]);
    },
  );

  it("writes, lists and attaches a topic named like an object's own key", async () => {
    const session = await passive();
    const api = conversations(session, DEFAULTS, "host");
    expect(await api.setTopic({ name: "constructor", cwd: "/c" })).toEqual({
      name: "constructor",
      cwd: "/c",
    });
    const created = await api.open({ kind: "topic", name: "constructor", new: false });
    expect((await created.agent(context)).cwd).toBe("/c");
    expect(await api.topics()).toEqual([{ name: "default" }, { name: "constructor", cwd: "/c" }]);
  });

  it("keeps an existing conversation's directory when the topic's changes (D1, EX-2)", async () => {
    const session = await passive();
    const api = conversations(session, DEFAULTS, "host");
    await api.setTopic({ name: "work", cwd: "/a" });
    const first = await api.open({ kind: "topic", name: "work", new: false });
    expect(await api.setTopic({ name: "work", cwd: "/b" })).toEqual({ name: "work", cwd: "/b" });
    // D1: the topic's directory was read once, at creation, and is never rewritten.
    expect((await first.agent(context)).cwd).toBe("/a");
    const second = await api.open({ kind: "topic", name: "work", new: true });
    expect((await second.agent(context)).cwd).toBe("/b");
    expect((await indexOf(session.harness)).conversations[String(first.id)]?.topic).toBe("work");
  });

  it("takes the client's cwd, then the topic's, then the daemon's (EX-2)", async () => {
    const session = await passive();
    const api = conversations(session, DEFAULTS, "host");
    await api.setTopic({ name: "bare" });
    expect(
      (await (await api.open({ kind: "topic", name: "bare", new: true })).agent(context)).cwd,
    ).toBe(DEFAULTS.cwd);
    await api.setTopic({ name: "own", cwd: "/topic-cwd" });
    const topicCwd = await api.open({ kind: "topic", name: "own", new: false });
    expect((await topicCwd.agent(context)).cwd).toBe("/topic-cwd");
    const asked = await api.open({ kind: "topic", name: "own", new: true, cwd: "/client-cwd" });
    // The client's directory wins for its own conversation; the topic keeps its own.
    expect((await asked.agent(context)).cwd).toBe("/client-cwd");
    expect((await indexOf(session.harness)).topics["own"]).toEqual({ cwd: "/topic-cwd" });
  });

  it("binds default's latest conversation, which is root until another joins (EX-3)", async () => {
    const session = await passive();
    const api = conversations(session, DEFAULTS, "host");
    expect((await api.open({ kind: "topic", name: "default", new: false })).id).toBe(
      session.root.id,
    );
    const created = await api.open({ kind: "topic", name: "default", new: true });
    expect((await created.agent(context)).cwd).toBe(DEFAULTS.cwd);
    expect((await api.open({ kind: "topic", name: "default", new: false })).id).toBe(created.id);
  });

  it("creates a topic with no directory, then leaves it unchanged (EX-5)", async () => {
    const session = await passive();
    const api = conversations(session, DEFAULTS, "host");
    expect(await api.setTopic({ name: "bare" })).toEqual({ name: "bare" });
    await api.setTopic({ name: "bare", cwd: "/ignored" });
    // Absent `cwd` leaves the record alone, so the write above is the one that stands.
    expect(await api.setTopic({ name: "bare" })).toEqual({ name: "bare", cwd: "/ignored" });
    expect((await indexOf(session.harness)).topics).toEqual({ bare: { cwd: "/ignored" } });
  });

  it("sets and clears a topic's directory, returning the written record (EX-5)", async () => {
    const session = await passive();
    const api = conversations(session, DEFAULTS, "host");
    expect(await api.setTopic({ name: "work", cwd: "/w" })).toEqual({ name: "work", cwd: "/w" });
    expect(await api.setTopic({ name: "work", cwd: null })).toEqual({ name: "work" });
    expect((await indexOf(session.harness)).topics).toEqual({ work: {} });
    expect(await api.setTopic({ name: "work", cwd: "/again" })).toEqual({
      name: "work",
      cwd: "/again",
    });
  });

  it("lists one topic's ids newest first, leaving other topics out (EX-4)", async () => {
    const session = await passive();
    const api = conversations(session, DEFAULTS, "host");
    await api.setTopic({ name: "work" });
    const first = await api.open({ kind: "topic", name: "work", new: true });
    const elsewhere = await api.open({ kind: "new" });
    const second = await api.open({ kind: "topic", name: "work", new: true });
    expect(await api.list({ kind: "topic", name: "work" })).toEqual({
      ids: [second.id, first.id],
      truncated: false,
    });
    // The conversation outside the topic is not in the page, whatever its id.
    expect((await api.list({ kind: "topic", name: "work" })).ids).not.toContain(elsewhere.id);
  });

  it("stops a topic listing at LIST_PAGE and reports the cut (EX-4)", async () => {
    const session = await passive();
    const api = conversations(session, DEFAULTS, "host");
    await api.setTopic({ name: "many" });
    for (let made = 0; made < LIST_PAGE + 1; made += 1) {
      await api.open({ kind: "topic", name: "many", new: true });
    }
    const page = await api.list({ kind: "topic", name: "many" });
    expect(page.ids).toHaveLength(LIST_PAGE);
    expect(page.truncated).toBe(true);
  });

  it("refuses a topic listing for a topic nobody wrote (EX-4)", async () => {
    const session = await passive();
    const listing = conversations(session, DEFAULTS, "host").list({ kind: "topic", name: "nope" });
    await expect(listing).rejects.toThrow("no topic nope");
  });

  it("lists the topics themselves, default first, as plain records (EX-4, EX-8)", async () => {
    const session = await passive();
    const api = conversations(session, DEFAULTS, "host");
    await api.setTopic({ name: "work", cwd: "/w" });
    await api.setTopic({ name: "bare" });
    expect(await api.topics()).toEqual([
      { name: "default" },
      { name: "bare" },
      { name: "work", cwd: "/w" },
    ]);
  });
});
