import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  type FauxResponseFactory,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import {
  AgentDoc,
  type ConversationId,
  defineExtension,
  defineTask,
  defineTool,
  MemoryStorage,
  type Registry,
  type Task,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "../src/config.ts";
import { topicInit } from "../src/conversations.ts";
import { context } from "../src/context.ts";
import { registryOf } from "../src/registry.ts";
import type { Log } from "../src/satan-tools.ts";
import { DAEMON_SETTINGS, openSession, type Session, type SessionOptions } from "../src/session.ts";
import {
  IndexDocument,
  indexConversation,
  readIndex,
  storedEntry,
  writeEntry,
  writeTopicRecord,
} from "../src/topics.ts";
import { PROFILE_TOOLSETS, selectionOf, toolsetList } from "../src/toolsets.ts";
import { tempDir } from "./fixtures.ts";
import {
  callThenAnswer,
  createConversation,
  createTaskOwned,
  FAUX_CATALOG,
  FAUX_MODEL,
  fakeClock,
  fauxModels as scriptedModels,
  forkConversation,
  indexOf,
  openFauxHarness,
  type TestHarness,
  textOf,
  toolResults,
} from "./harness-fixture.ts";
import { failingOnce, submissionOf, userText, WAIT } from "./wake-fixture.ts";

const fauxModels = (answers: string[]): Models => {
  const faux = fauxProvider();
  faux.setResponses(answers.map((text) => fauxAssistantMessage([fauxText(text)])));
  const models = createModels();
  models.setProvider(faux.provider);
  return models;
};

const nodeEnv = ({ cwd }: { cwd?: string }): NodeExecutionEnv =>
  new NodeExecutionEnv({ cwd: cwd ?? process.cwd() });

/** A model request held open until it is aborted (so its turn stays in flight). */
function heldCall(): { step: FauxResponseFactory; started: Promise<void> } {
  let start = (): void => undefined;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const step: FauxResponseFactory = (_context, options) =>
    new Promise((resolve) => {
      start();
      const end = (): void => {
        resolve(fauxAssistantMessage([fauxText("aborted")]));
      };
      if (options?.signal?.aborted === true) {
        end();
      }
      options?.signal?.addEventListener("abort", end);
    });
  return { step, started };
}

const alpha = (text: string): ToolRegistration =>
  defineTool({
    name: "alpha",
    description: "Answers alpha.",
    parameters: Type.Object({}),
    execute: () => Promise.resolve({ output: [{ type: "text", text }] }),
  });

const satanWith = (text: string): Registry =>
  registryOf([defineExtension({ name: "satan", tools: [alpha(text)] })]);

describe("openSession", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(() => cleanup?.());

  it("reopens the same conversation, transcript intact, from its storage file", async () => {
    const tmp = await tempDir();
    cleanup = tmp.cleanup;
    const path = join(tmp.dir, "session.sqlite");
    const open = async (answers: string[]): Promise<Session> =>
      openSession(await openNodeSqliteStorage(path), {
        models: fauxModels(answers),
        registry: registryOf([]),
        agent: { model: FAUX_MODEL, cwd: tmp.dir },
        profile: "room",
        log: () => undefined,
        env: nodeEnv,
      });

    const first = await open(["one"]);
    await (await first.root.submit({ type: "input", content: "a" }, context)).wait(context);
    const firstId = first.root.id;
    await first.harness.close(context);

    const second = await open(["two"]);
    expect(second.root.id).toBe(firstId);
    await (await second.root.submit({ type: "input", content: "b" }, context)).wait(context);
    const page = await second.root.entries({}, 50, undefined, context);
    const kinds = [...page.items].reverse().map((entry) => entry.kind);
    expect(kinds.filter((kind) => kind === "pi.user")).toHaveLength(2);
    expect(kinds.filter((kind) => kind === "pi.assistant")).toHaveLength(2);
    await second.harness.close(context);
  });

  it("applies the current agent settings on every open", async () => {
    const tmp = await tempDir();
    cleanup = tmp.cleanup;
    const path = join(tmp.dir, "session.sqlite");
    const open = async (cwd: string): Promise<Session> =>
      openSession(await openNodeSqliteStorage(path), {
        models: fauxModels([]),
        registry: registryOf([]),
        agent: { model: FAUX_MODEL, cwd },
        profile: "room",
        log: () => undefined,
        env: nodeEnv,
      });
    await (await open("/first")).harness.close(context);
    const second = await open("/second");
    expect((await second.root.agent(context)).cwd).toBe("/second");
    await second.harness.close(context);
  });

  /**
   * DEC-042: `afterFailedRun: continue` starts the next run with the inputs queued
   * behind a failed one, so an operator input queued behind a `model_error` turn is
   * answered with nothing else submitting (design § "A failed run continues").
   */
  it("an operator input queued behind a failed run is answered in the next run", async () => {
    const { faux, models } = scriptedModels();
    const failing = failingOnce();
    faux.setResponses([failing.step, fauxAssistantMessage([fauxText("ok")])]);
    const session = await openSession(new MemoryStorage(), {
      models,
      registry: registryOf([]),
      agent: { model: FAUX_MODEL, cwd: process.cwd() },
      profile: "room",
      log: () => undefined,
      env: nodeEnv,
    });

    const foreground = await session.root.submit({ type: "input", content: "foreground" }, context);
    await failing.reached;
    await session.root.submit(
      { type: "input", content: "queued", whenBusy: "followUp", requestId: "operator:queued" },
      context,
    );

    failing.release();
    const answered = await foreground.wait(context);
    expect(answered.status).toBe("unanswered");
    expect(answered.reason).toBe("model_error");
    // No further input: the failed run's successor answers the queued one.
    await vi.waitFor(async () => {
      const queued = await submissionOf(session.harness, session.root.id, "operator:queued");
      expect(queued?.status).toBe("done");
    }, WAIT);
    expect(faux.state.callCount).toBe(2);
    const { messages } = await session.root.context(context);
    expect(messages.map(userText)).toContain("queued");
    await session.harness.close(context);

    expect(DAEMON_SETTINGS).toEqual({ afterFailedRun: "continue", followUpMode: "one-at-a-time" });
  });

  it("runs the agent's tools in the environment its env hook gives, at the agent's cwd", async () => {
    const tmp = await tempDir();
    cleanup = tmp.cleanup;
    const { faux, models } = scriptedModels();
    faux.setResponses(callThenAnswer("bash", { command: "pwd" }, "done"));
    const asked: (string | undefined)[] = [];
    const session = await openSession(new MemoryStorage(), {
      models,
      registry: registryOf([CodingTools]),
      agent: { model: FAUX_MODEL, cwd: tmp.dir },
      env: (state) => {
        asked.push(state.cwd);
        return nodeEnv(state);
      },
      profile: "room",
      log: () => undefined,
    });

    await (await session.root.submit({ type: "input", content: "go" }, context)).wait(context);
    const [result] = await toolResults(session.harness);
    await session.harness.close(context);

    expect(asked).toContain(tmp.dir);
    expect(result === undefined ? "" : textOf(result)).toContain(tmp.dir);
  });

  /**
   * Leave a turn in flight after `alpha` was pinned, then reopen it against
   * `reopen` and return the tool results of the resumed call.
   */
  async function resumePinnedAlpha(reopen: Registry): Promise<string[]> {
    const tmp = await tempDir();
    try {
      const path = join(tmp.dir, "session.sqlite");
      const held = heldCall();
      const scripted = scriptedModels();
      scripted.faux.setResponses([held.step]);
      const first = await openSession(await openNodeSqliteStorage(path), {
        models: scripted.models,
        registry: satanWith("first"),
        agent: { model: FAUX_MODEL, cwd: tmp.dir },
        profile: "room",
        log: () => undefined,
        env: nodeEnv,
      });
      // The first provider step blocks, so the close leaves the turn in `request`.
      try {
        await first.root.submit({ type: "input", content: "go" }, context);
        await held.started;
      } finally {
        await first.harness.close(context);
      }

      const again = scriptedModels();
      again.faux.setResponses(callThenAnswer("alpha", {}, "done"));
      const second = await openSession(await openNodeSqliteStorage(path), {
        models: again.models,
        registry: reopen,
        agent: { model: FAUX_MODEL, cwd: tmp.dir },
        profile: "room",
        log: () => undefined,
        env: nodeEnv,
      });
      try {
        await second.harness.waitForIdle(context);
        return (await toolResults(second.harness)).map(textOf);
      } finally {
        await second.harness.close(context);
      }
    } finally {
      await tmp.cleanup();
    }
  }

  it("resumes a turn whose pinned tool call executes against the registry given at reopen", async () => {
    expect(await resumePinnedAlpha(satanWith("second"))).toEqual(["second"]);
  });

  it("settles the resumed call as tool_unavailable when the reopen registry lacks the tool", async () => {
    const results = await resumePinnedAlpha(registryOf([]));
    expect(results).toHaveLength(1);
    expect(results[0]).toContain("Tool alpha is not available");
  });

  describe("now and beforeResume", () => {
    const HOUR = 3_600_000;
    const START = 1_000_000;

    /** Sleeps until `at` on the harness clock, then records that its phase ran. */
    type Sleeper = { phase: "sleep"; at: number } | { phase: "wake" };
    const sleeperTask = (ran: string[]): Task<{ at: number }, Sleeper, null, object> =>
      defineTask<{ at: number }, Sleeper, null>({
        name: "sleeper",
        version: 1,
        initial: (input) => ({ phase: "sleep", at: input.at }),
        phases: {
          sleep: (task, runtime, ctx) =>
            runtime.sleepUntil(task.state.checkpoint.at, { phase: "wake" }, ctx),
          wake: async (_task, runtime, ctx) => {
            ran.push("phase");
            await runtime.commit(
              () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
              ctx,
            );
          },
        },
        abort: () => Promise.resolve(),
      });

    it("sleeps on the given clock and calls beforeResume after the backfill, before any task phase", async () => {
      const tmp = await tempDir();
      cleanup = tmp.cleanup;
      const path = join(tmp.dir, "session.sqlite");
      const clock = fakeClock(START);
      const ran: string[] = [];
      const task = sleeperTask(ran);
      const registry = registryOf([defineExtension({ name: "sleepers", tasks: [task] })]);
      // A store from before the index: its root conversation is indexed by the backfill alone.
      const old = await openFauxHarness(await openNodeSqliteStorage(path), {
        registry,
        resume: false,
      });
      const rootId = old.root.id;
      await old.harness.commit(
        (tx) =>
          tx.createTask(
            task,
            { at: START + HOUR },
            { ownership: { kind: "conversation" }, conversationId: rootId, background: true },
          ),
        context,
      );
      await old.harness.close(context);

      const seen: { ran: number; indexed: Promise<unknown> }[] = [];
      let handed: Session | undefined;
      const open = async (): Promise<Session> =>
        openSession(await openNodeSqliteStorage(path), {
          models: fauxModels([]),
          registry,
          agent: { model: FAUX_MODEL, cwd: tmp.dir },
          profile: "room",
          log: () => undefined,
          env: nodeEnv,
          now: clock.now,
          beforeResume: (session) => {
            handed = session;
            seen.push({ ran: ran.length, indexed: indexOf(session.harness) });
          },
        });

      // Real time is long past START + HOUR: only `now` keeps the task asleep.
      const first = await open();
      await vi.waitFor(async () => {
        const { tasks } = await first.harness.inspect(context);
        expect(tasks.map((t) => t.state)).toEqual([{ kind: "sleeping", until: START + HOUR }]);
      });
      await first.harness.close(context);
      expect(handed).toBe(first);
      expect(ran).toEqual([]);
      expect(JSON.stringify(await seen[0]?.indexed)).toContain(String(rootId));

      // Due on the fake clock: reopening runs it, after beforeResume.
      clock.advance(HOUR);
      const second = await open();
      await vi.waitFor(() => {
        expect(ran).toEqual(["phase"]);
      });
      await second.harness.close(context);
      expect(seen.map((s) => s.ran)).toEqual([0, 0]);
    });
  });
});

