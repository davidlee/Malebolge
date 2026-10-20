// The daemon's conversation resolver: root, the conversation a wire id names,
// a new one carrying the daemon's defaults, and the stream that watches one.
// The reopen case proves a created conversation is never reconfigured.

import { join } from "node:path";
import { defineTask, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, describe, expect, it } from "vitest";
import { context } from "../src/context.ts";
import {
  type ConversationDefaults,
  conversations,
  isConversationKey,
} from "../src/conversations.ts";
import { registryOf } from "../src/registry.ts";
import { openSession, type Session } from "../src/session.ts";
import { tempDir } from "./fixtures.ts";
import { FAUX_MODEL, fauxModels, openFauxHarness, type TestHarness } from "./harness-fixture.ts";

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

  /** A passive harness on memory storage: it only reads and creates, so nothing is scheduled. */
  const passive = async (): Promise<TestHarness> => {
    test = await openFauxHarness(new MemoryStorage(), { resume: false });
    return test;
  };

  it("opens root", async () => {
    const session = await passive();
    expect(await conversations(session, DEFAULTS).open({ kind: "root" })).toBe(session.root);
  });

  it("opens an existing conversation by the id a wire frame names", async () => {
    const session = await passive();
    const opened = await conversations(session, DEFAULTS).open({
      kind: "existing",
      id: session.root.id,
    });
    expect(opened.id).toBe(session.root.id);
  });

  it("refuses an unknown id", async () => {
    const session = await passive();
    const open = conversations(session, DEFAULTS).open({ kind: "existing", id: 999999 });
    await expect(open).rejects.toThrow("no conversation 999999");
  });

  it("refuses an id no wire parser would accept", async () => {
    const session = await passive();
    const open = conversations(session, DEFAULTS).open({ kind: "existing", id: 0 });
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
    const open = conversations(session, DEFAULTS).open({ kind: "existing", id });
    await expect(open).rejects.toThrow(`conversation ${String(id)} belongs to a task`);
  });

  it("creates a conversation with the daemon's defaults", async () => {
    const session = await passive();
    const created = await conversations(session, DEFAULTS).open({ kind: "new" });
    const agent = await created.agent(context);
    expect(agent.model).toEqual(FAUX_MODEL);
    expect(agent.cwd).toBe("/daemon-default");
  });

  it("creates a conversation in its own cwd, the empty string included", async () => {
    const session = await passive();
    const api = conversations(session, DEFAULTS);
    expect((await (await api.open({ kind: "new", cwd: "/own" })).agent(context)).cwd).toBe("/own");
    expect((await (await api.open({ kind: "new", cwd: "" })).agent(context)).cwd).toBe("");
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
      const created = await conversations(first, {
        model: FAUX_MODEL,
        cwd: tmp.dir,
      }).open({ kind: "new", cwd: own });
      await close();

      const second = await openSession(await openNodeSqliteStorage(path), {
        models: fauxModels().models,
        registry: registryOf([]),
        agent: { model: changedModel, cwd: changedCwd },
        env: nodeEnv,
      });
      session = second;
      const reopened = await conversations(second, {
        model: changedModel,
        cwd: changedCwd,
      }).open({ kind: "existing", id: created.id });
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
    const api = conversations(session, DEFAULTS);
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
});
