import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { context } from "../../src/context.ts";
import { isRecord } from "../../src/json.ts";
import { StartRefused } from "../../src/runner/errors.ts";
import {
  type RoomAccess,
  type Runner,
  type StartOptions,
  startRunner,
} from "../../src/runner/start.ts";
import { openRunnerStore } from "../../src/runner/store.ts";
import { connectUnix } from "../../src/unix-socket.ts";
import { tempDir } from "../fixtures.ts";
import { fauxModels } from "../harness-fixture.ts";
import { variant } from "./config-fixture.ts";
import { controlClient, errorCode } from "./control-fixture.ts";
import { localConnection } from "./env-fixture.ts";
import { tempRepo } from "./git-fixture.ts";
import { roomWorld } from "./room-fixture.ts";
import { within } from "./runner-fixture.ts";
import { NEW_JOB, T0 } from "./store-fixture.ts";

type Env = Record<string, string | undefined>;

interface Host {
  env: Env;
  dir: string;
  promptFile: string;
  configFile: string;
  /** Writes the runner config; `edit` changes the example's text first. */
  writeConfig: (edit?: (toml: string) => string) => Promise<void>;
}

/** A temp HOME holding a runner config, a prompt file and a repo; the runner's env. */
async function host(): Promise<Host> {
  const { dir, cleanup } = await tempDir();
  onTestFinished(cleanup);
  const repo = tempRepo();
  const promptFile = join(dir, "patch-agent.md");
  const configFile = join(dir, "runner.toml");
  await writeFile(promptFile, "You are the patch agent.\n");
  await mkdir(join(dir, "run"), { mode: 0o700 });
  const writeConfig = async (edit: (toml: string) => string = (toml) => toml): Promise<void> => {
    const toml = variant('path = "~/dev/satan"', `path = "${repo.path}"`).replace(
      'prompt_file = "~/corpus/prompts/patch-agent.md"',
      `prompt_file = "${promptFile}"`,
    );
    await writeFile(configFile, edit(toml));
  };
  await writeConfig();
  const env: Env = {
    HOME: dir,
    XDG_RUNTIME_DIR: join(dir, "run"),
    XDG_STATE_HOME: join(dir, "state"),
    SATAN_RUNNER_CONFIG: configFile,
  };
  return { env, dir, promptFile, configFile, writeConfig };
}

async function start(env: Env, options: Partial<StartOptions> = {}): Promise<Runner> {
  const runner = await startRunner(env, {
    models: fauxModels().models,
    log: () => undefined,
    ...options,
  });
  onTestFinished(() => runner.close());
  return runner;
}

