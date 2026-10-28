// SL-003 PHASE-01: the conversation index — the document, the creating-commit
// hook, the backfill, and the reads over them (design sec-2, sec-3 Latest;
// DEC-012, DEC-013, DEC-015). Every assertion reads the document through
// `indexOf`, so no test depends on how the index is written.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { expect, it } from "vitest";
import { toolsetInit } from "../src/conversations.ts";
import { context } from "../src/context.ts";
import {
  BACKFILL_PAGE,
  backfillIndex,
  idsIn,
  IndexDocument,
  indexConversation,
  type IndexDoc,
  type IndexEntry,
  isThread,
  latestIn,
  readIndex,
  topicsOf,
  writeTopicRecord,
} from "../src/topics.ts";
import { DEFAULT_TOPIC } from "../src/protocol.ts";
import { tempDir } from "./fixtures.ts";
import {
  closing,
  createConversation,
  createTaskOwned,
  countingCommits as countingCommitsOf,
  type FauxHarnessOptions,
  forkConversation,
  indexOf,
  openFauxHarness,
  openIndexedHarness,
  type TestHarness,
} from "./harness-fixture.ts";

/** A harness with no hook at all: a store from before this slice, unless `options` says otherwise. */
const preIndex = async (options: FauxHarnessOptions = {}): Promise<TestHarness> => {
  const test = await openFauxHarness(new MemoryStorage(), { resume: false, ...options });
  closing(test.harness);
  return test;
};

/** The ids of every conversation in the store, oldest first. */
const conversationIds = async (harness: Harness): Promise<number[]> => {
  const page = await harness.commit(
    (tx) => tx.scanConversations({ order: "ascending" }, 100),
    context,
  );
  return page.items.map((record) => record.id);
};

/** The entry the index writes for a conversation no topic was named for. */
const DEFAULT = { topic: "default" };

it("indexes a created conversation, and root, in the default topic", async () => {
  const test = await openIndexedHarness();
  const created = await createConversation(test.harness);
  const index = await indexOf(test.harness);
  expect(index.conversations[String(created.id)]).toEqual(DEFAULT);
  // Root alone carries a toolset: the hook wrote the other entry, and the reconcile ran at open.
  expect(index.conversations[String(test.root.id)]).toEqual({
    ...DEFAULT,
    toolset: "interactive",
  });
});

it("files a conversation created with a topic under that topic", async () => {
  const test = await openIndexedHarness();
  const created = await createConversation(test.harness, toolsetInit("room", "work"));
  expect((await indexOf(test.harness)).conversations[String(created.id)]).toEqual({
    topic: "work",
    toolset: "interactive",
  });
});

it("records a fork's parent's topic and its parent's id", async () => {
  const test = await openIndexedHarness();
  const parent = await createConversation(test.harness, toolsetInit("room", "work"));
  const forked = await forkConversation(test.harness, parent);
  expect((await indexOf(test.harness)).conversations[String(forked.id)]).toEqual({
    topic: "work",
    parent: parent.id,
    toolset: "interactive",
  });
});

it("the hook copies a fork's toolset from its parent, and fails the commit when the parent has none", async () => {
  const test = await openIndexedHarness();
  // A topic whose toolset is not the profile default, so a default would be caught.
  await writeTopicRecord(test.harness, "inbox", { toolset: "mail" });
  const parent = await createConversation(test.harness, toolsetInit("room", "inbox"));
  const forked = await forkConversation(test.harness, parent);
  expect((await indexOf(test.harness)).conversations[String(forked.id)]).toEqual({
    topic: "inbox",
    parent: parent.id,
    toolset: "mail",
  });

  // A parent whose entry carries no toolset: the fork's commit fails and writes nothing.
  const bare = await createConversation(test.harness);
  const before = await indexOf(test.harness);
  await expect(forkConversation(test.harness, bare)).rejects.toThrow(
    new RegExp(`^conversation \\d+: fork of ${String(bare.id)}, which has no toolset$`),
  );
  expect(await indexOf(test.harness)).toEqual(before);
  expect(await conversationIds(test.harness)).toEqual([
    test.root.id,
    parent.id,
    forked.id,
    bare.id,
  ]);
});

