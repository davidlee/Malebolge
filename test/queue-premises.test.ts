/**
 * The two queue premises DEC-036 rests on for `satan.post`, pinned against
 * pi-durable as malebolge opens it today: (b) two follow-up posts queued behind
 * a busy recipient are placed in two runs, so each answers in its own context,
 * and (c) withdrawing one queued post with `harness.abortSubmission` leaves its
 * queued siblings in place. No post code exists yet: these drive
 * `Conversation.submit` and `harness.abortSubmission` directly.
 *
 * It also holds ASM-006, SL-009's standing premise: a `write` carrying model
 * content on an IDLE conversation appends its entry for the next run and starts
 * no run itself, and the next input's run sees the entry.
 */

import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { context } from "../src/context.ts";
import {
  heldTurn,
  only,
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

/** ASM-006's write: a SATAN note, its text carried as model content the run must see. */
const NOTE = "the build is green";
/** The write's request id, as a bridge note's would be. */
const NOTE_REQUEST = "bridge:note:1";
/** The request id of the input submitted after the write. */
const FOLLOWING = "bridge:turn:1";

/**
 * Every message's role and text the model is given, in order: a note's content
 * is not a user message by right, so read every role rather than the user's.
 */
const spoken = (messages: readonly Message[]): string[] =>
  messages.flatMap((message): string[] => {
    const { content } = message;
    const text =
      typeof content === "string"
        ? content
        : content.map((block) => (block.type === "text" ? block.text : "")).join("");
    return text === "" ? [] : [`${message.role}:${text}`];
  });

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

describe("ASM-006: a write with model content on an idle conversation", () => {
  it("appends the note without starting a run, and the next input's run sees it", async () => {
    const world = wakeWorld();
    const session = await world.open();
    const turns = recordedTurn();
    world.faux.setResponses(Array.from({ length: 4 }, () => turns.step));

    // Idle: no run holds the conversation, so the write settles at once.
    const write = await session.root.submit(
      {
        type: "write",
        requestId: NOTE_REQUEST,
        entry: {
          kind: "satan.bridge",
          data: { kind: "note", project: "malebolge" },
          model: [{ role: "user", content: NOTE, timestamp: world.clock.now() }],
        },
      },
      context,
    );
    expect((await write.wait(context)).status).toBe("done");

    // Appending an entry asks the model nothing: the write started no run.
    expect(world.faux.state.callCount).toBe(0);
    expect(turns.seen).toEqual([]);

    await (
      await session.root.submit({ type: "input", content: "next", requestId: FOLLOWING }, context)
    ).wait(context);

    // The next input's run is the first request, and it was given the note first.
    expect(world.faux.state.callCount).toBe(1);
    const lines = spoken(only(turns.seen));
    const note = lines.indexOf(`user:${NOTE}`);
    expect(note).toBeGreaterThanOrEqual(0);
    expect(lines.indexOf("user:next")).toBeGreaterThan(note);
  });
});
