// SL-003 PHASE-01: the conversation index — the document, the creating-commit
// hook, the backfill, and the reads over them (design sec-2, sec-3 Latest;
// DEC-012, DEC-013, DEC-015). Every assertion reads the document through
// `indexOf`, so no test depends on how the index is written.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Conversation,
  type ConversationInit,
  defineTask,
  type Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { expect, it, onTestFinished } from "vitest";
import { context } from "../src/context.ts";
import { registryOf } from "../src/registry.ts";
import { openSession, type Session, type SessionOptions } from "../src/session.ts";
import {
  assignTopic,
  BACKFILL_PAGE,
  backfillIndex,
  idsIn,
  IndexDocument,
  indexConversation,
  type IndexDoc,
  type IndexEntry,
  latestIn,
  readIndex,
  topicsOf,
  writeTopicRecord,
} from "../src/topics.ts";
import { DEFAULT_TOPIC } from "../src/protocol.ts";
import { tempDir } from "./fixtures.ts";
import {
  FAUX_MODEL,
  countingCommits as countingCommitsOf,
  fauxModels,
  type FauxHarnessOptions,
  indexOf,
  openFauxHarness,
  openTestHarness,
  type TestHarness,
} from "./harness-fixture.ts";

const nodeEnv = ({ cwd }: { cwd?: string }): NodeExecutionEnv =>
  new NodeExecutionEnv({ cwd: cwd ?? process.cwd() });

const SESSION_OPTIONS: SessionOptions = {
  models: fauxModels().models,
  registry: registryOf([]),
  agent: { model: FAUX_MODEL },
  env: nodeEnv,
};

/** `harness`, closed when the test ends. */
const closing = <T extends Harness>(harness: T): T => {
  onTestFinished(() => harness.close(context));
  return harness;
};

/** A session opened through `openSession`: the hook and the backfill ran. */
const sessioned = async (): Promise<TestHarness> => {
  const test = await openTestHarness([]);
  closing(test.harness);
  return test;
};

/** A harness with no hook at all: a store from before this slice, unless `options` says otherwise. */
const preIndex = async (options: FauxHarnessOptions = {}): Promise<TestHarness> => {
  const test = await openFauxHarness(new MemoryStorage(), { resume: false, ...options });
  closing(test.harness);
  return test;
};

/** One ownerless conversation through the harness's own creating path. */
const createConversation = (harness: Harness, init?: ConversationInit): Promise<Conversation> =>
  harness.createConversation(
    { ownership: { kind: "ownerless" }, ...(init === undefined ? {} : { init }) },
    context,
  );

/** The ids of every conversation in the store, oldest first. */
const conversationIds = async (harness: Harness): Promise<number[]> => {
  const page = await harness.commit(
    (tx) => tx.scanConversations({ order: "ascending" }, 100),
    context,
  );
  return page.items.map((record) => record.id);
};

/** A task whose only phase waits: a stub, never run on a passive harness. */
const stubTask = defineTask({
  name: "stub",
  version: 1,
  initial: () => ({ phase: "waiting" as const }),
  phases: { waiting: () => Promise.resolve() },
  abort: () => Promise.resolve(),
});

/** The entry the index writes for a conversation no topic was named for. */
const DEFAULT = { topic: "default" };

it("indexes a created conversation, and root, in the default topic", async () => {
  const test = await sessioned();
  const created = await createConversation(test.harness);
  const index = await indexOf(test.harness);
  expect(index.conversations[String(created.id)]).toEqual(DEFAULT);
  expect(index.conversations[String(test.root.id)]).toEqual(DEFAULT);
});

it("files a conversation created with a topic under that topic", async () => {
  const test = await sessioned();
  const created = await createConversation(test.harness, assignTopic("work"));
  expect((await indexOf(test.harness)).conversations[String(created.id)]).toEqual({
    topic: "work",
  });
});

