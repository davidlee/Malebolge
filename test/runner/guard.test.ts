// The guard's early path check (EX-4, DEC-060): write/edit outside the job's
// allowlist is blocked before it runs and audited as `blocked_tool`. Authority
// stays at collection: read and bash pass. The hook runs on a harness sharing
// the runner store's SQLite handle, so these tests also show its audit write
// settles from inside `beforeTool` (EVD-008, PHASE-07 STOP 4).

import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { Harness, JsonObject } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { afterEach, describe, expect, it } from "vitest";
import { context } from "../../src/context.ts";
import { conversationText } from "../../src/runner/durable-ids.ts";
import { type GuardedJob, jobGuard, repoPath } from "../../src/runner/guard.ts";
import type { JobEvent } from "../../src/runner/rows.ts";
import { openRunnerStore, type RunnerStore } from "../../src/runner/store.ts";
import { JobTools } from "../../src/runner/tools.ts";
import { tempDir } from "../fixtures.ts";
import { callThenAnswer, openFauxHarness, textOf, toolResults } from "../harness-fixture.ts";
import { closeHarness, within } from "./runner-fixture.ts";
import { NEW_JOB, sequentialIds, T0 } from "./store-fixture.ts";

const ROOT = "/work/repos/satan";

describe("repoPath: a tool's path argument as collection would see it", () => {
  it.each([
    ["src/a.ts", "src/a.ts"],
    ["./src/a.ts", "src/a.ts"],
    ["src/../src/a.ts", "src/a.ts"],
    ["src//a.ts", "src/a.ts"],
    [`${ROOT}/src/a.ts`, "src/a.ts"],
    ["@src/a.ts", "src/a.ts"],
    ["src/a b.ts", "src/a b.ts"],
    ["../other/a.ts", "../other/a.ts"],
    ["/etc/passwd", "../../../etc/passwd"],
    [ROOT, ""],
  ])("%j is %j", (argument, expected) => {
    expect(repoPath(argument, ROOT)).toBe(expected);
  });

  it.each(["~", "~/a.ts", "file:///work/repos/satan/a.ts"])(
    "%j resolves outside the guard's knowledge: none",
    (argument) => {
      expect(repoPath(argument, ROOT)).toBeUndefined();
    },
  );
});

interface GuardWorld {
  harness: Harness;
  store: RunnerStore;
  dir: string;
  jobId: string;
  run: (tool: string, args: JsonObject) => Promise<string>;
  events: () => Promise<JobEvent[]>;
}

describe("the guard hook", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  /**
   * A faux run over a local environment rooted at a temp dir, the runner store
   * and pi on one SQLite file. `owns` decides whether the root conversation is
   * the job's.
   */
  async function guardWorld(owns = true): Promise<GuardWorld> {
    const tmp = await tempDir();
    const dir = join(tmp.dir, "repo");
    await mkdir(join(dir, "src"), { recursive: true });
    const store = await openRunnerStore(join(tmp.dir, "runner.sqlite"), {
      newId: sequentialIds(),
    });
    const { job } = await store.jobs.submit(NEW_JOB, T0);
    let rootText = "";
    const guard = jobGuard({
      jobs: store.jobs,
      now: () => T0 + 1,
      currentJob: (conversationId): GuardedJob | undefined =>
        owns && conversationId === rootText
          ? { id: job.id, allowedPaths: job.allowedPaths, root: dir }
          : undefined,
    });
    const { harness, root, faux } = await openFauxHarness(store.storage, {
      extensions: [JobTools, guard],
      env: () => new NodeExecutionEnv({ cwd: dir }),
    });
    rootText = conversationText(root.id);
    close = async (): Promise<void> => {
      await closeHarness(harness);
      await tmp.cleanup();
    };
    async function run(tool: string, args: JsonObject): Promise<string> {
      faux.setResponses(callThenAnswer(tool, args, "done"));
      const submission = await root.submit({ type: "input", content: "go" }, context);
      await within(10_000, "run", submission.wait(context));
      const result = (await toolResults(harness)).at(-1);
      return result === undefined ? "" : textOf(result);
    }
    return {
      harness,
      store,
      dir,
      jobId: job.id,
      run,
      events: () => store.jobs.events(job.id),
    };
  }

  const blocked = async (world: GuardWorld): Promise<JobEvent[]> =>
    (await world.events()).filter((event) => event.kind === "blocked_tool");

  it.each([
    ["write", { path: "src/a.ts", content: "x" }],
    ["write", { path: "./src/a.ts", content: "x" }],
  ])("lets %s inside the allowlist run, unaudited", async (tool, args) => {
    const world = await guardWorld();

    await world.run(tool, args);

    expect(await readFile(join(world.dir, "src/a.ts"), "utf8")).toBe("x");
    expect(await blocked(world)).toEqual([]);
  });

  it("blocks a write outside the allowlist before it runs, and audits it", async () => {
    const world = await guardWorld();

    const text = await world.run("write", { path: "README.md", content: "x" });

    expect(text).toContain("Tool call blocked");
    expect(text).toContain("README.md");
    await expect(stat(join(world.dir, "README.md"))).rejects.toThrow();
    expect((await blocked(world)).map((event) => event.payload)).toEqual([
      { tool: "write", path: "README.md", repoPath: "README.md" },
    ]);
  });

  it("blocks an edit escaping the repo by an absolute path", async () => {
    const world = await guardWorld();

    const text = await world.run("edit", {
      path: join(world.dir, "..", "outside.txt"),
      edits: [{ oldText: "a", newText: "b" }],
    });

    expect(text).toContain("Tool call blocked");
    expect((await blocked(world)).map((event) => event.payload["tool"])).toEqual(["edit"]);
  });

  it("blocks a file: URL write, whose target it cannot place, audited without a repo path", async () => {
    const world = await guardWorld();
    const url = `file://${world.dir}/src/a.ts`;

    const text = await world.run("write", { path: url, content: "x" });

    expect(text).toContain("Tool call blocked");
    await expect(stat(join(world.dir, "src/a.ts"))).rejects.toThrow();
    expect((await blocked(world)).map((event) => event.payload)).toEqual([
      { tool: "write", path: url },
    ]);
  });

  it("passes read and bash: authority stays at collection", async () => {
    const world = await guardWorld();

    await world.run("bash", { command: "echo y > README.md" });
    await world.run("read", { path: "README.md" });

    expect(await readFile(join(world.dir, "README.md"), "utf8")).toBe("y\n");
    expect(await blocked(world)).toEqual([]);
  });

  it("blocks write in a conversation no job owns, with nothing to audit", async () => {
    const world = await guardWorld(false);

    const text = await world.run("write", { path: "src/a.ts", content: "x" });

    expect(text).toContain("Tool call blocked");
    await expect(stat(join(world.dir, "src/a.ts"))).rejects.toThrow();
    expect(await blocked(world)).toEqual([]);
  });

  it("refuses in words pi-ai does not classify as retryable", async () => {
    const world = await guardWorld();

    const text = await world.run("write", { path: "README.md", content: "x" });

    expect(text).toContain("Tool call blocked");
    const asError = fauxAssistantMessage([], { stopReason: "error", errorMessage: text });
    expect(isRetryableAssistantError(asError)).toBe(false);
  });
});
