// The deadline and the one warning (VT-2; EX-2, EX-3, EX-4 deadline path)
// over the run path of run-fixture.ts, with the run's ceiling timers fired by
// hand: the deadline aborts a long bash or model call and the job is collected
// `ceiling_exceeded`, class `partial`; waiting accrues no active time and a
// crash interval does; one `warn-<job id>` steer reaches the model, its
// receipt read back through `Harness.submission(id).status()`.

import { join } from "node:path";
import { existsSync } from "node:fs";
import type {
  AssistantMessage,
  Message,
  SimpleStreamOptions,
  Context as TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  type Conversation,
  type Harness,
  MemoryStorage,
  type Submission,
  type SubmissionRecord,
} from "@earendil-works/pi-durable";
import { describe, expect, it, onTestFinished } from "vitest";
import { context } from "../../src/context.ts";
import { jobConversation } from "../../src/runner/conversations.ts";
import { RunControl } from "../../src/runner/scheduler.ts";
import type { Job, JobEvent } from "../../src/runner/store.ts";
import { type RunDeps, runJob } from "../../src/runner/run.ts";
import { armCeilingTimers, type CeilingTimers } from "../../src/runner/deadline.ts";
import {
  runWarning,
  type RunWarningDeps,
  WARNING_TEXT,
  warningPlaced,
  warningRequestId,
} from "../../src/runner/warning.ts";
import { tempDir } from "../fixtures.ts";
import { openFauxHarness } from "../harness-fixture.ts";
import {
  answer,
  call,
  COMMIT,
  eventOf,
  jobToolResults,
  kinds,
  type ManualTimer,
  manualTimer,
  type RunWorld,
  runWorld,
  SETTLE_MS,
  settled,
} from "./run-fixture.ts";
import { closeHarness, within } from "./runner-fixture.ts";
import { NEW_JOB, openTestStore, T0 } from "./store-fixture.ts";

const HOUR_S = 3600;

/** One request: write and commit in one bash call, so a later ceiling leaves work to collect. */
const writeAndCommit = (): AssistantMessage =>
  call("bash", { command: `mkdir -p src && echo 'export {};' > src/a.ts && ${COMMIT}` });

