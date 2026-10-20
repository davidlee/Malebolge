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
  defineExtension,
  defineTool,
  MemoryStorage,
  type Registry,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { afterEach, describe, expect, it } from "vitest";
import { context } from "../src/context.ts";
import { registryOf } from "../src/registry.ts";
import { openSession, type Session } from "../src/session.ts";
import { tempDir } from "./fixtures.ts";
import {
  callThenAnswer,
  FAUX_MODEL,
  fauxModels as scriptedModels,
  textOf,
  toolResults,
} from "./harness-fixture.ts";

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
        env: nodeEnv,
      });
    await (await open("/first")).harness.close(context);
    const second = await open("/second");
    expect((await second.root.agent(context)).cwd).toBe("/second");
    await second.harness.close(context);
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
});
