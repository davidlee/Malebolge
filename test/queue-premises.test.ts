/**
 * The two queue premises DEC-036 rests on for `satan.post`, pinned against
 * pi-durable as malebolge opens it today: (b) two follow-up posts queued behind
 * a busy recipient are placed in two runs, so each answers in its own context,
 * and (c) withdrawing one queued post with `harness.abortSubmission` leaves its
 * queued siblings in place. No post code exists yet: these drive
 * `Conversation.submit` and `harness.abortSubmission` directly.
 */

import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { context } from "../src/context.ts";
import {
  heldTurn,
  type RecordedTurn,
  recordedTurn,
  submissionOf,
  userText,
  WAIT,
  type WakeSession,
  type WakeWorld,
  wakeWorld,
} from "./wake-fixture.ts";

/** The post whose fate each test follows. */
const POST = "post:44:";
/** A second post, queued behind the first. */
const NEXT_POST = "post:45:";
/** Any other queued input, standing in for a `wake:...` one. */
const SIBLING = "manual:second";

/** What the model was told as user input, in order: the context of one request. */
const userTexts = (messages: readonly Message[]): string[] =>
  messages.map(userText).filter((text) => text !== "");

/** A conversation whose foreground run is held mid-turn, and the posts queued behind it. */
async function heldBackground(): Promise<{
  readonly world: WakeWorld;
  readonly session: WakeSession;
  readonly answered: RecordedTurn;
  readonly release: () => void;
  readonly queued: (requestId: string) => Promise<string | undefined>;
}> {
  const world = wakeWorld();
  const session = await world.open();
  const held = heldTurn();
  const answered = recordedTurn();
  world.faux.setResponses([held.step, ...Array.from({ length: 8 }, () => answered.step)]);
  await session.root.submit({ type: "input", content: "foreground" }, context);
  await held.reached;
  return {
    world,
    session,
    answered,
    release: held.release,
    queued: async (requestId: string): Promise<string | undefined> =>
      (await submissionOf(session.harness, session.root.id, requestId))?.status,
  };
}

describe("DEC-036 (b): a post queued behind a busy recipient", () => {
  it("two posts queued behind a busy recipient are placed in two runs", async () => {
    const { world, session, answered, release, queued } = await heldBackground();

    await session.root.submit(
      { type: "input", content: "first post", whenBusy: "followUp", requestId: POST },
      context,
    );
    await session.root.submit(
      { type: "input", content: "second post", whenBusy: "followUp", requestId: NEXT_POST },
      context,
    );
    expect(await queued(POST)).toBe("queued");
    expect(await queued(NEXT_POST)).toBe("queued");

    release();
    await vi.waitFor(async () => {
      expect(await queued(POST)).toBe("done");
      expect(await queued(NEXT_POST)).toBe("done");
    }, WAIT);

    // One model call for the held foreground, then one per post: three runs, not two.
    expect(world.faux.state.callCount).toBe(3);
    // The run that answers `post:44:` does not yet see `post:45:`'s input.
    expect(answered.seen.map(userTexts)).toEqual([
      ["foreground", "first post"],
      ["foreground", "first post", "second post"],
    ]);
  });
});

describe("DEC-036 (c): withdrawing a queued post", () => {
  it("withdrawing one queued post leaves the other queued input in place", async () => {
    const { world, session, answered, release, queued } = await heldBackground();

    await session.root.submit(
      { type: "input", content: "first post", whenBusy: "followUp", requestId: POST },
      context,
    );
    await session.root.submit(
      { type: "input", content: "sibling", whenBusy: "followUp", requestId: SIBLING },
      context,
    );
    expect(await queued(POST)).toBe("queued");
    expect(await queued(SIBLING)).toBe("queued");

    const record = await submissionOf(session.harness, session.root.id, POST);
    if (record === undefined) {
      throw new Error(`${POST} was never admitted`);
    }
    const answer = await session.harness.abortSubmission(record.id, context);
    expect(answer).toBe("aborted");
    expect(await queued(POST)).toBe("unanswered");
    expect(await queued(SIBLING)).toBe("queued");

    release();
    await vi.waitFor(async () => {
      expect(await queued(SIBLING)).toBe("done");
    }, WAIT);
    expect(await queued(POST)).toBe("unanswered");

    // The withdrawn post never reached the model; the sibling was placed and answered.
    expect(world.faux.state.callCount).toBe(2);
    expect(answered.seen.map(userTexts)).toEqual([["foreground", "sibling"]]);
  });
});
