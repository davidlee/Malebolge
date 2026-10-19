// A job's run end to end (VT-1; EX-2, EX-5) over the run path of
// run-fixture.ts. The scheduler seats each job; `runJob` is what it runs.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Conversation, Harness, Submission } from "@earendil-works/pi-durable";
import type { Connection } from "@earendil-works/pi-env";
import { describe, expect, it } from "vitest";
import { context } from "../../src/context.ts";
import { conversationIdOf } from "../../src/runner/durable-ids.ts";
import type { GitChannel } from "../../src/runner/room.ts";
import { type RunDeps, runJob } from "../../src/runner/run.ts";
import { RunControl } from "../../src/runner/scheduler.ts";
import type { Job } from "../../src/runner/store.ts";
import { textOf } from "../harness-fixture.ts";
import { FailingConnection, lostError } from "../room/connection-fixture.ts";
import { narrowedModes } from "./config-fixture.ts";
import {
  answer,
  call,
  COMMIT,
  eventOf,
  jobToolResults,
  kinds,
  runWorld,
  SETTLE_MS,
  settled,
  userTexts,
  writeAndCommit,
} from "./run-fixture.ts";
import { within } from "./runner-fixture.ts";
import { NEW_JOB, T0 } from "./store-fixture.ts";

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

  it("an admitted job runs to preparing, its policy recorded, after its mode's scope narrowed", async () => {
    const w = await runWorld({ modes: narrowedModes() });
    w.faux.setResponses([writeAndCommit(), answer()]);

    const queued = await w.submit();
    const job = await settled(w, queued.id);

    expect(kinds(await w.events(job.id))).toEqual(
      expect.arrayContaining(["policy", "transition:preparing"]),
    );
    expect(job.state).toBe("needs_review");
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

describe("runJob: project context (PHASE-04, design §4.2-4.4)", () => {
  /** Loses the first exec whose argv names `stat` (the fetch's file probe), then lets all through. */
  const losingFirstStat = (local: Connection): Connection => {
    let lost = false;
    return new FailingConnection(({ op, json }) => {
      if (!lost && op === "exec" && JSON.stringify(json).includes('"stat"')) {
        lost = true;
        return lostError();
      }
      return undefined;
    }, local);
  };

  it("records one context_degraded per degradation of the attempt that stood, across a retry", async () => {
    // .doctrine/ committed, no .gitignore: boot_not_ignored, and no host doctrine runs.
    const w = await runWorld({
      connection: losingFirstStat,
      allowLog: (text) => text.includes("context degraded"),
    });
    w.real.commit(".doctrine/config.toml");
    w.faux.setResponses([writeAndCommit(), answer()]);

    const queued = await w.submit();
    const job = await settled(w, queued.id);

    expect(job.state).toBe("needs_review");
    expect(w.slept).toHaveLength(1);
    const events = await w.events(job.id);
    const degraded = events.filter(({ kind }) => kind === "context_degraded");
    expect(degraded.map(({ payload }) => payload)).toEqual([
      { source: "doctrine", reason: "boot_not_ignored" },
    ]);
    const labels = kinds(events);
    const at = labels.indexOf("context_degraded");
    expect(at).toBeGreaterThan(labels.indexOf("refreshed"));
    expect(at).toBeLessThan(labels.indexOf("transition:running"));
    expect(w.logs).toHaveLength(1);
    expect(w.logs[0]).toContain("doctrine");
    expect(w.logs[0]).toContain("boot_not_ignored");
  });

  it("composes the fetched sources into the first message, before the job block", async () => {
    const w = await runWorld();
    w.real.commit("AGENTS.md");
    const firstPrompts: string[][] = [];
    w.faux.setResponses([
      (request): AssistantMessage => {
        firstPrompts.push(userTexts(request.messages));
        return answer();
      },
    ]);

    const queued = await w.submit();
    const job = await settled(w, queued.id);

    const prompt = firstPrompts[0]?.[0] ?? "";
    const guest = w.repo.guestPath;
    const block = prompt.indexOf(`<project_instructions path="${guest}/AGENTS.md">`);
    expect(block).toBeGreaterThanOrEqual(0);
    expect(prompt).toContain(`Working directory: ${guest}`);
    expect(block).toBeLessThan(prompt.indexOf("# patch-agent job"));
    expect(kinds(await w.events(job.id))).not.toContain("context_degraded");
  });
});
