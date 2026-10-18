// Restart recovery, phase A (PHASE-10 batch A; DEC-054, DEC-065): each job
// state reached by a real run that dies at a write boundary (`crashAt`), then
// the runner restarted on the same store file. Disabled (I14, EX-6): no room
// verb, no env command, nothing timed out, the harness never asked for
// progress. Parking (EX-7): parked once, re-based once.

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type {
  Conversation,
  Harness,
  Submission,
  SubmissionRecord,
} from "@earendil-works/pi-durable";
import { type Connection, HostKeyChangedError } from "@earendil-works/pi-env";
import { describe, expect, it } from "vitest";
import { context } from "../../src/context.ts";
import { conversationIdOf, submissionRecordOf } from "../../src/runner/durable-ids.ts";
import { RESUME_TEXT } from "../../src/runner/pause.ts";
import { recordedPolicy } from "../../src/runner/policy.ts";
import type { RunDeps } from "../../src/runner/run.ts";
import { readSnapshot, recoverHost } from "../../src/runner/recover.ts";
import { ChannelUnavailable, type GitChannel } from "../../src/runner/room.ts";
import type { Job, JobEvent } from "../../src/runner/store.ts";
import { WARNING_TEXT } from "../../src/runner/warning.ts";
import { textOf } from "../harness-fixture.ts";
import {
  answer,
  call,
  eventLabel,
  eventOf,
  jobToolResults,
  kinds,
  lostBash,
  restart,
  ROOM_DOWN,
  roomGoesDown,
  roomUntrusted,
  type RunWorld,
  type RunWorldOptions,
  runWorld,
  SETTLE_MS,
  settled,
  storeFile,
  until,
  userTexts,
  warned,
  warningEvents,
  writeAndCommit,
} from "./run-fixture.ts";
import { FailingConnection } from "./env-fixture.ts";
import { within } from "./runner-fixture.ts";
import { NEW_JOB, T0 } from "./store-fixture.ts";

/** The room as the test sets it, and every verb or connection the runner asked of it. */
interface Room {
  down: boolean;
  calls: string[];
  /** Told of each channel verb (`refresh`, `collect`, `probe`), and awaited, before it runs. */
  before?: ((verb: string) => void | Promise<void>) | undefined;
  /** Set: every daemon connection from then on fails its starts with this trust failure. */
  untrusted?: (() => Error) | undefined;
}

/** The fake slot and the local daemon, watched; `down` makes probes fail and collection unavailable. */
const watched = (room: Room): Pick<RunWorldOptions, "channel" | "connection"> => ({
  channel: (channel): GitChannel => ({
    refresh: async (repo, baseRef): ReturnType<GitChannel["refresh"]> => {
      room.calls.push("refresh");
      await room.before?.("refresh");
      return channel.refresh(repo, baseRef);
    },
    collect: async (repo, jobId): ReturnType<GitChannel["collect"]> => {
      room.calls.push("collect");
      await room.before?.("collect");
      if (room.down) {
        throw new ChannelUnavailable("room down");
      }
      return channel.collect(repo, jobId);
    },
    reachable: async (): Promise<boolean> => {
      room.calls.push("probe");
      await room.before?.("probe");
      return !room.down && (await channel.reachable());
    },
  }),
  connection: (local): Connection => {
    room.calls.push("connect");
    if (room.untrusted !== undefined) {
      return roomUntrusted(room.untrusted)(local);
    }
    // The branch judgement's git commands, as the room sees them.
    const judged = new FailingConnection(({ op, json }) => {
      const command = JSON.stringify(json);
      for (const verb of ["rev-parse", "switch"]) {
        if (op === "exec" && command.includes(`"${verb}"`)) {
          room.calls.push(verb);
        }
      }
      return undefined;
    }, local);
    return roomGoesDown()(judged);
  },
});