it("records a fork's parent's topic and its parent's id", async () => {
  const test = await sessioned();
  const parent = await createConversation(test.harness, assignTopic("work"));
  const entry = await test.harness.commit(
    (tx) => tx.appendEntry(parent.id, { kind: "test.note", data: { note: "fork here" } }),
    context,
  );
  const forked = await parent.fork(entry.id, { ownership: { kind: "ownerless" } }, context);
  expect((await indexOf(test.harness)).conversations[String(forked.id)]).toEqual({
    topic: "work",
    parent: parent.id,
  });
});

it("indexes a conversation created by a raw transaction in the default topic", async () => {
  const test = await sessioned();
  const created = await test.harness.commit(
    (tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
    context,
  );
  expect((await indexOf(test.harness)).conversations[String(created.id)]).toEqual(DEFAULT);
});

it("leaves a task-owned conversation out of the index", async () => {
  const test = await sessioned();
  const owned = await test.harness.commit(async (tx) => {
    const taskId = await tx.createTask(
      stubTask,
      {},
      { ownership: { kind: "conversation" }, conversationId: test.root.id },
    );
    return (await tx.createConversation({ ownership: { kind: "task", taskId } })).id;
  }, context);
  expect((await indexOf(test.harness)).conversations[String(owned)]).toBeUndefined();
});

// pi-durable's contract the index relies on, with a stand-in hook: not `indexConversation` itself.
it("pi-durable fails the creating commit when its conversationCreated hook throws", async () => {
  let created = 0;
  const test = await preIndex({
    conversationCreated: () => {
      created += 1;
      if (created > 1) {
        throw new Error("index hook failed");
      }
    },
  });
  await expect(createConversation(test.harness)).rejects.toThrow("index hook failed");
  expect(await conversationIds(test.harness)).toEqual([test.root.id]);
});

it("persists neither the conversation nor its entry when an init throws", async () => {
  const test = await sessioned();
  const before = await indexOf(test.harness);
  await expect(
    createConversation(test.harness, () => {
      throw new Error("init failed");
    }),
  ).rejects.toThrow("init failed");
  expect(await conversationIds(test.harness)).toEqual([test.root.id]);
  expect(await indexOf(test.harness)).toEqual(before);
});

it("indexes root from the hook alone, with no backfill", async () => {
  const test = await preIndex({ conversationCreated: indexConversation });
  expect((await indexOf(test.harness)).conversations[String(test.root.id)]).toEqual(DEFAULT);
});

it("reads a store whose index was never written as the initial document", async () => {
  const test = await preIndex();
  expect(await readIndex(test.harness)).toEqual({ topics: {}, conversations: {} });
});

it("finds a topic's latest conversation and its ids newest first", async () => {
  const test = await sessioned();
  const first = await createConversation(test.harness, assignTopic("work"));
  await createConversation(test.harness, assignTopic("other"));
  const last = await createConversation(test.harness, assignTopic("work"));
  const index = await indexOf(test.harness);
  expect(latestIn(index, "work")).toBe(last.id);
  expect(idsIn(index, "work")).toEqual([last.id, first.id]);
  expect(idsIn(index, "nothing")).toEqual([]);
  expect(latestIn(index, "nothing")).toBeUndefined();
});

it("lists default first, then the stored topics by name, each with its directory", () => {
  const index: IndexDoc = {
    topics: { work: { cwd: "/work" }, aaa: {}, zed: { cwd: "/zed" } },
    conversations: {},
  };
  expect(topicsOf(index)).toEqual([
    { name: "default" },
    { name: "aaa" },
    { name: "work", cwd: "/work" },
    { name: "zed", cwd: "/zed" },
  ]);
});

it("refuses to store the reserved default topic (DEC-015)", async () => {
  const test = await sessioned();
  await expect(writeTopicRecord(test.harness, DEFAULT_TOPIC, undefined)).rejects.toThrow(
    "topic: default is reserved",
  );
  expect((await indexOf(test.harness)).topics).toEqual({});
});

it("merges the topic into an entry, keeping a key a later slice wrote", async () => {
  const test = await sessioned();
  const created = await createConversation(test.harness);
  await test.harness.commit(async (tx) => {
    const index = await tx.doc(IndexDocument);
    const titled: IndexEntry & { title: string } = { topic: "default", title: "kept" };
    index.conversations[String(created.id)] = titled;
  }, context);
  await test.harness.commit((tx) => assignTopic("work")(tx, created.id), context);
  expect((await indexOf(test.harness)).conversations[String(created.id)]).toEqual({
    topic: "work",
    title: "kept",
  });
});

it("keeps IndexDocument to src/topics.ts", () => {
  const dir = join(import.meta.dirname, "..", "src");
  const naming = readdirSync(dir)
    .filter((name) => name.endsWith(".ts") && name !== "topics.ts")
    .filter((name) => readFileSync(join(dir, name), "utf8").includes("IndexDocument"));
  expect(naming).toEqual([]);
});

/** A pre-index store's conversations: `count` ownerless ones oldest first, then a fork of the first. */
interface Populated {
  created: number[];
  parent: number;
  fork: number;
}

/** `count` (at least one) ownerless conversations, then a fork of the first. */
const populate = async (harness: Harness, count: number): Promise<Populated> => {
  const parent = await createConversation(harness);
  const created = [parent.id];
  while (created.length < count) {
    created.push((await createConversation(harness)).id);
  }
  const at = await harness.commit(
    (tx) => tx.appendEntry(parent.id, { kind: "test.note", data: { note: "fork here" } }),
    context,
  );
  const fork = await parent.fork(at.id, { ownership: { kind: "ownerless" } }, context);
  return { created, parent: parent.id, fork: fork.id };
};

it("backfills a pre-index store across pages, forks with their parent, and writes nothing on the next start", async () => {
  const tmp = await tempDir();
  const path = join(tmp.dir, "index.sqlite");
  let session: Session | undefined;
  const close = async (): Promise<void> => {
    if (session !== undefined) {
      await session.harness.close(context);
    }
    session = undefined;
  };
  try {
    // One storage owner at a time: the pre-index harness closes before the session opens.
    const before = await openFauxHarness(await openNodeSqliteStorage(path), { resume: false });
    const root = before.root.id;
    const { created, parent, fork } = await populate(before.harness, BACKFILL_PAGE + 1);
    const owned = await before.harness.commit(async (tx) => {
      const taskId = await tx.createTask(
        stubTask,
        {},
        { ownership: { kind: "conversation" }, conversationId: root },
      );
      return (await tx.createConversation({ ownership: { kind: "task", taskId } })).id;
    }, context);
    expect(await indexOf(before.harness)).toEqual({ topics: {}, conversations: {} });
    await before.harness.close(context);

    const first = countingCommitsOf(await openNodeSqliteStorage(path));
    session = await openSession(first.storage, SESSION_OPTIONS);
    const index = await indexOf(session.harness);
    const entries: Record<string, IndexEntry> = Object.fromEntries(
      [root, ...created].map((id) => [String(id), DEFAULT]),
    );
    entries[String(fork)] = { ...DEFAULT, parent };
    expect(index).toEqual({ topics: {}, conversations: entries });
    expect(index.conversations[String(owned)]).toBeUndefined();
    expect(first.commits()).toBeGreaterThan(0);
    await close();

    const second = countingCommitsOf(await openNodeSqliteStorage(path));
    session = await openSession(second.storage, SESSION_OPTIONS);
    expect(await indexOf(session.harness)).toEqual(index);
    expect(second.commits()).toBe(0);
  } finally {
    await close();
    await tmp.cleanup();
  }
});

it("restores a backfilled fork's missing parent, keeping its topic and every other key", async () => {
  const test = await preIndex();
  const { parent, fork } = await populate(test.harness, 1);
  // What a backfill that dropped `parent` left behind, plus a key a later slice wrote.
  await test.harness.commit(async (tx) => {
    const index = await tx.doc(IndexDocument);
    index.conversations[String(parent)] = DEFAULT;
    const titled: IndexEntry & { title: string } = { topic: "work", title: "kept" };
    index.conversations[String(fork)] = titled;
  }, context);
  await backfillIndex(test.harness);
  expect((await indexOf(test.harness)).conversations[String(fork)]).toEqual({
    topic: "work",
    title: "kept",
    parent,
  });
});