/**
 * Startup reconcile (design sec-3 "Startup reconcile"; plan VT-1 = design VT-5,
 * VT-2 = design VT-3's root part): it runs in `openSession` after the backfill and
 * before `resume()`, refuses forks and task-owned conversations, backfills an
 * entry's toolset, and re-derives every stored list from its toolset.
 */
describe("startup reconcile", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(() => cleanup?.());

  /** A fresh tempDir store path, and its directory (the agent cwd). */
  const store = async (): Promise<{ path: string; dir: string }> => {
    const tmp = await tempDir();
    cleanup = tmp.cleanup;
    return { path: join(tmp.dir, "session.sqlite"), dir: tmp.dir };
  };

  /** `openSession` on `path`, with the reconcile's profile and log. */
  const open = async (
    path: string,
    dir: string,
    profile: Profile,
    log: Log = () => undefined,
  ): Promise<Session> =>
    openSession(await openNodeSqliteStorage(path), {
      models: fauxModels([]),
      registry: registryOf([]),
      agent: { model: FAUX_MODEL, cwd: dir },
      env: nodeEnv,
      profile,
      log,
    });

  /** A harness opened the way `openSession` opens one, but without the reconcile. */
  const rawStore = async (path: string): Promise<TestHarness> =>
    openFauxHarness(await openNodeSqliteStorage(path), {
      conversationCreated: indexConversation,
      resume: false,
    });

  /** `id`'s stored agent selection: what a reconcile writes in step 3. */
  const storedExtensions = (harness: Session["harness"], id: ConversationId): Promise<unknown> =>
    harness.commit(async (tx) => {
      const extensions = (await tx.doc(AgentDoc, id)).extensions;
      // Materialized inside the commit: a draft's value is a settled overlay afterwards.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- a JSON round-trip, typed as the caller's unknown
      return extensions === undefined ? undefined : JSON.parse(JSON.stringify(extensions));
    }, context);

  /** `id`'s index entry's toolset, as any index reader sees it. */
  const entryToolset = async (
    harness: Session["harness"],
    id: ConversationId,
  ): Promise<string | undefined> => storedEntry(await readIndex(harness), id)?.toolset;

  it("backfills an entry written without a toolset with the profile default", async () => {
    const { path, dir } = await store();
    const raw = await rawStore(path);
    const rootId = raw.root.id;
    expect(await entryToolset(raw.harness, rootId)).toBeUndefined();
    await raw.harness.close(context);

    const session = await open(path, dir, "host");
    expect(await entryToolset(session.harness, rootId)).toBe(PROFILE_TOOLSETS.host.default);
    await session.harness.close(context);
  });

  it("re-derives a conversation's list from its toolset, logs the change once, then stays quiet", async () => {
    const { path, dir } = await store();
    const first = await open(path, dir, "room");
    const conversation = await createConversation(first.harness);
    const id = conversation.id;
    await conversation.configure({ extensions: selectionOf(["persona"]) }, context);
    await first.harness.close(context);

    const changed = vi.fn<Log>();
    const second = await open(path, dir, "room", changed);
    expect(await storedExtensions(second.harness, id)).toEqual([
      ...toolsetList("interactive", "room"),
    ]);
    expect(changed).toHaveBeenCalledWith(
      `conversation ${String(id)}: toolset interactive list changed`,
    );
    await second.harness.close(context);

    const quiet = vi.fn<Log>();
    const third = await open(path, dir, "room", quiet);
    expect(quiet).not.toHaveBeenCalled();
    await third.harness.close(context);
  });

  it("a stored bridge entry and topic: toolset bridge retired, now interactive, the list re-derived, a second start quiet", async () => {
    const { path, dir } = await store();
    const raw = await rawStore(path);
    const rootId = raw.root.id;
    // What SL-009 stored: a bridge entry, a bridge topic, and the old bridge list (interactive
    // without threads). The retirement rewrites both and re-derives the entry's list.
    const bridgeList = toolsetList("interactive", "room").filter((name) => name !== "threads");
    await raw.root.configure({ extensions: selectionOf(bridgeList) }, context);
    await raw.harness.commit(async (tx) => {
      const index = await tx.doc(IndexDocument);
      index.conversations[String(rootId)] = { topic: "default", toolset: "bridge" };
      index.topics["proj-bridge"] = { toolset: "bridge" };
    }, context);
    await raw.harness.close(context);

    const retired = vi.fn<Log>();
    const second = await open(path, dir, "room", retired);
    expect(await entryToolset(second.harness, rootId)).toBe("interactive");
    expect((await readIndex(second.harness)).topics["proj-bridge"]?.toolset).toBe("interactive");
    expect(await storedExtensions(second.harness, rootId)).toEqual([
      ...toolsetList("interactive", "room"),
    ]);
    expect(retired).toHaveBeenCalledWith(
      "topic proj-bridge: toolset bridge retired, now interactive",
    );
    expect(retired).toHaveBeenCalledWith(
      `conversation ${String(rootId)}: toolset interactive list changed`,
    );
    await second.harness.close(context);

    const quiet = vi.fn<Log>();
    const third = await open(path, dir, "room", quiet);
    expect(quiet).not.toHaveBeenCalled();
    await third.harness.close(context);
  });

  it("refuses a topic whose toolset the profile does not allow", async () => {
    const { path, dir } = await store();
    const raw = await rawStore(path);
    await writeTopicRecord(raw.harness, "inbox", { toolset: "mail" });
    await raw.harness.close(context);

    await expect(open(path, dir, "host")).rejects.toThrow(
      "topic inbox: toolset mail is not allowed on profile host",
    );
  });

  it("refuses an entry whose toolset the profile does not allow", async () => {
    const { path, dir } = await store();
    const raw = await rawStore(path);
    const rootId = raw.root.id;
    await raw.harness.commit(async (tx) => {
      writeEntry(await tx.doc(IndexDocument), rootId, { topic: "default", toolset: "mail" });
    }, context);
    await raw.harness.close(context);

    await expect(open(path, dir, "host")).rejects.toThrow(
      `conversation ${String(rootId)}: toolset mail is not allowed on profile host`,
    );
  });

  it("a fork without a toolset is not supported", async () => {
    const { path, dir } = await store();
    const raw = await rawStore(path);
    const rootId = raw.root.id;
    // The hook copies a fork's toolset, so the store is made to hold one without.
    const parent = await createConversation(raw.harness);
    await raw.harness.commit(async (tx) => {
      writeEntry(await tx.doc(IndexDocument), parent.id, {
        topic: "default",
        toolset: "interactive",
      });
    }, context);
    const forked = await forkConversation(raw.harness, parent);
    // Strip both entries' toolset: the fork's to reach the refusal, the parent's so
    // nothing but the reconcile's backfill could give either one back.
    await raw.harness.commit(async (tx) => {
      const index = await tx.doc(IndexDocument);
      index.conversations[String(forked.id)] = { topic: "default", parent: parent.id };
      index.conversations[String(parent.id)] = { topic: "default" };
    }, context);
    await raw.harness.close(context);

    await expect(open(path, dir, "room")).rejects.toThrow(
      `conversation ${String(forked.id)}: a fork without a toolset is not supported`,
    );

    // The refusal threw, so the reconcile's backfill and list writes rolled back.
    const reopened = await rawStore(path);
    expect(await storedExtensions(reopened.harness, forked.id)).toBeUndefined();
    expect(await entryToolset(reopened.harness, rootId)).toBeUndefined();
    expect(await entryToolset(reopened.harness, parent.id)).toBeUndefined();
    await reopened.harness.close(context);
  });

  it("opens a store holding a fork with a toolset", async () => {
    const { path, dir } = await store();
    const raw = await rawStore(path);
    const parent = await createConversation(
      raw.harness,
      topicInit("room", "work", FAUX_CATALOG, FAUX_MODEL),
    );
    const forked = await forkConversation(raw.harness, parent);
    await raw.harness.close(context);

    const session = await open(path, dir, "room");
    expect(await entryToolset(session.harness, forked.id)).toBe(PROFILE_TOOLSETS.room.default);
    await session.harness.close(context);
  });

  it("refuses a task-owned conversation, names it, and leaves root's entry unbackfilled", async () => {
    const { path, dir } = await store();
    const raw = await rawStore(path);
    const rootId = raw.root.id;
    const owned = await createTaskOwned(raw);
    await raw.harness.close(context);

    await expect(open(path, dir, "room")).rejects.toThrow(
      `conversation ${String(owned)}: task-owned conversations are not supported`,
    );

    const reopened = await rawStore(path);
    expect(await storedExtensions(reopened.harness, owned)).toBeUndefined();
    expect(await entryToolset(reopened.harness, rootId)).toBeUndefined();
    await reopened.harness.close(context);
  });

  it.each(["room", "host"] as const)(
    "gives root the %s profile's default toolset list after a restart",
    async (profile) => {
      const { path, dir } = await store();
      const first = await open(path, dir, profile);
      await first.harness.close(context);

      const second = await open(path, dir, profile);
      expect(await storedExtensions(second.harness, second.root.id)).toEqual([
        ...toolsetList(PROFILE_TOOLSETS[profile].default, profile),
      ]);
      await second.harness.close(context);
    },
  );

  it("overrides root's configured list on restart (negative control)", async () => {
    const { path, dir } = await store();
    const first = await open(path, dir, "room");
    await first.root.configure({ extensions: selectionOf(["persona"]) }, context);
    await first.harness.close(context);

    const second = await open(path, dir, "room");
    expect(await storedExtensions(second.harness, second.root.id)).toEqual([
      ...toolsetList("interactive", "room"),
    ]);
    await second.harness.close(context);
  });

  it("types SessionOptions.agent without extensions, so no caller writes root's list", () => {
    const options: SessionOptions = {
      models: fauxModels([]),
      registry: registryOf([]),
      // @ts-expect-error openSession must not write root's list: the reconcile alone does.
      agent: { model: FAUX_MODEL, extensions: selectionOf(["persona"]) },
      env: nodeEnv,
      profile: "room",
      log: () => undefined,
    };
    expect(options).toBeDefined();
  });
});