/** Past every bound: `max_room_wait` and `max_pending_collection`. */
const LONG_MS = 10 * 24 * 3600 * 1000;

interface Crashed {
  w: RunWorld;
  id: string;
  room: Room;
  /** Resolves when the agent's `wait` tool starts (a run left in flight). */
  tool: Promise<void>;
}

/** A job submitted on a fresh world; the process dies at write `crashAt`, if it gets there. */
async function started(
  crashAt: string | undefined,
  script: AssistantMessage[],
  {
    down = false,
    before,
    ...options
  }: { down?: boolean; before?: (room: Room, w: RunWorld) => void } & RunWorldOptions = {},
): Promise<Crashed> {
  const room: Room = { down, calls: [] };
  const w = await runWorld({
    path: await storeFile(),
    ...(crashAt === undefined ? {} : { crashAt }),
    ...watched(room),
    ...options,
  });
  w.faux.setResponses(script);
  before?.(room, w);
  const tool = w.blocking.started();
  const { id } = await w.submit();
  return { w, id, room, tool };
}

/** A job run until the process dies at write `crashAt` and its scheduler rests; the room `down` throughout if asked. */
async function crashedAt(
  crashAt: string,
  script: AssistantMessage[],
  options: { down?: boolean } & RunWorldOptions = {},
): Promise<Crashed> {
  const crashed = await started(crashAt, script, options);
  await crashed.w.scheduler.idle();
  return crashed;
}

/** A job run until the agent's `wait` tool is in flight (its process still alive unless `crashAt` came first). */
async function inFlight(
  script: AssistantMessage[],
  { crashAt, ...options }: { crashAt?: string } & RunWorldOptions = {},
): Promise<Crashed> {
  const running = await started(crashAt, script, options);
  await within(SETTLE_MS, "the wait tool", running.tool);
  return running;
}

/** The row less what parking writes. */
const unparked = (job: Job): Record<string, unknown> => ({ ...job, parkedAt: 0, updatedAt: 0 });

/** What a disabled restart must leave: the harness passive, no model request. */
async function expectNoProgress(r: RunWorld): Promise<void> {
  expect((await r.harness.inspect(context)).scheduling).toBe("paused");
  expect(r.faux.state.callCount).toBe(0);
}

/** Each state a crash at its write boundary leaves: [state, crashAt, model script, room down]. */
const SCENARIOS: readonly (readonly [string, string, AssistantMessage[], boolean])[] = [
  ["preparing, no base_oid", "refreshed", [], false],
  ["preparing, base_oid set, no initial submission", "prompt", [], false],
  ["preparing, initial submission admitted", "transition:running", [answer()], false],
  ["running, pause recorded (EX-3)", "transition:waiting_room", [lostBash()], false],
  ["waiting_room", "transition:pending_collection", [lostBash()], true],
  ["collecting", "collected", [writeAndCommit(), answer()], false],
  ["pending_collection", "transition:failed", [answer()], true],
];

describe("disabled restart: phase A only, nothing asked of the room or the harness (VT-2, EX-3, EX-6)", () => {
  it.each(SCENARIOS)(
    "%s: unchanged, no verb, no env command, no time-out",
    async (_name, crashAt, script, down) => {
      const { w, id, room } = await crashedAt(crashAt, script, { down });
      const before = await w.job(id);
      room.calls.length = 0;
      w.advance(LONG_MS);

      const r = await restart(w, { enabled: false });
      await r.scheduler.idle();

      expect(room.calls).toEqual([]);
      expect(unparked(await r.job(id))).toEqual(unparked(before));
      await expectNoProgress(r);
    },
  );

  it("a recorded pause stays recorded (EX-3)", async () => {
    const { w, id } = await crashedAt("transition:waiting_room", [lostBash()]);
    const r = await restart(w, { enabled: false });
    expect(await r.job(id)).toMatchObject({ state: "running", pauseRequested: true });
  });

  it("row 7: a settled run with no collecting recorded moves to collecting, host only (R4)", async () => {
    const { w, id, room } = await crashedAt("transition:collecting", [answer()]);
    room.calls.length = 0;

    const r = await restart(w, { enabled: false });

    expect(await r.job(id)).toMatchObject({ state: "collecting", endReason: "completed" });
    expect(eventOf(await r.events(id), "transition:collecting")?.payload).toMatchObject({
      reason: "recovered",
      submission: "done",
    });
    expect(room.calls).toEqual([]);
    await expectNoProgress(r);
  });

  it("row 7: a recorded ceiling is the end reason, the latch having died with the process (AS-3)", async () => {
    const { w, id } = await crashedAt("transition:collecting", [writeAndCommit(), answer()], {
      ceilings: { model_requests: 1 },
    });

    const r = await restart(w, { enabled: false });

    expect(await r.job(id)).toMatchObject({
      state: "collecting",
      endReason: "ceiling_exceeded",
      modelRequests: 1,
    });
  });
});

