// A job's run end to end (VT-1; EX-2, EX-5): pi-durable driven by the faux
// provider, the runner store and pi sharing one SQLite handle (EVD-008), the
// job's tools and guard running through a local pi-env daemon in the room's
// clone, and the fake slot's channel refreshing and collecting that clone.
// The scheduler seats each job; `runJob` is what it runs.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  type FauxProviderHandle,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { Conversation, Harness, JsonObject, Submission } from "@earendil-works/pi-durable";
import { describe, expect, it, onTestFinished } from "vitest";
import { context } from "../../src/context.ts";
import { retryPendingCollection } from "../../src/runner/collect.ts";
import type { Ceilings, RunnerConfig } from "../../src/runner/config.ts";
import { harnessConversations, jobConversation } from "../../src/runner/conversations.ts";
import { conversationIdOf } from "../../src/runner/durable-ids.ts";
import { gitQuarantineReader } from "../../src/runner/git.ts";
import { jobGuard } from "../../src/runner/guard.ts";
import {
  createModelGate,
  type GateDeps,
  gatedModels,
  harnessUsage,
} from "../../src/runner/model-gate.ts";
import type { GitChannel } from "../../src/runner/room.ts";
import { type RunDeps, runJob } from "../../src/runner/run.ts";
import { createScheduler, RunControl, type Scheduler } from "../../src/runner/scheduler.ts";
import { openRunnerStore, type Job, type JobEvent, type JobStore } from "../../src/runner/store.ts";
import { roomTenancy } from "../../src/runner/tenancy.ts";
import { JobTools } from "../../src/runner/tools.ts";
import { openFauxHarness, textOf, toolResults } from "../harness-fixture.ts";
import { exampleConfig } from "./config-fixture.ts";
import { localConnection } from "./env-fixture.ts";
import { type RoomWorld, roomWorld } from "./room-fixture.ts";
import { blockingTool, type BlockingTool, closeHarness, within } from "./runner-fixture.ts";
import { NEW_JOB, sequentialIds, T0 } from "./store-fixture.ts";

const SETTLE_MS = 20_000;

/** Commits whatever the agent changed, in the clone, with git's config isolated. */
const COMMIT =
  "export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1; git add -A && " +
  "git -c user.name=Agent -c user.email=agent@example.invalid -c commit.gpgsign=false " +
  "commit --quiet --no-verify -m change";

let calls = 0;
const call = (tool: string, args: JsonObject): AssistantMessage =>
  fauxAssistantMessage([fauxToolCall(tool, args, { id: `call-${String(++calls)}` })], {
    stopReason: "toolUse",
  });
const answer = (text = "done"): AssistantMessage => fauxAssistantMessage([fauxText(text)]);

/** A channel whose `refresh` waits at a gate the test opens. */
interface GatedChannel {
  channel: GitChannel;
  /** Resolves once a refresh is waiting. */
  waiting: Promise<void>;
  open: () => void;
}

function gatedRefresh(inner: GitChannel): GatedChannel {
  let arrived = (): void => undefined;
  let open = (): void => undefined;
  const waiting = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  async function refresh(...args: Parameters<GitChannel["refresh"]>): Promise<string> {
    arrived();
    await gate;
    return inner.refresh(...args);
  }
  return { channel: { ...inner, refresh }, waiting, open };
}

