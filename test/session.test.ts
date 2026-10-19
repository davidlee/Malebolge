import { join } from "node:path";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { afterEach, describe, expect, it } from "vitest";
import { context } from "../src/context.ts";
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
        extensions: [],
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
        extensions: [],
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
      extensions: [CodingTools],
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
});