describe("parking (EX-7)", () => {
  it("a disabled restart parks once: a later one leaves parked_at and writes no event", async () => {
    const { w, id } = await crashedAt("prompt", []);
    const first = await restart(w, { enabled: false });
    const parkedAt = (await first.job(id)).parkedAt;
    first.advance(5000);

    const second = await restart(first, { enabled: false });

    expect(parkedAt).toBeDefined();
    expect((await second.job(id)).parkedAt).toBe(parkedAt);
    expect(kinds(await second.events(id)).filter((kind) => kind === "parked")).toHaveLength(1);
  });

  it("pending_collection parked past max_pending_collection keeps only its pre-park wait: retried, collected (VT-3)", async () => {
    const room: Room = { down: true, calls: [] };
    const w = await runWorld({ path: await storeFile(), ...watched(room) });
    // Dies at the scheduler's first retry probe, just after entering pending_collection.
    room.before = (verb): void => {
      if (verb === "probe") {
        w.crash();
      }
    };
    w.faux.setResponses([writeAndCommit(), answer()]);
    const { id } = await w.submit();
    await w.scheduler.idle();
    room.before = undefined;
    const before = await w.job(id);
    expect(before.state).toBe("pending_collection");
    const parked = await restart(w, { enabled: false });
    const parkedAt = (await parked.job(id)).parkedAt ?? 0;
    parked.advance(LONG_MS);
    room.down = false;

    const r = await restart(parked, { enabled: true });
    await until(
      "retried",
      async () => !["pending_collection", "collecting"].includes((await r.job(id)).state),
    );
    expect((await r.job(id)).state).toBe("needs_review");

    const unparkedEvents = (await r.events(id)).filter((event) => event.kind === "unparked");
    expect(unparkedEvents).toHaveLength(1);
    const shiftedMs = Number(unparkedEvents[0]?.payload["shiftedMs"]);
    expect(shiftedMs).toBeGreaterThanOrEqual(LONG_MS);
    const pending = (await r.events(id)).find(
      (event) => event.kind === "transition" && event.payload["from"] === "pending_collection",
    );
    // Charged: the wait before parking, and the moments since unparking; never the parked span.
    expect((pending?.at ?? 0) - before.stateEnteredAt - shiftedMs).toBeLessThan(
      parkedAt - before.stateEnteredAt + 1000,
    );
  });
});

describe("readSnapshot: read-only views (EX-8, I15)", () => {
  it("the initial submission record splits preparing with a base", async () => {
    const unsubmitted = await crashedAt("prompt", []);
    const submitted = await crashedAt("transition:running", [answer()]);
    const views = await Promise.all(
      [unsubmitted, submitted].map(async ({ w, id }) => {
        const r = await restart(w, { enabled: false });
        const { snapshot } = await readSnapshot(r.recoverDeps, await r.job(id));
        await expectNoProgress(r);
        return snapshot;
      }),
    );
    expect(
      views.map(({ state, baseOid, initialSubmission }) => ({
        state,
        based: baseOid !== undefined,
        initialSubmission,
      })),
    ).toEqual([
      { state: "preparing", based: true, initialSubmission: false },
      { state: "preparing", based: true, initialSubmission: true },
    ]);
  });
});