/** `submission` whose `wait` fails as a broken harness would; all else passes through. */
function failingWait(submission: Submission): Submission {
  return new Proxy(submission, {
    get(target, key): unknown {
      if (key === "wait") {
        return (): Promise<never> => Promise.reject(new Error("harness storage gone"));
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
}

/** `conversation` whose submissions fail to settle. */
function failingSettle(conversation: Conversation): Conversation {
  return new Proxy(conversation, {
    get(target, key): unknown {
      if (key === "submit") {
        return async (...args: Parameters<Conversation["submit"]>): Promise<Submission> =>
          failingWait(await target.submit(...args));
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
}

interface RunWorldOptions {
  /** The room's `max_room_wait`, seconds. */
  maxRoomWaitS?: number;
  channel?: (channel: GitChannel) => GitChannel;
  /** The harness `runJob` sees. */
  harness?: (harness: Harness) => RunDeps["harness"];
  /** Submit ceilings of each job `submit` queues, over `NEW_JOB`'s. */
  ceilings?: Partial<Ceilings>;
  /** How the model gate reads usage; default: the harness's `pi.usage`. */
  usageOf?: GateDeps["usageOf"];
}

interface RunWorld extends RoomWorld {
  jobs: JobStore;
  harness: Harness;
  deps: RunDeps;
  scheduler: Scheduler;
  blocking: BlockingTool;
  /** The model: scripted turns, and `state.callCount` its provider requests. */
  faux: FauxProviderHandle;
  /** Queues a job (as submit does) and wakes the scheduler. */
  submit: () => Promise<Job>;
  job: (id: string) => Promise<Job>;
  events: (id: string) => Promise<JobEvent[]>;
  /** The slot verbs the channel ran, e.g. `collect`. */
  verbs: () => string[];
}

/**
 * The run path over `roomWorld({ guestAtClone: true })`: a local daemon runs
 * the job's tools in the room's clone, which the fake slot refreshes and
 * collects.
 */
async function runWorld(options: RunWorldOptions = {}): Promise<RunWorld> {
  const world = roomWorld({ guestAtClone: true });
  const store = await openRunnerStore(":memory:", { newId: sequentialIds() });
  const { jobs } = store;
  let clock = T0;
  const now = (): number => ++clock;
  const tenancy = roomTenancy();
  const blocking = blockingTool("wait");
  const extensions = [
    JobTools,
    jobGuard({ currentJob: tenancy.guarded, jobs, now }),
    blocking.extension,
  ];
  // The model gate as start.ts wires it: built before the harness it sits in.
  const usage = harnessUsage();
  const gate = createModelGate({
    seated: tenancy.seated,
    jobs,
    now,
    usageOf: options.usageOf ?? usage.usageOf,
  });
  const { harness, faux } = await openFauxHarness(store.storage, {
    extensions,
    env: tenancy.env,
    models: (models) => gatedModels(models, gate),
  });
  usage.bind(harness);
  onTestFinished(() => closeHarness(harness));
  const example = exampleConfig();
  const config: RunnerConfig = {
    ...example,
    defaults: { ...example.defaults, model: "faux/faux-1" },
    maxima: { ...example.maxima, maxRoomWaitS: options.maxRoomWaitS ?? 60 },
    repos: new Map([[NEW_JOB.repo, world.repo]]),
  };
  const deps: RunDeps = {
    jobs,
    channel: options.channel?.(world.channel) ?? world.channel,
    quarantine: gitQuarantineReader,
    config,
    harness: options.harness?.(harness) ?? harness,
    conversations: harnessConversations(harness),
    tenancy,
    connect: localConnection,
    extensions,
    readPrompt: () => Promise.resolve("You are the patch agent."),
    now,
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
  };
  const scheduler = createScheduler({
    jobs,
    enabled: true,
    run: (job, control) => runJob(deps, job, control),
    retryPending: (job) => retryPendingCollection(deps, job.id, now()),
    sleep: deps.sleep,
    stop: new AbortController().signal,
    log: () => undefined,
    now,
  });
  let submissions = 0;
  async function submit(): Promise<Job> {
    const { job: queued } = await jobs.submit(
      {
        ...NEW_JOB,
        submissionId: `sub-${String(++submissions)}`,
        ceilings: { ...NEW_JOB.ceilings, ...options.ceilings },
      },
      now(),
    );
    scheduler.wake();
    return queued;
  }
  const job = async (id: string): Promise<Job> => {
    const found = await jobs.get(id);
    if (found === undefined) {
      throw new Error(`no job ${id}`);
    }
    return found;
  };
  return {
    ...world,
    jobs,
    harness,
    deps,
    scheduler,
    blocking,
    faux,
    submit,
    job,
    events: (id) => jobs.events(id),
    verbs: () => world.slot.calls.map((args) => args[1] ?? ""),
  };
}

/** Waits for the scheduler to rest; the job as the run left it. */
async function settled(world: RunWorld, id: string): Promise<Job> {
  await within(SETTLE_MS, "scheduler", world.scheduler.idle());
  return world.job(id);
}

/** Each event as `kind` or `transition:<to>`. */
const kinds = (events: readonly JobEvent[]): string[] =>
  events.map((event) =>
    event.kind === "transition" ? `transition:${String(event.payload["to"])}` : event.kind,
  );

/** The tool results of `job`'s conversation, oldest first. */
async function jobToolResults(world: RunWorld, job: Job): Promise<ToolResultMessage[]> {
  const conversation = await jobConversation(world.harness, job.conversationId ?? "");
  return conversation === undefined ? [] : toolResults(world.harness, conversation);
}

const eventOf = (events: readonly JobEvent[], kind: string): JobEvent | undefined =>
  events.find((event) => kinds([event])[0] === kind);

describe("runJob: submit to review (VT-1)", () => {
  it("a run that writes inside the allowlist and commits ends needs_review", async () => {
    const w = await runWorld();
    w.faux.setResponses([
      call("write", { path: "src/a.ts", content: "export {};\n" }),
      call("bash", { command: COMMIT }),
      answer(),
    ]);

    const queued = await w.submit();
    const job = await settled(w, queued.id);

    expect(job).toMatchObject({ state: "needs_review", endReason: "completed", class: "complete" });
    expect(kinds(await w.events(job.id))).toEqual([
      "submitted",
      "conversation",
      "policy",
      "transition:preparing",
      "refreshed",
      "transition:running",
      "transition:collecting",
      "collected",
      "transition:needs_review",
    ]);
    expect(w.room.git("show", `job/${job.id}:src/a.ts`)).toBe("export {};");
  });

  it("submits the initial prompt with requestId = job id, recorded on running", async () => {
    const w = await runWorld();
    w.faux.setResponses([answer()]);

    const queued = await w.submit();
    const job = await settled(w, queued.id);

    const conversationId = await conversationIdOf(w.harness, job.conversationId ?? "");
    expect(conversationId).toBeDefined();
    const record = await w.harness.commit(
      (tx) =>
        conversationId === undefined ? undefined : tx.submissionByRequest(conversationId, job.id),
      context,
    );
    expect(record?.requestId).toBe(job.id);
    const running = eventOf(await w.events(job.id), "transition:running");
    expect(running?.payload).toMatchObject({ requestId: job.id, submissionId: String(record?.id) });
  });

  it("blocks a write outside the allowlist before it runs: blocked_tool, no file", async () => {
    const w = await runWorld();
    w.faux.setResponses([call("write", { path: "README.md", content: "x" }), answer()]);

    const queued = await w.submit();
    const job = await settled(w, queued.id);

    const [result] = await jobToolResults(w, job);
    expect(result === undefined ? "" : textOf(result)).toContain("Tool call blocked");
    expect(eventOf(await w.events(job.id), "blocked_tool")?.payload).toMatchObject({
      tool: "write",
      path: "README.md",
    });
    expect(w.room.git("show", "HEAD:README")).toBe("README");
    expect(existsSync(join(w.room.path, "README.md"))).toBe(false);
    expect(job).toMatchObject({ state: "failed", class: "no_changes" });
  });
});

describe("runJob: what collection, not the guard, catches (VT-1)", () => {
  it("lets the same out-of-allowlist change through bash; collection fails it path_violation", async () => {
    const w = await runWorld();
    w.faux.setResponses([call("bash", { command: `echo x > README.md && ${COMMIT}` }), answer()]);

    const queued = await w.submit();
    const job = await settled(w, queued.id);

    expect(eventOf(await w.events(job.id), "blocked_tool")).toBeUndefined();
    expect(job).toMatchObject({
      state: "failed",
      class: "path_violation",
      failure: { reason: "path_violation", offending: ["README.md"] },
    });
  });
});

describe("runJob: ending before a turn (EX-2)", () => {
  it("fails room_unavailable once max_room_wait passes with the room down, no model call", async () => {
    const w = await runWorld({ maxRoomWaitS: 5 });
    w.slot.up = false;

    const queued = await w.submit();
    const job = await settled(w, queued.id);

    expect(job).toMatchObject({
      state: "failed",
      endReason: "room_unavailable",
      failure: { reason: "room_unavailable" },
    });
    expect(w.faux.state.callCount).toBe(0);
    expect(w.verbs()).not.toContain("collect");
  });

  it("fails job_branch_moved when job/<id> is already at another oid, never moving it", async () => {
    const w = await runWorld();
    const moved = w.guestJob("pj-1", "src/old.ts");
    w.room.git("switch", "--quiet", "work");

    const queued = await w.submit();
    const job = await settled(w, queued.id);

    expect(job).toMatchObject({
      state: "failed",
      failure: { reason: "job_branch_moved", found: moved },
    });
    expect(w.room.git("rev-parse", "job/pj-1")).toBe(moved);
    expect(w.faux.state.callCount).toBe(0);
  });

  it("fails from preparing when the policy cannot resolve, with no policy recorded", async () => {
    const w = await runWorld();
    const { job: queued } = await w.jobs.submit({ ...NEW_JOB, repo: "unconfigured" }, T0);

    const job = await runJob(w.deps, queued, new RunControl());

    expect(job).toMatchObject({ state: "failed", endReason: "error" });
    expect(kinds(await w.events(job.id))).toEqual([
      "submitted",
      "conversation",
      "transition:preparing",
      "transition:failed",
    ]);
  });

  it("fails conversation_missing when pi has no conversation for the recorded id", async () => {
    const w = await runWorld();
    const { job: submitted } = await w.jobs.submit(NEW_JOB, T0);
    const queued = await w.jobs.change(submitted.id, T0, () => ({
      update: { conversationId: "999999" },
      event: { kind: "conversation", payload: { conversationId: "999999" } },
    }));

    const job = await runJob(w.deps, queued, new RunControl());

    expect(job).toMatchObject({ state: "failed", failure: { reason: "conversation_missing" } });
    expect(w.faux.state.callCount).toBe(0);
  });
});

describe("runJob: how an admitted run ends (EX-5, I12)", () => {
  it("a run ending in a model error is collecting with end_reason error", async () => {
    const w = await runWorld();
    w.faux.setResponses([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "bad model" }),
    ]);

    const queued = await w.submit();
    const job = await settled(w, queued.id);

    expect(job.endReason).toBe("error");
    expect(eventOf(await w.events(job.id), "transition:collecting")?.payload).toMatchObject({
      submission: "unanswered",
      submissionReason: "model_error",
    });
    expect(job).toMatchObject({ state: "failed", class: "no_changes" });
  });

  it("a settlement that fails still reaches collecting, end_reason error (settle_failed)", async () => {
    const w = await runWorld({
      harness: (harness) => {
        async function conversation(
          ...args: Parameters<Harness["conversation"]>
        ): Promise<Conversation | undefined> {
          const opened = await harness.conversation(...args);
          return opened === undefined ? undefined : failingSettle(opened);
        }
        return { commit: harness.commit.bind(harness), conversation };
      },
    });
    w.faux.setResponses([answer()]);

    const queued = await w.submit();
    const job = await settled(w, queued.id);

    expect(job.endReason).toBe("error");
    expect(eventOf(await w.events(job.id), "transition:collecting")?.payload).toMatchObject({
      reason: "settle_failed",
      message: "harness storage gone",
    });
    expect(w.verbs()).toContain("collect");
  });
});

describe("runJob: cancel (EX-2, EX-5)", () => {
  it("a seated job cancelled before preparing ends cancelled, no model call", async () => {
    const w = await runWorld();
    const queued = await w.submit();
    await within(SETTLE_MS, "first run", w.scheduler.idle());
    const { job: second } = await w.jobs.submit({ ...NEW_JOB, submissionId: "sub-x" }, T0 + 1);
    const control = new RunControl();
    const answered = control.cancel("changed my mind");

    const ended = await runJob(w.deps, second, control);

    expect(ended).toMatchObject({ state: "cancelled", endReason: "cancelled" });
    await expect(answered).resolves.toMatchObject({ id: second.id, state: "cancelled" });
    expect(kinds(await w.events(second.id))).toEqual([
      "submitted",
      "conversation",
      "transition:cancelled",
    ]);
    expect((await w.job(queued.id)).state).not.toBe("cancelled");
  });

  it("cancelled while preparing ends cancelled: no collection, no model call", async () => {
    let gated: GatedChannel | undefined;
    const w = await runWorld({
      channel: (channel) => {
        gated = gatedRefresh(channel);
        return gated.channel;
      },
    });
    const queued = await w.submit();
    await within(SETTLE_MS, "refresh", gated?.waiting ?? Promise.resolve());

    const answered = w.scheduler.cancel(queued.id, "stop", T0);
    gated?.open();
    const job = await settled(w, queued.id);

    await expect(answered).resolves.toMatchObject({ id: queued.id, state: "cancelled" });
    expect(job.state).toBe("cancelled");
    expect(eventOf(await w.events(job.id), "transition:cancelled")?.payload).toMatchObject({
      reason: "stop",
    });
    expect(w.verbs()).not.toContain("collect");
    expect(w.faux.state.callCount).toBe(0);
  });

  it("cancelled just before the prompt is submitted ends cancelled, no model call", async () => {
    const w = await runWorld();
    const { job: queued } = await w.jobs.submit(NEW_JOB, T0);
    const control = new RunControl();
    let answered: Promise<Job> | undefined;
    const deps: RunDeps = {
      ...w.deps,
      readPrompt: () => {
        answered = control.cancel("late");
        return Promise.resolve("prompt");
      },
    };

    const job = await runJob(deps, queued, control);

    expect(job).toMatchObject({ state: "cancelled", endReason: "cancelled" });
    await expect(answered).resolves.toMatchObject({ state: "cancelled" });
    expect(w.faux.state.callCount).toBe(0);
    expect(w.verbs()).not.toContain("collect");
  });

  it("cancelled while running aborts the conversation, collects, ends cancelled", async () => {
    const w = await runWorld();
    w.faux.setResponses([call("wait", {}), answer()]);
    const started = w.blocking.started();
    const queued = await w.submit();
    await within(SETTLE_MS, "tool", started);

    const answered = await within(SETTLE_MS, "cancel", w.scheduler.cancel(queued.id, "stop", T0));
    const job = await settled(w, queued.id);

    expect(answered).toMatchObject({ id: queued.id, state: "collecting", endReason: "cancelled" });
    expect(job).toMatchObject({ state: "cancelled", endReason: "cancelled" });
    expect(eventOf(await w.events(job.id), "transition:collecting")?.payload).toMatchObject({
      reason: "stop",
      submission: "unanswered",
      submissionReason: "aborted",
    });
    expect(w.verbs()).toContain("collect");
  });
});

describe("runJob: a gate refusal ends the run (EX-1, EX-4 gate path)", () => {
  /** One request: write and commit in one bash call; the next request is the one refused. */
  const writeAndCommit = (): AssistantMessage =>
    call("bash", { command: `mkdir -p src && echo 'export {};' > src/a.ts && ${COMMIT}` });

  it("model_requests spent: collecting ceiling_exceeded, collected, needs_review partial", async () => {
    const w = await runWorld({ ceilings: { model_requests: 1 } });
    w.faux.setResponses([writeAndCommit(), answer("never")]);

    const queued = await w.submit();
    const job = await settled(w, queued.id);

    expect(job).toMatchObject({
      state: "needs_review",
      endReason: "ceiling_exceeded",
      class: "partial",
      modelRequests: 1,
    });
    expect(w.faux.state.callCount).toBe(1);
    const events = await w.events(job.id);
    expect(kinds(events).filter((kind) => kind === "ceiling")).toEqual(["ceiling"]);
    expect(eventOf(events, "ceiling")?.payload).toMatchObject({
      reason: "ceiling_exceeded",
      source: "gate",
    });
    expect(eventOf(events, "transition:collecting")?.payload).toMatchObject({
      ceiling: "ceiling_exceeded",
    });
    expect(w.verbs()).toContain("collect");
  });

  it("usage unreadable: collecting usage_unavailable, needs_review partial", async () => {
    let reads = 0;
    const w = await runWorld({
      usageOf: () =>
        ++reads === 1
          ? Promise.resolve({ tokens: 0, costUsd: 0 })
          : Promise.reject(new Error("usage gone")),
    });
    w.faux.setResponses([writeAndCommit(), answer("never")]);

    const queued = await w.submit();
    const job = await settled(w, queued.id);

    expect(job).toMatchObject({
      state: "needs_review",
      endReason: "usage_unavailable",
      class: "partial",
    });
    expect(w.faux.state.callCount).toBe(1);
    expect(eventOf(await w.events(job.id), "ceiling")?.payload).toMatchObject({
      reason: "usage_unavailable",
    });
  });
});
