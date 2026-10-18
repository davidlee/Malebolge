// Restart recovery, phase A (PHASE-10 batch A; DEC-054, DEC-065): each job
// state reached by a real run that dies at a write boundary (`crashAt`), then
// the runner restarted on the same store file. Disabled (I14, EX-6): no room
// verb, no env command, nothing timed out, the harness never asked for
// progress. Parking (EX-7): parked once, re-based once.

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Connection } from "@earendil-works/pi-env";
import { describe, expect, it } from "vitest";
import { context } from "../../src/context.ts";
import { readSnapshot } from "../../src/runner/recover.ts";
import { ChannelUnavailable, type GitChannel } from "../../src/runner/room.ts";
import type { Job } from "../../src/runner/store.ts";
import {
  answer,
  eventOf,
  kinds,
  lostBash,
  restart,
  roomGoesDown,
  type RunWorld,
  type RunWorldOptions,
  runWorld,
  storeFile,
  until,
  writeAndCommit,
} from "./run-fixture.ts";

/** The room as the test sets it, and every verb or connection the runner asked of it. */
interface Room {
  down: boolean;
  calls: string[];
  /** Told of each probe, before it is answered. */
  probed?: (() => void) | undefined;
}

/** The fake slot and the local daemon, watched; `down` makes probes fail and collection unavailable. */
const watched = (room: Room): Pick<RunWorldOptions, "channel" | "connection"> => ({
  channel: (channel): GitChannel => ({
    refresh: (repo, baseRef): ReturnType<GitChannel["refresh"]> => {
      room.calls.push("refresh");
      return channel.refresh(repo, baseRef);
    },
    collect: async (repo, jobId): ReturnType<GitChannel["collect"]> => {
      room.calls.push("collect");
      if (room.down) {
        throw new ChannelUnavailable("room down");
      }
      return channel.collect(repo, jobId);
    },
    reachable: async (): Promise<boolean> => {
      room.calls.push("probe");
      room.probed?.();
      return !room.down && (await channel.reachable());
    },
  }),
  connection: (local): Connection => {
    room.calls.push("connect");
    return roomGoesDown()(local);
  },
});

/** Past every bound: `max_room_wait` and `max_pending_collection`. */
const LONG_MS = 10 * 24 * 3600 * 1000;

interface Crashed {
  w: RunWorld;
  id: string;
  room: Room;
}

/** A job run until the process dies at write `crashAt`; the room `down` throughout if asked. */
async function crashedAt(
  crashAt: string,
  script: AssistantMessage[],
  { down = false, ...options }: { down?: boolean } & RunWorldOptions = {},
): Promise<Crashed> {
  const room: Room = { down, calls: [] };
  const w = await runWorld({ path: await storeFile(), crashAt, ...watched(room), ...options });
  w.faux.setResponses(script);
  const { id } = await w.submit();
  await w.scheduler.idle();
  return { w, id, room };
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
    room.probed = (): void => {
      w.crash();
    };
    w.faux.setResponses([writeAndCommit(), answer()]);
    const { id } = await w.submit();
    await w.scheduler.idle();
    room.probed = undefined;
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
