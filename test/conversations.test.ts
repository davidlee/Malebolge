// The daemon's conversation resolver: root, the conversation a wire id names,
// a new one carrying the daemon's defaults, and the stream that watches one.
// The reopen case proves a created conversation is never reconfigured.

import { join } from "node:path";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import {
  type Conversation,
  type ConversationId,
  type ConversationInit,
  configure,
  defineExtension,
  type Extension,
  MemoryStorage,
  type Registry,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { context } from "../src/context.ts";
import {
  type ConversationDefaults,
  conversations,
  isConversationKey,
  LIST_PAGE,
  toolsetInit,
} from "../src/conversations.ts";
import { registryOf } from "../src/registry.ts";
import { openSession, type Session } from "../src/session.ts";
import { threadsExtension } from "../src/threads/extension.ts";
import {
  indexConversation,
  IndexDocument,
  readIndex,
  storedEntry,
  storedTopic,
  writeTopicRecord,
} from "../src/topics.ts";
import {
  type DaemonToolset,
  PROFILE_TOOLSETS,
  requireSameTalkSet,
  SATAN,
  selectionOf,
  toolsetList,
} from "../src/toolsets.ts";
import { tempDir } from "./fixtures.ts";
import {
  callThenAnswer,
  createConversation,
  createTaskOwned,
  FAUX_MODEL,
  fauxModels,
  type FauxHarnessOptions,
  forkConversation,
  indexOf,
  openFauxHarness,
  startThread,
  textOf,
  toolResults,
  type TestHarness,
  toolsetProbe,
} from "./harness-fixture.ts";
import {
  answeredChild,
  attemptCall,
  CONTEXT,
  conversationOf,
  createIndexedThread,
  INTENT,
  type ThreadWorld,
  threadWorld,
} from "./thread-fixture.ts";
import { WAIT } from "./wake-fixture.ts";

const DEFAULTS: ConversationDefaults = { model: FAUX_MODEL, cwd: "/daemon-default" };

const nodeEnv = ({ cwd }: { cwd?: string }): NodeExecutionEnv =>
  new NodeExecutionEnv({ cwd: cwd ?? process.cwd() });

/** Name-only extension stubs: a selection resolves them, and none offers a tool or a section. */
const nameOnly = (names: readonly string[]): Extension[] =>
  names.map((name) => defineExtension({ name }));

/**
 * The room's registry in the toolset tests: every interactive name but the dynamic `satan`,
 * plus mail's, so it differs from either toolset's list.
 */
const ROOM_UNION = [
  ...new Set([
    ...toolsetList("interactive", "room").filter((name) => name !== SATAN),
    ...toolsetList("mail", "room"),
  ]),
];

/** The interactive toolset's names as a registry can resolve them: `satan` is not installed. */
const INTERACTIVE = toolsetList("interactive", "room").filter((name) => name !== SATAN);

/** A catalog holding `world`'s one faux provider, so both sessions script the same turns. */
const catalogOf = (world: ThreadWorld): Models => {
  const models = createModels();
  models.setProvider(world.faux.provider);
  return models;
};

/**
 * A room session over the sqlite file at `path`: the store a reopen reads again. `world`
 * gives it the scripted faux model the thread tools' turns read, and the second binding
 * step `threadWorld().open` runs, so the world's deps read this session's harness.
 */
const openRoomStore = async (
  path: string,
  registry: Registry,
  world?: ThreadWorld,
): Promise<Session> =>
  openSession(await openNodeSqliteStorage(path), {
    models: world === undefined ? fauxModels().models : catalogOf(world),
    registry,
    agent: { model: FAUX_MODEL },
    profile: "room",
    log: () => undefined,
    env: nodeEnv,
    ...(world === undefined
      ? {}
      : {
          beforeResume: (session: Session): void => {
            world.threads.harness = session.harness;
          },
        }),
  });

/** The conversation `id` names in `session`; fails when the store lost it. */
async function reopened(session: Session, id: ConversationId): Promise<Conversation> {
  const conversation = await session.harness.conversation(id, context);
  if (conversation === undefined) {
    throw new Error(`no conversation ${String(id)}`);
  }
  return conversation;
}

/**
 * An init that resolved the toolset from a pre-read snapshot: the stale read the design's
 * "read inside the creating commit" forbids (RV-015 F-9's negative control).
 */
const staleInit =
  (toolset: DaemonToolset): ConversationInit =>
  async (tx, id) => {
    const index = await tx.doc(IndexDocument);
    const entry = index.conversations[String(id)];
    if (entry === undefined) {
      throw new Error(`no index entry for ${String(id)}`);
    }
    index.conversations[String(id)] = { ...entry, toolset };
    await configure(tx, id, { extensions: selectionOf(toolsetList(toolset, "room")) });
  };

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
    const id = await createTaskOwned(session);
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
        profile: "room",
        log: () => undefined,
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
        profile: "room",
        log: () => undefined,
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
    const owned = await createTaskOwned(session);
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
      toolset: "interactive",
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

  // PHASE-02: a thread tool's conversation never answers for the topic (DEC-037).
  it("attach by topic lands on the operator-created conversation", async () => {
    const session = await passive();
    const api = conversations(session, DEFAULTS, "host");
    await api.setTopic({ name: "work" });
    const operator = await api.open({ kind: "topic", name: "work", new: true });
    const thread = await startThread(session.harness, operator, "work", "room");
    const forked = await forkConversation(session.harness, operator);
    expect(thread.id).toBeGreaterThan(operator.id);
    expect(forked.id).toBeGreaterThan(thread.id);
    // Both newer conversations are threads of `work`, and neither is its latest.
    const index = await indexOf(session.harness);
    expect(index.conversations[String(thread.id)]).toEqual({
      topic: "work",
      toolset: "interactive",
      startedBy: operator.id,
    });
    expect(index.conversations[String(forked.id)]).toEqual({
      topic: "work",
      parent: operator.id,
      toolset: "interactive",
    });
    expect((await api.open({ kind: "topic", name: "work", new: false })).id).toBe(operator.id);
    // A listing still shows every conversation of the topic, threads included.
    expect((await api.list({ kind: "topic", name: "work" })).ids).toEqual([
      forked.id,
      thread.id,
      operator.id,
    ]);
  });

  // PHASE-08 EX-1, VT-2: one listing, marked for exactly the ids a thread tool created.
  it("--list marks forks and started threads", async () => {
    const session = await passive();
    const api = conversations(session, DEFAULTS, "host");
    await api.setTopic({ name: "work" });
    const operator = await api.open({ kind: "topic", name: "work", new: true });
    const thread = await startThread(session.harness, operator, "work", "room");
    const forked = await forkConversation(session.harness, operator);
    const marks = {
      [String(thread.id)]: { startedBy: operator.id },
      [String(forked.id)]: { forkOf: operator.id },
    };
    // Both listings mark exactly the threads: every conversation, and the topic's own.
    expect(await api.list({ kind: "all" })).toEqual({
      ids: [forked.id, thread.id, operator.id, session.root.id],
      truncated: false,
      marks,
    });
    expect(await api.list({ kind: "topic", name: "work" })).toEqual({
      ids: [forked.id, thread.id, operator.id],
      truncated: false,
      marks,
    });
    // A page no thread is on carries no `marks` key at all: the frame is unchanged (DEC-007).
    const unmarked = await api.list({ kind: "topic", name: "default" });
    expect(unmarked).toEqual({ ids: [session.root.id], truncated: false });
    expect(Object.hasOwn(unmarked, "marks")).toBe(false);
  });

  it("toolsetInit with a started thread records startedBy", async () => {
    const session = await passive();
    const api = conversations(session, DEFAULTS, "host");
    await api.setTopic({ name: "work" });
    const caller = await api.open({ kind: "topic", name: "work", new: true });
    const saw: DaemonToolset[] = [];
    const thread = await createConversation(
      session.harness,
      toolsetInit("room", "work", {
        startedBy: caller.id,
        require: (toolset) => {
          saw.push(toolset);
        },
      }),
    );
    expect((await indexOf(session.harness)).conversations[String(thread.id)]).toEqual({
      topic: "work",
      toolset: "interactive",
      startedBy: caller.id,
    });
    // The judgement is the commit's own: it sees the toolset the topic chose.
    expect(saw).toEqual(["interactive"]);

    // A refusal throws inside the creating commit: nothing is created or indexed.
    await writeTopicRecord(session.harness, "mail", { toolset: "mail" });
    const before = await indexOf(session.harness);
    const listed = (await api.list({ kind: "all" })).ids;
    const refused = createConversation(
      session.harness,
      toolsetInit("room", "mail", {
        startedBy: caller.id,
        require: (toolset) => {
          requireSameTalkSet("room", "interactive", toolset, "topic mail");
        },
      }),
    );
    await expect(refused).rejects.toThrow(
      "topic mail (toolset mail) is outside this conversation's talk set (interactive)",
    );
    expect((await api.list({ kind: "all" })).ids).toEqual(listed);
    expect(await indexOf(session.harness)).toEqual(before);
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

  // PHASE-04 VT-1: a toolset is written like a directory, and the profile's policy judges it.
  // `job` is the one catalogue member no profile allows: the runner selects it in code.
  it.each(["room", "host"] as const)(
    "refuses a toolset the %s profile's policy does not allow, writing nothing",
    async (profile) => {
      const session = await passive();
      const api = conversations(session, DEFAULTS, profile);
      await api.setTopic({ name: "work", cwd: "/w" });
      const before = await indexOf(session.harness);
      // The throw may be synchronous or a rejection: both are the same refusal.
      const writing = async (): Promise<unknown> => api.setTopic({ name: "work", toolset: "job" });
      await expect(writing()).rejects.toThrow(`toolset job is not allowed on profile ${profile}`);
      expect(await indexOf(session.harness)).toEqual(before);
    },
  );

  it("stores a toolset the policy allows, leaving it when a write omits it (VT-1)", async () => {
    const session = await passive();
    const api = conversations(session, DEFAULTS, "host");
    expect(await api.setTopic({ name: "work", toolset: "interactive" })).toEqual({
      name: "work",
      toolset: "interactive",
    });
    // Absent `toolset` leaves the record alone; `null` clears it, keeping the directory.
    expect(await api.setTopic({ name: "work", cwd: "/w" })).toEqual({
      name: "work",
      cwd: "/w",
      toolset: "interactive",
    });
    expect(await api.setTopic({ name: "work", toolset: null })).toEqual({
      name: "work",
      cwd: "/w",
    });
    expect((await indexOf(session.harness)).topics).toEqual({ work: { cwd: "/w" } });
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

  it("VT-1 records each create's toolset and resolves it again after a reopen", async () => {
    const tmp = await tempDir();
    const path = join(tmp.dir, "toolsets.sqlite");
    // The room's stubs, with the real `threads` extension in the stub's place: its tools
    // create the last two probes below, in this same store.
    const world = threadWorld();
    const registry = registryOf(
      nameOnly(ROOM_UNION).map((extension) =>
        extension.name === "threads" ? threadsExtension(() => world.threads) : extension,
      ),
    );
    let session: Session | undefined;
    const close = async (): Promise<void> => {
      if (session !== undefined) {
        await session.harness.close(context);
      }
      session = undefined;
    };
    try {
      const first = await openRoomStore(path, registry, world);
      session = first;
      // (a) The production path creates the mail topic's conversation: the room allows mail.
      await writeTopicRecord(first.harness, "mailbox", { toolset: "mail" });
      const mailTopic = await conversations(first, DEFAULTS, "room").open({
        kind: "topic",
        name: "mailbox",
        new: true,
      });
      // (b) A plain topic, and (c) attach `new`: the profile default.
      await writeTopicRecord(first.harness, "work", {});
      const plain = await conversations(first, DEFAULTS, "room").open({
        kind: "topic",
        name: "work",
        new: true,
      });
      const fresh = await conversations(first, DEFAULTS, "room").open({ kind: "new" });

      // (d) The thread tools' own creates: one started in `work`, one forked from a caller.
      // The caller holds the whole interactive list, as a plain create does, so the fork
      // copies it rather than the fixture's default `threads`-only selection.
      const caller = await createIndexedThread(
        first.harness,
        "work",
        toolsetList("interactive", "room"),
      );
      const base = { world, session: first, caller };
      const startedChild = await conversationOf(
        first.harness,
        answeredChild(
          await attemptCall(base, "thread_start", {
            intent: INTENT,
            context: CONTEXT,
            topic: "work",
          }),
        ),
      );
      // The start's child post turn is held: wait until every response the turn scripts is
      // read, so the fork's queue is not taken by the start's child.
      await vi.waitFor(() => {
        expect(world.faux.getPendingResponseCount()).toBe(0);
      }, WAIT);
      const forkedChild = await conversationOf(
        first.harness,
        answeredChild(await attemptCall(base, "thread_fork", { intent: INTENT, context: CONTEXT })),
      );

      const probes = {
        mail: await toolsetProbe(mailTopic),
        plain: await toolsetProbe(plain),
        fresh: await toolsetProbe(fresh),
        started: await toolsetProbe(startedChild),
        forked: await toolsetProbe(forkedChild),
      };
      expect(probes.mail.extensions).toEqual([...toolsetList("mail", "room")]);
      // The started child takes the topic's interactive list, as a plain create does; the
      // fork copies its caller's, which this guard gives the whole list.
      expect(probes.plain.extensions).toEqual(INTERACTIVE);
      expect(probes.fresh.extensions).toEqual(INTERACTIVE);
      expect(probes.started.extensions).toEqual(INTERACTIVE);
      expect(probes.forked.extensions).toEqual(INTERACTIVE);

      const index = await readIndex(first.harness);
      expect(storedEntry(index, mailTopic.id)?.toolset).toBe("mail");
      expect(storedEntry(index, plain.id)?.toolset).toBe("interactive");
      expect(storedEntry(index, fresh.id)?.toolset).toBe("interactive");
      expect(storedEntry(index, startedChild.id)).toEqual({
        topic: "work",
        toolset: "interactive",
        startedBy: caller.id,
      });
      expect(storedEntry(index, forkedChild.id)).toEqual({
        topic: "work",
        toolset: "interactive",
        parent: caller.id,
      });
      await close();

      // The close cuts off the children's held post turns: plain answers let whatever the
      // reopen resumes (a retried post, or its failed-post notice) finish harmlessly.
      world.faux.setResponses(
        Array.from({ length: 8 }, () => fauxAssistantMessage([fauxText("posted")])),
      );
      // The store holds mail and both thread children: the production policy reopens it.
      const second = await openRoomStore(path, registry, world);
      session = second;
      expect(await toolsetProbe(() => reopened(second, mailTopic.id))).toEqual(probes.mail);
      expect(await toolsetProbe(() => reopened(second, plain.id))).toEqual(probes.plain);
      expect(await toolsetProbe(() => reopened(second, fresh.id))).toEqual(probes.fresh);
      expect(await toolsetProbe(() => reopened(second, startedChild.id))).toEqual(probes.started);
      expect(await toolsetProbe(() => reopened(second, forkedChild.id))).toEqual(probes.forked);
    } finally {
      await close();
      await tmp.cleanup();
    }
  });

  it("VT-1 refusal: the host profile refuses a mail topic's conversation and creates none", async () => {
    const session = await passive();
    const api = conversations(session, DEFAULTS, "host");
    await writeTopicRecord(session.harness, "mailbox", { toolset: "mail" });
    await expect(api.open({ kind: "topic", name: "mailbox", new: true })).rejects.toThrow(
      "toolset mail is not allowed on profile host",
    );
    expect(await api.list({ kind: "topic", name: "mailbox" })).toEqual({
      ids: [],
      truncated: false,
    });
    expect((await api.list({ kind: "all" })).ids).toEqual([session.root.id]);
  });

  it("VT-1 negative control: a conversation created with no init takes the whole registry (RV-015 F-31)", async () => {
    const session = await passive({ extensions: nameOnly(ROOM_UNION) });
    const unselected = await session.harness.createConversation(
      { ownership: { kind: "ownerless" } },
      context,
    );
    const probe = await toolsetProbe(unselected);
    expect(probe.extensions).toEqual(ROOM_UNION);
    expect(probe.extensions).not.toEqual(INTERACTIVE);
  });

  it("VT-2 records the topic's toolset as the creating commit reads it (RV-015 F-9)", async () => {
    const session = await passive({ extensions: nameOnly(ROOM_UNION) });
    // Commit 1 stages the topic; commit 2 is the create, which resolves the toolset in its tx.
    await writeTopicRecord(session.harness, "staged", { toolset: "mail" });
    const staged = await session.harness.createConversation(
      { ownership: { kind: "ownerless" }, init: toolsetInit("room", "staged") },
      context,
    );
    // A change between a pre-read and the create: the create's own read wins.
    const before = await readIndex(session.harness);
    await writeTopicRecord(session.harness, "staged", { toolset: "interactive" });
    const current = await session.harness.createConversation(
      { ownership: { kind: "ownerless" }, init: toolsetInit("room", "staged") },
      context,
    );
    const index = await readIndex(session.harness);
    expect(storedEntry(index, staged.id)?.toolset).toBe("mail");
    expect(storedEntry(index, current.id)?.toolset).toBe("interactive");
    expect((await toolsetProbe(current)).extensions).toEqual(INTERACTIVE);

    // Negative control: the same create, resolving from `before`, records the stale toolset.
    const stale = await session.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        init: staleInit(storedTopic(before, "staged")?.toolset ?? PROFILE_TOOLSETS.room.default),
      },
      context,
    );
    expect(storedEntry(await readIndex(session.harness), stale.id)?.toolset).toBe("mail");
    expect((await toolsetProbe(stale)).extensions).toEqual([...toolsetList("mail", "room")]);
  });
});