/** A job's work, then its answer: a run that is collected `needs_review`. */
const WORK = (): AssistantMessage[] => [writeAndCommit(), answer()];

/** The restart (enabled) after `crashed`, with the room's calls since; the job once the rejoin rests it. */
async function rejoined(
  { w, id, room }: Crashed,
  script: FauxResponseStep[] = WORK(),
): Promise<{ r: RunWorld; job: Job }> {
  room.calls.length = 0;
  const r = await restart(w, { enabled: true, script });
  return { r, job: await settled(r, id) };
}

/** The record of the submission admitted to `job`'s conversation with `requestId`. */
async function recordOf(
  r: RunWorld,
  job: Job,
  requestId: string,
): Promise<SubmissionRecord | undefined> {
  const conversation = await conversationIdOf(r.harness, job.conversationId ?? "");
  return conversation === undefined
    ? undefined
    : submissionRecordOf(r.harness, conversation, requestId);
}

/** The process dies at the room's next probe, which never answers (its run must not wait out the bound). */
const dieAtProbe = (room: Room, w: RunWorld): void => {
  room.before = async (verb): Promise<void> => {
    if (verb === "probe") {
      w.crash();
      await new Promise<void>(() => undefined);
    }
  };
};

/** The process stopped (`close`, as a crash leaves pi) at the room's first `verb`, which then runs. */
const closingAt =
  (verb: string) =>
  (room: Room, w: RunWorld): void => {
    room.before = async (asked): Promise<void> => {
      if (asked === verb) {
        room.before = undefined;
        await w.close();
      }
    };
  };

/** Resolves once the warning steer is admitted (its receipt is where the process dies). */
const steerAdmitted = ({ w, id }: Crashed): Promise<void> =>
  until("the steer admitted", async () => {
    return (await recordOf(w, await w.job(id), `warn-${id}`)) !== undefined;
  });

/**
 * The run's harness, its process stopped (`close`, as a crash would leave
 * pi) as soon as the first submission whose `requestId` starts with `prefix`
 * is admitted: before `running` is written, and before pi runs any of it.
 */