/** Resolves once `holds` does, polled; fails after `SETTLE_MS`. */
async function until(what: string, holds: () => boolean | Promise<boolean>): Promise<void> {
  const poll = async (): Promise<void> => {
    while (!(await holds())) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  await within(SETTLE_MS, what, poll());
}

/** Resolves once job `id` has its warning receipt. */
const warned = (world: RunWorld, id: string): Promise<void> =>
  until("warning receipt", async () => warningEvents(await world.events(id)).length > 0);

const ceilingEvents = (events: readonly JobEvent[]): JobEvent[] =>
  events.filter((event) => event.kind === "ceiling");

const warningEvents = (events: readonly JobEvent[]): JobEvent[] =>
  events.filter((event) => event.kind === "warning");

/** A user message's text, whatever its content shape. */
const userText = (message: Message): string | undefined => {
  if (message.role !== "user") {
    return undefined;
  }
  return typeof message.content === "string"
    ? message.content
    : message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
};

/** A model call in flight: resolves when it starts, and when its request is aborted. */
interface BlockedCall {
  step: (
    context: TranscriptContext,
    options: SimpleStreamOptions | undefined,
  ) => Promise<AssistantMessage>;
  started: Promise<void>;
  aborted: Promise<void>;
}

/** A model step that blocks until its request is aborted (already aborted included). */
function blockingModelCall(): BlockedCall {
  let start = (): void => undefined;
  let abort = (): void => undefined;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const aborted = new Promise<void>((resolve) => {
    abort = resolve;
  });
  const step: BlockedCall["step"] = (_context, options) =>
    new Promise((resolve) => {
      start();
      const end = (): void => {
        abort();
        resolve(answer("aborted"));
      };
      if (options?.signal?.aborted === true) {
        end();
      }
      options?.signal?.addEventListener("abort", end);
    });
  return { step, started, aborted };
}

/** The deadline's expectations on a job collected by it (EX-4, B3). */
async function expectDeadlineEnding(world: RunWorld, job: Job): Promise<void> {
  expect(job).toMatchObject({
    state: "needs_review",
    endReason: "ceiling_exceeded",
    class: "partial",
  });
  const events = await world.events(job.id);
  expect(ceilingEvents(events).map((event) => event.payload)).toEqual([
    { reason: "ceiling_exceeded", source: "deadline" },
  ]);
  expect(eventOf(events, "transition:collecting")?.payload).toMatchObject({
    ceiling: "ceiling_exceeded",
  });
  expect(kinds(events).indexOf("ceiling")).toBeLessThan(
    kinds(events).indexOf("transition:collecting"),
  );
  expect(world.verbs()).toContain("collect");
}

/** The warning event's submission, read back through the harness. */
async function receiptOf(
  w: RunWorld,
  job: Job,
): Promise<{ receipt: JobEvent | undefined; record: SubmissionRecord | undefined }> {
  const [receipt] = warningEvents(await w.events(job.id));
  const conversation = await jobConversation(w.harness, job.conversationId ?? "");
  const record = await w.harness.commit(
    (tx) =>
      conversation === undefined
        ? undefined
        : tx.submissionByRequest(conversation.id, warningRequestId(job.id)),
    context,
  );
  return { receipt, record };
}

describe("the deadline timers, armed from the job row (EX-2)", () => {
  interface Armed {
    timers: ManualTimer;
    fired: string[];
    armed: CeilingTimers;
  }
  const arm = (job: Pick<Job, "activeMs" | "runningSince">, now: number): Armed => {
    const timers = manualTimer();
    const fired: string[] = [];
    const armed = armCeilingTimers({
      job,
      ceilings: { active_wall_clock_s: HOUR_S },
      softThreshold: 0.8,
      now,
      timer: timers.timer,
      expire: () => fired.push("deadline"),
      warn: () => fired.push("warn"),
    });
    return { timers, fired, armed };
  };

  it("arms the deadline and the soft timer for what is left of active wall-clock", () => {
    const { timers, fired } = arm({ activeMs: 0, runningSince: T0 }, T0 + 5000);

    expect(timers.armed.map((entry) => entry.ms)).toEqual([
      HOUR_S * 1000 - 5000,
      0.8 * HOUR_S * 1000 - 5000,
    ]);
    expect(fired).toEqual([]);
  });

  it("waiting accrues nothing: only the running segments count", async () => {
    const { jobs } = await openTestStore();
    const { job } = await jobs.submit(NEW_JOB, T0);
    await jobs.transition(job.id, "preparing", T0);
    await jobs.transition(job.id, "running", T0 + 1000);
    await jobs.transition(job.id, "waiting_room", T0 + 11_000);
    // An hour in the waiting room.
    const resumed = await jobs.transition(job.id, "running", T0 + 11_000 + HOUR_S * 1000);

    const { timers } = arm(resumed, (resumed.runningSince ?? 0) + 2000);

    expect(timers.armed[0]?.ms).toBe(HOUR_S * 1000 - 12_000);
  });

  it("a crash interval is charged: re-armed later, the time since running_since counts", () => {
    const { timers } = arm({ activeMs: 60_000, runningSince: T0 }, T0 + 600_000);

    expect(timers.armed[0]?.ms).toBe(HOUR_S * 1000 - 660_000);
  });

  it("past the soft threshold it warns at once; past the deadline it only expires", () => {
    expect(arm({ activeMs: 0.9 * HOUR_S * 1000, runningSince: T0 }, T0).fired).toEqual(["warn"]);
    const { timers, fired } = arm({ activeMs: HOUR_S * 1000, runningSince: T0 }, T0);

    expect(fired).toEqual(["deadline"]);
    expect(timers.armed).toEqual([]);
  });

  it("stopped, neither fires, even from a callback already in hand", () => {
    const { timers, fired, armed } = arm({ activeMs: 0, runningSince: T0 }, T0);
    const callbacks = timers.armed.map((entry) => entry.fire);

    armed.stop();
    for (const fire of callbacks) {
      fire();
    }

    expect(timers.armed.every((entry) => entry.cancelled)).toBe(true);
    expect(fired).toEqual([]);
  });
});

describe("the deadline on the run path (EX-2, EX-4 deadline path)", () => {
  it("aborts a long bash in flight: collecting ceiling_exceeded, needs_review partial", async () => {
    const tmp = await tempDir();
    onTestFinished(tmp.cleanup);
    const marker = join(tmp.dir, "sleeping");
    const w = await runWorld();
    w.faux.setResponses([
      writeAndCommit(),
      call("bash", { command: `touch ${marker} && sleep 30` }),
      answer("never"),
    ]);
    const started = Date.now();

    const queued = await w.submit();
    await until("long bash", () => existsSync(marker));
    w.timers.fire("longest");
    const job = await settled(w, queued.id);

    expect(Date.now() - started).toBeLessThan(15_000);
    await expectDeadlineEnding(w, job);
    expect(w.faux.state.callCount).toBe(2);
    const results = await jobToolResults(w, job);
    expect(results).toHaveLength(2);
    expect(results[1]?.isError).toBe(true);
  });

  it("aborts a long model call in flight the same way", async () => {
    const w = await runWorld();
    const blocked = blockingModelCall();
    w.faux.setResponses([writeAndCommit(), blocked.step]);

    const queued = await w.submit();
    await within(SETTLE_MS, "model call", blocked.started);
    w.timers.fire("longest");
    const job = await settled(w, queued.id);

    await expectDeadlineEnding(w, job);
    expect(eventOf(await w.events(job.id), "transition:collecting")?.payload).toMatchObject({
      submission: "unanswered",
      submissionReason: "aborted",
    });
  });

  it("is armed from the running row and stopped when the run settles", async () => {
    const w = await runWorld();
    w.faux.setResponses([answer()]);

    const queued = await w.submit();
    const job = await settled(w, queued.id);

    // Armed at the running commit: next to nothing of the hour spent yet.
    const [deadline, soft] = w.timers.armed.map((entry) => entry.ms);
    expect(deadline).toBeGreaterThan(HOUR_S * 1000 - 100);
    expect(soft).toBeGreaterThan(0.8 * HOUR_S * 1000 - 100);
    expect(w.timers.armed.every((entry) => entry.cancelled)).toBe(true);
    for (const entry of w.timers.armed) {
      entry.fire();
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    const events = await w.events(job.id);
    expect(ceilingEvents(events)).toEqual([]);
    expect(warningEvents(events)).toEqual([]);
    expect(job).toMatchObject({ endReason: "completed" });
  });

  it("a gate refusal first: one ceiling event, from the gate, the deadline then a no-op", async () => {
    const w = await runWorld({ ceilings: { model_requests: 1 } });
    w.faux.setResponses([writeAndCommit(), answer("never")]);

    const queued = await w.submit();
    const job = await settled(w, queued.id);

    expect(job).toMatchObject({ endReason: "ceiling_exceeded", class: "partial" });
    expect(ceilingEvents(await w.events(job.id)).map((event) => event.payload)).toMatchObject([
      { reason: "ceiling_exceeded", source: "gate" },
    ]);
  });
});

describe("the one warning (EX-3)", () => {
  it("at the threshold: one warn-<job id> steer after the tool round, its receipt placed", async () => {
    const w = await runWorld({ ceilings: { model_requests: 3 } });
    const seen: string[][] = [];
    w.faux.setResponses([
      writeAndCommit(),
      call("wait", {}),
      (request): AssistantMessage => {
        seen.push(request.messages.map((message) => message.role));
        seen.push(request.messages.flatMap((message) => userText(message) ?? []));
        return answer();
      },
    ]);
    const tool = w.blocking.started();

    const queued = await w.submit();
    await within(SETTLE_MS, "tool", tool);
    await warned(w, queued.id);
    const before = await receiptOf(w, await w.job(queued.id));
    expect(before.record?.status).toBe("queued");
    expect(
      before.record === undefined ? true : await warningPlaced(w.harness, before.record.id),
    ).toBe(false);
    w.blocking.release();
    const job = await settled(w, queued.id);

    const { receipt, record } = await receiptOf(w, job);
    expect(receipt?.payload).toEqual({
      requestId: `warn-${job.id}`,
      submissionId: String(record?.id),
      trigger: "usage",
    });
    expect(record === undefined ? false : await warningPlaced(w.harness, record.id)).toBe(true);
    // The third request already carried the steer, after the tool result.
    expect(seen[0]?.slice(-2)).toEqual(["toolResult", "user"]);
    expect(seen[1]?.at(-1)).toBe(WARNING_TEXT);
    expect(job).toMatchObject({ endReason: "completed", modelRequests: 3 });
  });

  it("under one request's allowance it comes first, and is delivered once however often due", async () => {
    // tokens < the faux model's maxTokens: due at every admission, from the first.
    const w = await runWorld({ ceilings: { tokens: 10_000 } });
    const users: string[][] = [];
    w.faux.setResponses([
      call("wait", {}),
      call("wait", {}),
      (request): AssistantMessage => {
        users.push(request.messages.flatMap((message) => userText(message) ?? []));
        return answer();
      },
    ]);
    let tool = w.blocking.started();

    const queued = await w.submit();
    await within(SETTLE_MS, "first tool", tool);
    await warned(w, queued.id);
    expect((await w.job(queued.id)).modelRequests).toBe(1);
    tool = w.blocking.started();
    w.blocking.release();
    await within(SETTLE_MS, "second tool", tool);
    w.timers.fire("shortest");
    w.blocking.release();
    const job = await settled(w, queued.id);

    expect(warningEvents(await w.events(job.id))).toHaveLength(1);
    expect(users[0]?.filter((text) => text === WARNING_TEXT)).toHaveLength(1);
  });

  it("the wall-clock soft timer, fired, delivers the warning", async () => {
    const w = await runWorld();
    w.faux.setResponses([call("wait", {}), answer()]);
    const tool = w.blocking.started();

    const queued = await w.submit();
    await within(SETTLE_MS, "tool", tool);
    w.timers.fire("shortest");
    await warned(w, queued.id);
    w.blocking.release();
    const job = await settled(w, queued.id);

    const [receipt] = warningEvents(await w.events(job.id));
    expect(receipt?.payload).toMatchObject({ trigger: "wall_clock" });
    expect(job.endReason).toBe("completed");
  });

  it("a warning already on record (a restarted run) is not submitted again", async () => {
    const w = await runWorld({ ceilings: { tokens: 10_000 } });
    w.faux.setResponses([
      call("wait", {}),
      (request): AssistantMessage => {
        expect(request.messages.flatMap((message) => userText(message) ?? [])).not.toContain(
          WARNING_TEXT,
        );
        return answer();
      },
    ]);
    const { job: queued } = await w.jobs.submit({ ...NEW_JOB, ceilings: { tokens: 10_000 } }, T0);
    await w.jobs.appendEvent(queued.id, T0, "warning", {
      requestId: warningRequestId(queued.id),
      submissionId: "0",
      trigger: "usage",
    });
    const tool = w.blocking.started();

    const run = runJob(w.deps, queued, new RunControl());
    await within(SETTLE_MS, "tool", tool);
    w.timers.fire("shortest");
    w.blocking.release();
    const job = await within(SETTLE_MS, "run", run);

    expect(warningEvents(await w.events(job.id))).toHaveLength(1);
    expect((await receiptOf(w, job)).record).toBeUndefined();
    expect(job.endReason).toBe("completed");
  });
});

describe("the run's warning: once, and never into a finished run (EX-3)", () => {
  interface Recording {
    conversation: Pick<Conversation, "submit">;
    drafts: unknown[];
    submitted: Submission[];
  }

  /** A faux harness's conversation whose `submit` records what it is given. */
  async function recordingConversation(): Promise<Recording> {
    const { harness, root } = await openFauxHarness(new MemoryStorage());
    onTestFinished(() => closeHarness(harness));
    const drafts: unknown[] = [];
    const submitted: Submission[] = [];
    return {
      drafts,
      submitted,
      conversation: {
        submit: async (...args): Promise<Submission> => {
          drafts.push(args[0]);
          const submission = await root.submit(...args);
          submitted.push(submission);
          return submission;
        },
      },
    };
  }

  it("due twice at once (gate and timer together): one steer, one receipt", async () => {
    const { jobs } = await openTestStore();
    const { job } = await jobs.submit(NEW_JOB, T0);
    const { conversation, drafts, submitted } = await recordingConversation();
    const warning = runWarning({
      conversation,
      jobs,
      jobId: job.id,
      now: () => T0,
      stop: new AbortController().signal,
      failed: () => undefined,
    });

    warning.due("usage");
    warning.due("wall_clock");
    await until("receipt", async () => warningEvents(await jobs.events(job.id)).length > 0);
    await warning.close();
    warning.due("usage");

    expect(drafts).toEqual([
      { type: "input", content: WARNING_TEXT, whenBusy: "steer", requestId: `warn-${job.id}` },
    ]);
    expect(warningEvents(await jobs.events(job.id)).map((event) => event.payload)).toEqual([
      { requestId: `warn-${job.id}`, submissionId: String(submitted[0]?.id), trigger: "usage" },
    ]);
  });

  it("closed or stopped before it is given, it is withheld; a failure is told, not thrown", async () => {
    const { jobs } = await openTestStore();
    const { job } = await jobs.submit(NEW_JOB, T0);
    const { conversation, drafts } = await recordingConversation();
    const stop = new AbortController();
    const failures: string[] = [];
    const deps: RunWarningDeps = {
      conversation,
      jobs,
      jobId: job.id,
      now: () => T0,
      stop: stop.signal,
      failed: (message) => {
        failures.push(message);
      },
    };

    const closed = runWarning(deps);
    closed.due("usage");
    expect(await closed.close()).toBeUndefined();
    const stopped = runWarning(deps);
    stopped.due("usage");
    stop.abort();
    expect(await stopped.close()).toBeUndefined();
    const failing = runWarning({ ...deps, stop: new AbortController().signal, jobId: "pj-404" });
    failing.due("usage");
    await until("failure", () => failures.length > 0);
    expect(await failing.close()).toBeUndefined();

    expect(drafts).toHaveLength(1);
    expect(failures).toEqual([expect.stringContaining("pj-404")]);
  });
});

describe("a warning racing the run's end (EX-3)", () => {
  /**
   * `harness` whose job conversation holds a warning back until the initial
   * prompt's submission has settled: the warning then reaches an idle
   * conversation and starts a run of its own.
   */
  function lateWarnings(harness: Harness): RunDeps["harness"] {
    const late = (conversation: Conversation): Conversation => {
      let initial: Promise<unknown> | undefined;
      const submit = async (...args: Parameters<Conversation["submit"]>): Promise<Submission> => {
        const [draft] = args;
        if (draft.type === "input" && draft.requestId?.startsWith("warn-") === true) {
          await initial;
        }
        const submission = await conversation.submit(...args);
        initial ??= submission.wait(context);
        return submission;
      };
      return new Proxy(conversation, {
        get(target, key): unknown {
          if (key === "submit") {
            return submit;
          }
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function"
            ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
            : value;
        },
      });
    };
    async function conversation(
      ...args: Parameters<Harness["conversation"]>
    ): Promise<Conversation | undefined> {
      const opened = await harness.conversation(...args);
      return opened === undefined ? undefined : late(opened);
    }
    return { commit: harness.commit.bind(harness), conversation };
  }

  it("a warning that starts a run after the job's run settled is aborted before collection", async () => {
    const w = await runWorld({ ceilings: { tokens: 10_000 }, harness: lateWarnings });
    const stray = blockingModelCall();
    w.faux.setResponses([answer(), stray.step]);

    const queued = await w.submit();
    const job = await settled(w, queued.id);

    expect(job.endReason).toBe("completed");
    const { receipt, record } = await receiptOf(w, job);
    expect(receipt?.payload).toMatchObject({ submissionId: String(record?.id) });
    // Its run ended before collection, aborted (before or during its model call).
    expect(record).toMatchObject({ status: "unanswered", reason: "aborted" });
  });
});