/** What `startRunner` refused with; fails if it started or threw anything else. */
async function refusal(env: Env): Promise<string> {
  const started = startRunner(env, { models: fauxModels().models, log: () => undefined });
  await expect(started).rejects.toBeInstanceOf(StartRefused);
  return started.then(
    () => "started",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

describe("startRunner refuses to start (I13)", () => {
  it("refuses when the prompt_file is missing, naming prompt_file and the path", async () => {
    const { env, promptFile, writeConfig } = await host();
    await writeConfig((toml) => toml.replace(promptFile, `${promptFile}.gone`));
    const message = await refusal(env);
    expect(message).toContain("prompt_file");
    expect(message).toContain(`${promptFile}.gone`);
  });

  it("refuses when the prompt_file is not a regular file", async () => {
    const { env, dir, promptFile, writeConfig } = await host();
    await writeConfig((toml) => toml.replace(promptFile, dir));
    expect(await refusal(env)).toContain("prompt_file");
  });

  it("refuses an unparsable or invalid config, carrying the parser's message", async () => {
    const { env, writeConfig } = await host();
    await writeConfig(() => "enabled = \n");
    expect(await refusal(env)).toMatch(/config.*not valid TOML/);
    await writeConfig((toml) => toml.replace("enabled = true", 'enabled = "yes"'));
    expect(await refusal(env)).toMatch(/enabled/);
  });

  it("refuses when SATAN_RUNNER_CONFIG is unset or names no file", async () => {
    const { env } = await host();
    expect(await refusal({ ...env, SATAN_RUNNER_CONFIG: undefined })).toContain(
      "SATAN_RUNNER_CONFIG",
    );
    expect(
      await refusal({ ...env, SATAN_RUNNER_CONFIG: `${env["SATAN_RUNNER_CONFIG"] ?? ""}.x` }),
    ).toContain("runner.toml.x");
  });

  it("refuses without XDG_RUNTIME_DIR, for there is no place for its socket", async () => {
    const { env } = await host();
    expect(await refusal({ ...env, XDG_RUNTIME_DIR: undefined })).toContain("XDG_RUNTIME_DIR");
  });

  it("refuses a [door] the execution environment cannot use, naming the missing key", async () => {
    const { env, writeConfig } = await host();
    await writeConfig((toml) => toml.replace('host = "10.99.0.2"\n', ""));
    expect(await refusal(env)).toContain("host");
  });

  it("refuses a second runner on the same socket", async () => {
    const { env } = await host();
    await start(env);
    expect(await refusal(env)).toContain("already serves");
  });
});

describe("startRunner serves", () => {
  it("opens the store under XDG_STATE_HOME and answers on the control socket, until closed", async () => {
    const { env, dir } = await host();
    const runner = await start(env);
    expect(runner.paths).toMatchObject({
      store: join(dir, "state", "satan", "runner", "runner.sqlite"),
      socket: join(dir, "run", "satan-runner", "control.sock"),
    });
    expect((await stat(runner.paths.store)).isFile()).toBe(true);
    const client = await controlClient(runner.paths.socket);
    onTestFinished(client.close);
    expect(errorCode(await client.call("status", { jobId: "pj-404" }))).toBe("unknown_job");
    await runner.close();
    await expect(connectUnix(runner.paths.socket)).rejects.toThrow();
  });

  it("with enabled = false starts, and refuses submit with runner_disabled", async () => {
    const { env, writeConfig } = await host();
    await writeConfig((toml) => toml.replace("enabled = true", "enabled = false"));
    const runner = await start(env);
    const client = await controlClient(runner.paths.socket);
    onTestFinished(client.close);
    const response = await client.call("submit", {
      submissionId: "s",
      mode: "fix",
      directive: "d",
      repo: "satan",
      allowedPaths: ["src/"],
    });
    expect(errorCode(response)).toBe("runner_disabled");
    expect(await client.call("list")).toMatchObject({ ok: true, jobs: [] });
  });
});

describe("startRunner runs jobs (B2.2)", () => {
  /**
   * A host whose repo is a room world's, its runner store holding one queued
   * job before start, and the way into the room faked: the slot's channel and a
   * local pi-env daemon in the guest clone.
   */
  async function queuedHost(enabled: boolean): Promise<{
    env: Env;
    jobId: string;
    room: RoomAccess;
  }> {
    const { env, dir, writeConfig } = await host();
    const world = roomWorld({ guestAtClone: true });
    await writeConfig((toml) =>
      toml
        .replace(/^path = ".*"$/m, `path = "${world.real.path}"`)
        .replace('guest_path = "/work/repos/satan"', `guest_path = "${world.room.path}"`)
        .replace('model = "gateway/test-model"', 'model = "faux/faux-1"')
        .replace("enabled = true", `enabled = ${String(enabled)}`),
    );
    const stateDir = join(dir, "state", "satan", "runner");
    await mkdir(stateDir, { recursive: true });
    const store = await openRunnerStore(join(stateDir, "runner.sqlite"));
    const { job } = await store.jobs.submit(NEW_JOB, T0);
    await store.storage.close(context);
    return { env, jobId: job.id, room: { channel: world.channel, connect: localConnection } };
  }

  it("with enabled = true drains a job queued before it started, through the model", async () => {
    const { env, jobId, room } = await queuedHost(true);
    const { faux, models } = fauxModels();
    faux.setResponses([fauxAssistantMessage([fauxText("nothing to do")])]);

    const runner = await start(env, { models, room });
    const client = await controlClient(runner.paths.socket);
    onTestFinished(client.close);
    await client.call("watch");
    const frame = await within(
      20_000,
      "the queued job",
      client.next((message) => {
        const job = message["job"];
        return isRecord(job) && job["jobId"] === jobId && job["state"] === "failed";
      }),
    );

    expect(frame["job"]).toMatchObject({ endReason: "completed", class: "no_changes" });
    expect(faux.state.callCount).toBe(1);
    // The model gate sits in front of the catalog and counted the request.
    expect(await client.call("result", { jobId })).toMatchObject({
      usage: { modelRequests: 1 },
    });
  });

  it("with enabled = false leaves a queued job untouched: no conversation, no model call", async () => {
    const { env, jobId, room } = await queuedHost(false);
    const { faux, models } = fauxModels();

    const runner = await start(env, { models, room });
    const client = await controlClient(runner.paths.socket);
    onTestFinished(client.close);

    expect(await client.call("status", { jobId })).toMatchObject({
      ok: true,
      job: { jobId, state: "queued" },
    });
    await runner.close();
    const store = await openRunnerStore(runner.paths.store);
    onTestFinished(() => store.storage.close(context));
    expect((await store.jobs.get(jobId))?.conversationId).toBeUndefined();
    expect(faux.state.callCount).toBe(0);
  });
});