function stoppedAfterSubmit(prefix: string): (harness: Harness) => RunDeps["harness"] {
  let stopped = false;
  const stopping = (harness: Harness, conversation: Conversation): Conversation =>
    new Proxy(conversation, {
      get(target, key): unknown {
        if (key === "submit") {
          return async (...args: Parameters<Conversation["submit"]>): Promise<Submission> => {
            const submission = await target.submit(...args);
            if (!stopped && args[0].requestId?.startsWith(prefix) === true) {
              stopped = true;
              await harness.close(context);
            }
            return submission;
          };
        }
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });
  return (harness) => ({
    commit: harness.commit.bind(harness),
    conversation: async (...args): Promise<Conversation | undefined> => {
      const opened = await harness.conversation(...args);
      return opened === undefined ? undefined : stopping(harness, opened);
    },
  });
}

/** `running` transitions' payloads, in order. */
const runningPayloads = (events: readonly JobEvent[]): JobEvent["payload"][] =>
  events.filter((event) => eventLabel(event) === "transition:running").map((e) => e.payload);

describe("enabled restart: the in-flight job rejoined, phase B then resume() (VT-1, VT-4, EX-2, EX-4)", () => {
  it("row 1: crashed before its conversation was recorded: none made disabled, then recorded once", async () => {
    const c = await crashedAt("conversation", []);
    const parked = await restart(c.w, { enabled: false });
    expect((await parked.job(c.id)).conversationId).toBeUndefined();

    const { r, job } = await rejoined({ ...c, w: parked });

    expect(job.state).toBe("needs_review");
    expect(kinds(await r.events(c.id)).filter((kind) => kind === "conversation")).toHaveLength(1);
  });

  it("row 3: crashed before the base was recorded: refreshed, branch made, run, collected", async () => {
    const c = await crashedAt("refreshed", []);

    const { r, job } = await rejoined(c);

    expect(job.state).toBe("needs_review");
    expect(kinds(await r.events(c.id)).filter((kind) => kind === "refreshed")).toHaveLength(1);
    expect(c.room.calls).toEqual(expect.arrayContaining(["refresh", "rev-parse", "switch"]));
  });

  it("row 4 (VT-4): based, no initial submission: branch ensured, prompt submitted with requestId = job id", async () => {
    const c = await crashedAt("prompt", []);

    const { r, job } = await rejoined(c);

    expect(job.state).toBe("needs_review");
    expect(c.room.calls).not.toContain("refresh");
    expect(c.room.calls).toEqual(expect.arrayContaining(["rev-parse", "switch"]));
    const [running] = runningPayloads(await r.events(c.id));
    expect(running).toMatchObject({ requestId: c.id });
    expect(r.faux.state.callCount).toBe(2);
  });

  it("row 4: job/<id> at another oid: failed job_branch_moved, nothing asked of the harness (R2)", async () => {
    const c = await crashedAt("prompt", []);
    c.w.room.git("switch", "--quiet", "work");
    c.w.room.commit("src/other.ts");
    const moved = c.w.room.git("rev-parse", "HEAD");
    c.w.room.git("branch", "--force", `job/${c.id}`, moved);

    const { r, job } = await rejoined(c);

    expect(job).toMatchObject({ state: "failed", failure: { reason: "job_branch_moved" } });
    expect((await r.harness.inspect(context)).scheduling).toBe("paused");
    expect(r.faux.state.callCount).toBe(0);
  });

  it("row 5 (VT-4): admitted, running never written: recorded running, no branch judgement, continued", async () => {
    const c = await started(undefined, [], { harness: stoppedAfterSubmit("pj-") });
    await c.w.scheduler.idle();

    const { r, job } = await rejoined(c);

    expect(job.state).toBe("needs_review");
    expect(c.room.calls).not.toContain("rev-parse");
    expect(c.room.calls).not.toContain("switch");
    const initial = await recordOf(r, job, c.id);
    expect(runningPayloads(await r.events(c.id))).toEqual([
      expect.objectContaining({ requestId: c.id, submissionId: String(initial?.id) }),
    ]);
  });

  it("row 6: a recorded pause, waiting_room never written: aborted, waiting_room, resumed once", async () => {
    const c = await crashedAt("transition:waiting_room", [lostBash()]);
    const users: string[][] = [];

    const { r, job } = await rejoined(c, [
      (request): AssistantMessage => {
        users.push(userTexts(request.messages));
        return writeAndCommit();
      },
      answer(),
    ]);

    expect(job).toMatchObject({ state: "needs_review", pauseCount: 1, pauseRequested: false });
    const events = await r.events(c.id);
    expect(kinds(events).filter((kind) => kind === "transition:waiting_room")).toHaveLength(1);
    expect(runningPayloads(events).at(-1)).toMatchObject({ requestId: `resume-${c.id}-1` });
    expect(users[0]?.filter((text) => text === RESUME_TEXT)).toHaveLength(1);
  });

  it("row 7 then 12: settled, collecting never written: collecting at startup, then collected once", async () => {
    const c = await crashedAt("transition:collecting", WORK());

    const { job } = await rejoined(c, []);

    expect(job).toMatchObject({ state: "needs_review", endReason: "completed" });
    expect(c.room.calls.filter((verb) => verb === "collect")).toHaveLength(1);
  });

  it("row 8: crashed mid-tool: the tool interrupted, model_requests counted on (A3), collected", async () => {
    const c = await inFlight([call("wait", {})]);
    c.w.crash();
    const before = await c.w.job(c.id);

    const { r, job } = await rejoined(c);

    expect(job.state).toBe("needs_review");
    const [interrupted] = await jobToolResults(r, job);
    expect(interrupted === undefined ? "" : textOf(interrupted)).toContain("interrupted");
    expect(job.modelRequests).toBe(before.modelRequests + 2);
  });

  it("row 8, the room's host key changed meanwhile: the rejoined run aborts to collecting, host_key, never waiting_room (EX-5)", async () => {
    const c = await inFlight([call("wait", {})]);
    c.w.crash();
    c.room.untrusted = (): Error => new HostKeyChangedError("the host key changed");

    const { r, job } = await rejoined(c);

    expect(job).toMatchObject({ state: "failed", endReason: "error", pauseRequested: false });
    const events = await r.events(c.id);
    expect(kinds(events)).not.toContain("transition:waiting_room");
    expect(kinds(events)).not.toContain("pause");
    expect(eventOf(events, "transition:collecting")?.payload).toMatchObject({ reason: "host_key" });
    expect(c.room.calls).toContain("collect");
  });

  it("row 8 (VT-3): parked while disabled, the deadline is re-armed with only pre-park active time", async () => {
    const c = await inFlight([call("wait", {})]);
    c.w.crash();
    const parked = await restart(c.w, { enabled: false });
    parked.advance(3600 * 1000);

    const { r, job } = await rejoined({ ...c, w: parked });

    const limitMs = recordedPolicy(job.policy ?? {}).ceilings.active_wall_clock_s * 1000;
    const deadline = Math.max(...r.timers.armed.map((timer) => timer.ms));
    expect(limitMs - deadline).toBeLessThan(1000);
    expect(job.state).toBe("needs_review");
  });

  it("row 9 (usage): crashed after the steer's admission, before its receipt: one steer, receipted once", async () => {
    const c = await inFlight([writeAndCommit(), call("wait", {})], {
      crashAt: "warning",
      ceilings: { model_requests: 3 },
    });
    await steerAdmitted(c);
    const users: string[][] = [];

    const { r, job } = await rejoined(c, [
      (request): AssistantMessage => {
        users.push(userTexts(request.messages));
        return answer();
      },
    ]);

    const steer = await recordOf(r, job, `warn-${c.id}`);
    expect(warningEvents(await r.events(c.id)).map((event) => event.payload)).toEqual([
      { requestId: `warn-${c.id}`, submissionId: String(steer?.id), trigger: "usage" },
    ]);
    expect(users[0]?.filter((text) => text === WARNING_TEXT)).toHaveLength(1);
    expect(job).toMatchObject({ state: "needs_review", endReason: "completed", modelRequests: 3 });
  });

  it("row 9 (R3): only the admitted steer proves the threshold: resubmitted, receipted with its id", async () => {
    const c = await inFlight([call("wait", {})], { crashAt: "warning" });
    // Fired early: at restart neither the clock nor usage passes the threshold.
    c.w.timers.fire("shortest");
    await steerAdmitted(c);

    const { r, job } = await rejoined(c);

    const steer = await recordOf(r, job, `warn-${c.id}`);
    expect(warningEvents(await r.events(c.id)).map((event) => event.payload)).toEqual([
      { requestId: `warn-${c.id}`, submissionId: String(steer?.id), trigger: "usage" },
    ]);
    expect(job.state).toBe("needs_review");
  });
});

/** Resolves once `c`'s process died at its first probe (`dieAtProbe`): left `waiting_room`, the room back up. */
async function diedWaiting(c: Crashed): Promise<Crashed> {
  await until("waiting_room", () => c.room.calls.includes("probe"));
  c.room.before = undefined;
  c.room.down = false;
  return c;
}

/** A job left `waiting_room` (shape b): paused, the room down, the process dead at its first probe. */
const leftWaiting = async (options: RunWorldOptions = {}): Promise<Crashed> =>
  diedWaiting(
    await started(undefined, [lostBash()], { down: true, before: dieAtProbe, ...options }),
  );

/** The user texts the restarted model is first asked with, and the script that answers it. */
function heard(): { users: string[][]; script: FauxResponseStep[] } {
  const users: string[][] = [];
  return {
    users,
    script: [
      (request): AssistantMessage => {
        users.push(userTexts(request.messages));
        return writeAndCommit();
      },
      answer(),
    ],
  };
}

describe("enabled restart: waiting, collection, and close as the fault (VT-1, EX-4, R1, R2)", () => {
  it("row 11 (shape b): probed before anything asks pi for progress (R1); resumed once", async () => {
    const harnesses: Harness[] = [];
    const c = await leftWaiting({
      harness: (harness) => {
        harnesses.push(harness);
        return harness;
      },
    });
    const atProbe: string[] = [];
    c.room.before = async (verb): Promise<void> => {
      if (verb === "probe") {
        atProbe.push((await harnesses.at(-1)?.inspect(context))?.scheduling ?? "");
      }
    };
    const { users, script } = heard();

    const { r, job } = await rejoined(c, script);

    expect(atProbe).toEqual(["paused"]);
    expect(job).toMatchObject({ state: "needs_review", pauseCount: 1 });
    expect(runningPayloads(await r.events(c.id)).at(-1)).toMatchObject({
      requestId: `resume-${c.id}-1`,
    });
    expect(users[0]?.filter((text) => text === RESUME_TEXT)).toHaveLength(1);
    expect(users[0]?.some((text) => text.includes(WARNING_TEXT))).toBe(false);
  });

  it("row 11 (shape c): the resume admitted, running never written: the same resume, sent once (EX-4)", async () => {
    const c = await started(undefined, [lostBash()], { harness: stoppedAfterSubmit("resume-") });
    await c.w.scheduler.idle();
    const { users, script } = heard();

    const { r, job } = await rejoined(c, script);

    expect(job).toMatchObject({ state: "needs_review", pauseCount: 1 });
    const resumed = await recordOf(r, job, `resume-${c.id}-1`);
    expect(runningPayloads(await r.events(c.id)).at(-1)).toMatchObject({
      requestId: `resume-${c.id}-1`,
      submissionId: String(resumed?.id),
    });
    expect(users[0]?.filter((text) => text === RESUME_TEXT)).toHaveLength(1);
  });

  it("row 10: a withdrawn warning on record: the resume carries it, receipted once (trigger resume)", async () => {
    const c = await started(
      undefined,
      [
        fauxAssistantMessage(
          [
            fauxToolCall("wait", {}, { id: "held" }),
            fauxToolCall("bash", { command: `echo ${ROOM_DOWN}` }, { id: "lost" }),
          ],
          { stopReason: "toolUse" },
        ),
      ],
      { down: true, before: dieAtProbe },
    );
    await within(SETTLE_MS, "the wait tool", c.tool);
    c.w.timers.fire("shortest");
    await warned(c.w, c.id);
    c.w.blocking.release();
    await diedWaiting(c);
    const { users, script } = heard();

    const { r, job } = await rejoined(c, script);

    expect(warningEvents(await r.events(c.id)).map((event) => event.payload)).toMatchObject([
      { requestId: `warn-${c.id}`, trigger: "wall_clock" },
      { requestId: `resume-${c.id}-1`, trigger: "resume" },
    ]);
    expect(users[0]?.filter((text) => text.includes(WARNING_TEXT))).toEqual([
      `${RESUME_TEXT}\n\n${WARNING_TEXT}`,
    ]);
    expect(job.state).toBe("needs_review");
  });

  it("row 11 waited out from state_entered_at: pending_collection room_unavailable, no resume (R2)", async () => {
    const c = await leftWaiting();
    c.room.down = true;
    c.w.advance(120 * 1000);
    c.room.calls.length = 0;

    const r = await restart(c.w, { enabled: true });
    await until("waited out", async () => (await r.job(c.id)).state !== "waiting_room");
    r.crash();

    const events = await r.events(c.id);
    expect(eventOf(events, "transition:pending_collection")?.payload).toMatchObject({
      from: "waiting_room",
      reason: "room_unavailable",
    });
    // One probe, at the bound already passed: no backoff, no resume, nothing asked of pi.
    expect(c.room.calls.slice(0, 2)).toEqual(["connect", "probe"]);
    expect(runningPayloads(events)).toHaveLength(1);
    expect((await r.harness.inspect(context)).scheduling).toBe("paused");
  });

  it("row 3 by close: stopped at the refresh: refreshed again, run, collected", async () => {
    const c = await started(undefined, [], { before: closingAt("refresh") });
    await c.w.scheduler.idle();

    const { job } = await rejoined(c);

    expect(job).toMatchObject({ state: "needs_review", class: "complete" });
  });

  it("row 8 by close: stopped mid-tool: continued and collected", async () => {
    const c = await inFlight([call("wait", {})]);
    await c.w.close();

    const { job } = await rejoined(c);

    expect(job).toMatchObject({ state: "needs_review", class: "complete" });
  });

  it("row 12 by close: stopped mid-collect: collected again (idempotent fetch), recorded once", async () => {
    const c = await started(undefined, WORK(), {
      before: closingAt("collect"),
    });
    await c.w.scheduler.idle();

    const { r, job } = await rejoined(c, []);

    expect(job).toMatchObject({ state: "needs_review", class: "complete" });
    expect(c.room.calls.filter((verb) => verb === "collect")).toHaveLength(1);
    expect(kinds(await r.events(c.id)).filter((kind) => kind === "collected")).toHaveLength(1);
  });

  it("shape (e): a leftover pause on a collecting row is inert: collected, never waiting", async () => {
    const c = await crashedAt("collected", WORK());
    const parked = await restart(c.w, { enabled: false });
    await parked.jobs.change(c.id, T0, () => ({
      update: { pauseRequested: true },
      event: { kind: "pause", payload: {} },
    }));

    const { r, job } = await rejoined({ ...c, w: parked }, []);

    expect(job).toMatchObject({ state: "needs_review", pauseCount: 0 });
    expect(kinds(await r.events(c.id))).not.toContain("transition:waiting_room");
  });
});

describe("Go reconcile fixtures, ported (EX-5)", () => {
  // TestReconcile_FailsCrashedRunner: Go failed a crashed `running` row; DEC-054 recovers it.
  it("FailsCrashedRunner: a crashed running row is recovered (continued and collected), not failed", async () => {
    const c = await inFlight([call("wait", {})]);
    c.w.crash();

    const { job } = await rejoined(c);

    expect(job).toMatchObject({ state: "needs_review", endReason: "completed" });
  });

  // TestReconcile_IgnoresNonRunningStates: queued and terminal rows are left to the scheduler.
  it("IgnoresNonRunningStates: phase A leaves queued and terminal rows as they are", async () => {
    const done = await started(undefined, WORK());
    const finished = await settled(done.w, done.id);
    const queued = await done.w.jobs.submit({ ...NEW_JOB, submissionId: "sub-q" }, T0);
    const before = await Promise.all([finished.id, queued.job.id].map((id) => done.w.events(id)));

    await recoverHost(done.w.recoverDeps, true);

    const after = await Promise.all([finished.id, queued.job.id].map((id) => done.w.events(id)));
    expect(after).toEqual(before);
    expect(await done.w.job(queued.job.id)).toMatchObject({ state: "queued" });
  });
});