it("indexes a conversation created by a raw transaction in the default topic", async () => {
  const test = await openIndexedHarness();
  const created = await test.harness.commit(
    (tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
    context,
  );
  expect((await indexOf(test.harness)).conversations[String(created.id)]).toEqual(DEFAULT);
});

it("leaves a task-owned conversation out of the index", async () => {
  const test = await openIndexedHarness();
  const owned = await createTaskOwned(test);
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
  const test = await openIndexedHarness();
  const before = await indexOf(test.harness);
  await expect(
    createConversation(test.harness, () => {
      throw new Error("init failed");
    }),
  ).rejects.toThrow("init failed");
  expect(await conversationIds(test.harness)).toEqual([test.root.id]);
  expect(await indexOf(test.harness)).toEqual(before);
});

it("indexes root() from the hook alone: Harness.open with indexConversation, no backfill", async () => {
  const test = await preIndex({ conversationCreated: indexConversation });
  expect((await indexOf(test.harness)).conversations[String(test.root.id)]).toEqual(DEFAULT);
});

it("reads a store whose index was never written as the initial document", async () => {
  const test = await preIndex();
  expect(await readIndex(test.harness)).toEqual({ topics: {}, conversations: {} });
});

it("finds a topic's latest conversation and its ids newest first", async () => {
  const test = await openIndexedHarness();
  const first = await createConversation(test.harness, toolsetInit("room", "work"));
  await createConversation(test.harness, toolsetInit("room", "other"));
  const last = await createConversation(test.harness, toolsetInit("room", "work"));
  const index = await indexOf(test.harness);
  expect(latestIn(index, "work")).toBe(last.id);
  expect(idsIn(index, "work")).toEqual([last.id, first.id]);
  expect(idsIn(index, "nothing")).toEqual([]);
  expect(latestIn(index, "nothing")).toBeUndefined();
});

// PHASE-02: a thread tool's conversation is no topic's latest (DEC-037, refining DEC-015).
it("latestIn skips forks and started threads", () => {
  const operator: IndexEntry = { topic: "work", toolset: "interactive" };
  const fork: IndexEntry = { topic: "work", parent: 11, toolset: "interactive" };
  const started: IndexEntry = { topic: "work", startedBy: 11, toolset: "interactive" };
  const onlyThreads: IndexEntry = { topic: "threads", startedBy: 11, toolset: "interactive" };
  const index: IndexDoc = {
    topics: { work: {}, threads: {} },
    conversations: { "11": operator, "12": fork, "13": started, "14": onlyThreads },
  };
  // The operator's own conversation is the latest, though two threads have higher ids.
  expect(latestIn(index, "work")).toBe(11);
  // A listing is unchanged: threads are conversations too.
  expect(idsIn(index, "work")).toEqual([13, 12, 11]);
  // A topic of threads only has no latest, as an empty one has none.
  expect(latestIn(index, "threads")).toBeUndefined();
  expect(isThread(fork)).toBe(true);
  expect(isThread(started)).toBe(true);
  expect(isThread(operator)).toBe(false);
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

it("lists a topic's toolset beside its directory, both empty when unset (PHASE-04 VT-3)", () => {
  const index: IndexDoc = {
    topics: { bare: {}, mail: { cwd: "/mail", toolset: "mail" } },
    conversations: {},
  };
  expect(topicsOf(index)).toEqual([
    { name: "default" },
    { name: "bare" },
    { name: "mail", cwd: "/mail", toolset: "mail" },
  ]);
});

// PHASE-04 VT-3: the topic's toolset is written exactly as its directory is (design sec-3).
it("sets, clears and leaves a topic's toolset, the directory surviving every write", async () => {
  const test = await openIndexedHarness();
  expect(await writeTopicRecord(test.harness, "work", { cwd: "/w", toolset: "mail" })).toEqual({
    name: "work",
    cwd: "/w",
    toolset: "mail",
  });
  // An absent key leaves the record as it is, whichever of the two the write names.
  expect(await writeTopicRecord(test.harness, "work", {})).toEqual({
    name: "work",
    cwd: "/w",
    toolset: "mail",
  });
  expect(await writeTopicRecord(test.harness, "work", { cwd: "/elsewhere" })).toEqual({
    name: "work",
    cwd: "/elsewhere",
    toolset: "mail",
  });
  expect(await writeTopicRecord(test.harness, "work", { toolset: "interactive" })).toEqual({
    name: "work",
    cwd: "/elsewhere",
    toolset: "interactive",
  });
  // The two keys clear independently: neither write takes the other with it.
  expect(await writeTopicRecord(test.harness, "work", { cwd: null })).toEqual({
    name: "work",
    toolset: "interactive",
  });
  expect(await writeTopicRecord(test.harness, "work", { cwd: "/back" })).toEqual({
    name: "work",
    cwd: "/back",
    toolset: "interactive",
  });
  expect(await writeTopicRecord(test.harness, "work", { toolset: null })).toEqual({
    name: "work",
    cwd: "/back",
  });
  expect((await indexOf(test.harness)).topics).toEqual({ work: { cwd: "/back" } });
});

it("refuses to store the reserved default topic (DEC-015)", async () => {
  const test = await openIndexedHarness();
  await expect(writeTopicRecord(test.harness, DEFAULT_TOPIC, {})).rejects.toThrow(
    "topic: default is reserved",
  );
  expect((await indexOf(test.harness)).topics).toEqual({});
});

it("merges the topic into an entry, keeping a key a later slice wrote", async () => {
  const test = await openIndexedHarness();
  const created = await createConversation(test.harness);
  await test.harness.commit(async (tx) => {
    const index = await tx.doc(IndexDocument);
    const titled: IndexEntry & { title: string } = {
      topic: "default",
      title: "kept",
      toolset: "interactive",
    };
    index.conversations[String(created.id)] = titled;
  }, context);
  await test.harness.commit((tx) => toolsetInit("room", "work")(tx, created.id), context);
  expect((await indexOf(test.harness)).conversations[String(created.id)]).toEqual({
    topic: "work",
    title: "kept",
    toolset: "interactive",
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
  const fork = await forkConversation(harness, parent);
  return { created, parent: parent.id, fork: fork.id };
};

it("backfills a pre-index store across pages, forks with their parent, and writes nothing on the next start", async () => {
  const tmp = await tempDir();
  const path = join(tmp.dir, "index.sqlite");
  let opened: TestHarness | undefined;
  const close = async (): Promise<void> => {
    await opened?.harness.close(context);
    opened = undefined;
  };
  try {
    // One storage owner at a time: each harness closes before the next opens.
    const before = await openFauxHarness(await openNodeSqliteStorage(path), { resume: false });
    const root = before.root.id;
    const { created, parent, fork } = await populate(before.harness, BACKFILL_PAGE + 1);
    const owned = await createTaskOwned(before);
    expect(await indexOf(before.harness)).toEqual({ topics: {}, conversations: {} });
    await before.harness.close(context);

    // The backfill alone: a session's reconcile refuses a store that holds a fork (design sec-3).
    const first = countingCommitsOf(await openNodeSqliteStorage(path));
    opened = await openFauxHarness(first.storage, {
      resume: false,
      conversationCreated: indexConversation,
    });
    const beforeBackfill = first.commits();
    await backfillIndex(opened.harness);
    expect(first.commits()).toBeGreaterThan(beforeBackfill);
    const index = await indexOf(opened.harness);
    // The backfill writes no toolset: the reconcile's step 1 adds it at the next startup.
    const entries: Record<string, Omit<IndexEntry, "toolset">> = Object.fromEntries(
      [root, ...created].map((id) => [String(id), DEFAULT]),
    );
    entries[String(fork)] = { ...DEFAULT, parent };
    expect(index).toEqual({ topics: {}, conversations: entries });
    expect(index.conversations[String(owned)]).toBeUndefined();
    await close();

    const second = countingCommitsOf(await openNodeSqliteStorage(path));
    opened = await openFauxHarness(second.storage, {
      resume: false,
      conversationCreated: indexConversation,
    });
    await backfillIndex(opened.harness);
    expect(await indexOf(opened.harness)).toEqual(index);
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
    const titled: IndexEntry & { title: string } = {
      topic: "work",
      title: "kept",
      toolset: "interactive",
    };
    index.conversations[String(fork)] = titled;
  }, context);
  await backfillIndex(test.harness);
  expect((await indexOf(test.harness)).conversations[String(fork)]).toEqual({
    topic: "work",
    title: "kept",
    parent,
    toolset: "interactive",
  });
});
