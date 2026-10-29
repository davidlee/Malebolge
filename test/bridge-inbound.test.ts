// SL-009 PHASE-07 VT-6 (inbound turn / note), VT-1 (idempotence), VT-4 (framing
// and caps), VT-2 F-2 (the withdrawal notice) and VT-3 F-4 (an undeliverable
// notice), through the real listener on a private socket and over the pure
// helpers of src/bridge/inbound.ts. Written red first against
// .doctrine/state/slice/009/briefs/phase-07-contract.md.

import type { Message } from "@earendil-works/pi-ai";
import type {
  ConversationHandle,
  ConversationId,
  EntryRecord,
  Submission,
  SubmissionId,
  SubmissionRecord,
} from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import { BRIDGE_BODY_MAX_BYTES, capHeadTail, type DaemonFrame } from "../pi-bridge/wire.ts";
import {
  BRIDGE_ENTRY_KIND,
  bridgeContent,
  bridgeRequestId,
  followOnce,
  notDeliveredText,
  submitInbound,
} from "../src/bridge/inbound.ts";
import { appendOutbox, BRIDGE_OUTBOX_CAP, type OutboxEntry } from "../src/bridge/pairing.ts";
import { context } from "../src/context.ts";
import { isConversationKey } from "../src/conversations.ts";
import { escapeXml } from "../src/xml.ts";
import {
  type BridgeSatanCall,
  type BridgeWorld,
  bridgeWorld,
  type PiClient,
} from "./bridge-fixture.ts";
import { heldTurn, only, recordedTurn, userText, WAIT } from "./wake-fixture.ts";

/** A conversation key as the wire carries it, through a guard: pi-durable's ids are opaque. */
const idOf = (conversation: string): ConversationId => {
  const id = Number(conversation);
  if (!isConversationKey(id)) {
    throw new Error(`not a conversation id: ${conversation}`);
  }
  return id;
};

/** Whether `n` could be a submission id: a positive safe integer. */
const isSubmissionId = (n: number): n is SubmissionId => Number.isSafeInteger(n) && n > 0;

/** A submission id no live submission carries (the failed-wait case invents one). */
const fabricatedId = (n: number): SubmissionId => {
  if (!isSubmissionId(n)) {
    throw new Error(`test id ${String(n)} is no submission id`);
  }
  return n;
};

/** The submission's id, or a failure: the cases that abort one require a record. */
const submissionIdOf = (record: SubmissionRecord | undefined): SubmissionId => {
  if (record === undefined) {
    throw new Error("no submission record");
  }
  return record.id;
};

/** A submission whose every read fails: the one ending the notice cannot read. */
const failingSubmission = (id: SubmissionId): Submission => ({
  id,
  status: (): Promise<never> => Promise.reject(new Error("the run went away")),
  wait: (): Promise<never> => Promise.reject(new Error("the run went away")),
  abort: (): Promise<never> => Promise.reject(new Error("the run went away")),
});

/** A conversation handle whose `submit` answers `submission`, and whose other reads find nothing. */
const failingHandle = (id: ConversationId, submission: Submission): ConversationHandle => ({
  id,
  submit: (): Promise<Submission> => Promise.resolve(submission),
  abort: (): Promise<never> => Promise.reject(new Error("no conversation")),
  waitForIdle: (): Promise<never> => Promise.reject(new Error("no conversation")),
});

/** The submission a post's request id already admitted, when one was. */
const submissionOf = (
  world: BridgeWorld,
  conversation: string,
  requestId: string,
): Promise<SubmissionRecord | undefined> =>
  world.test.harness.commit((tx) => tx.submissionByRequest(idOf(conversation), requestId), context);

/** The conversation's unsettled submissions, as the harness inspects them. */
const liveSubmissions = async (world: BridgeWorld): Promise<readonly SubmissionRecord[]> =>
  (await world.test.harness.inspect(context)).submissions;

/** Waits until the submission behind `requestId` reaches `status`. */
async function waitForStatus(
  world: BridgeWorld,
  conversation: string,
  requestId: string,
  status: string,
): Promise<void> {
  await vi.waitFor(async () => {
    expect((await submissionOf(world, conversation, requestId))?.status).toBe(status);
  }, WAIT);
}

/** The conversation's committed entries, oldest first. */
async function entriesOf(world: BridgeWorld, conversation: string): Promise<EntryRecord[]> {
  const of = await world.openDurable(conversation);
  const page = await of.entries({}, 100, undefined, context);
  return [...page.items].reverse();
}

/** The bridge's entries in `conversation`, oldest first. */
async function bridgeEntriesOf(world: BridgeWorld, conversation: string): Promise<EntryRecord[]> {
  const entries = await entriesOf(world, conversation);
  return entries.filter((entry) => entry.kind === BRIDGE_ENTRY_KIND);
}

/** The conversation's outbox as committed. */
const outboxOf = async (world: BridgeWorld, conversation: string): Promise<OutboxEntry[]> =>
  (await world.pairingOf(conversation)).outbox;

/** Every notify the bridge sent. */
const notifies = (world: BridgeWorld): BridgeSatanCall[] =>
  world.satanCalls.filter((call) => call.tool === "notify_send");

/** The deliver frames pi received so far. */
const deliveries = (client: PiClient): DaemonFrame[] =>
  client.received().filter((frame) => frame.type === "deliver");

/** Send `frame` and read its answer, stepping over the deliveries pi is pushed. */
async function answerTo(client: PiClient, frame: object): Promise<DaemonFrame> {
  await client.send(frame);
  let next = await client.next();
  while (next.type === "deliver") {
    next = await client.next();
  }
  return next;
}

/** What the model was told as user input, in order. */
const inputsOf = (messages: readonly Message[]): string[] =>
  messages.map(userText).filter((text) => text !== "");

describe("bridgeContent (VT-4 framing)", () => {
  it("wraps the body in a bridge element naming pi, the project and the kind", () => {
    expect(bridgeContent("proj", "turn", "hello")).toBe(
      '<bridge from="pi" project="proj" kind="turn">hello</bridge>',
    );
    expect(bridgeContent("proj", "note", "hello")).toBe(
      '<bridge from="pi" project="proj" kind="note">hello</bridge>',
    );
  });

  it("escapes the project and the body through escapeXml: < > & \" '", () => {
    const content = bridgeContent('a&b"c', "note", `<x & "y"> it's`);
    expect(content).toBe(
      '<bridge from="pi" project="a&amp;b&quot;c" kind="note">' +
        "&lt;x &amp; &quot;y&quot;&gt; it&apos;s</bridge>",
    );
    // The body is the escaped text, not the raw one: a wrong implementation that escapes
    // only the attributes leaves the raw tag in the model's context.
    expect(content).not.toContain("<x & " + '"y">');
  });

  it("caps an over-long body head-and-tail before escaping, keeping its cut marker", () => {
    const text = "x".repeat(BRIDGE_BODY_MAX_BYTES + 40);
    const content = bridgeContent("proj", "turn", text);
    const open = '<bridge from="pi" project="proj" kind="turn">';
    const body = content.slice(open.length, -"</bridge>".length);
    expect(content).toBe(`${open}${escapeXml(capHeadTail(text, BRIDGE_BODY_MAX_BYTES))}</bridge>`);
    expect(body).toMatch(/\[… \d+ bytes cut …\]/);
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(BRIDGE_BODY_MAX_BYTES);
    expect(body.length).toBeLessThan(text.length);
  });
});

describe("the withdrawal notice text (VT-2 F-2)", () => {
  it("names the message and its ending: not delivered: withdrawn", () => {
    expect(notDeliveredText("X", { kind: "withdrawn", reason: "unanswered (aborted)" })).toBe(
      "bridge message X not delivered: withdrawn (unanswered (aborted))",
    );
  });

  it("says delivered-incomplete for a turn placed but unanswered", () => {
    expect(
      notDeliveredText("Y", { kind: "delivered-incomplete", reason: "unanswered (cancelled)" }),
    ).toBe("bridge message Y not delivered: delivered-incomplete (unanswered (cancelled))");
  });
});

describe("followOnce (VT-2)", () => {
  it("runs start once per submission id, so a resend joins the original's watch", () => {
    const watches = new Map<SubmissionId, Promise<void>>();
    const starts: string[] = [];
    const start = (tag: string) => (): Promise<void> => {
      starts.push(tag);
      return Promise.resolve();
    };
    followOnce(watches, fabricatedId(1), start("first"));
    followOnce(watches, fabricatedId(1), start("second"));
    followOnce(watches, fabricatedId(2), start("other"));
    expect(starts).toEqual(["first", "other"]);
    expect(watches.size).toBe(2);
  });
});

describe("bridgeRequestId (VT-1)", () => {
  it("scopes the dedupe key to the conversation: bridge:<c>:<id>", () => {
    expect(bridgeRequestId(idOf("7"), "abc")).toBe("bridge:7:abc");
    expect(bridgeRequestId(idOf("7"), "abc")).not.toBe(bridgeRequestId(idOf("8"), "abc"));
  });
});

describe("post a turn (VT-6)", () => {
  it("answers accepted with the id, and the model reads the escaped envelope as one run", async () => {
    const world = await bridgeWorld();
    const turns = recordedTurn();
    world.test.faux.setResponses([turns.step]);
    const { client, conversation } = await world.pair("delegate", "proj");

    expect(
      await answerTo(client, { type: "post", id: "t1", kind: "turn", text: "hello <pi>" }),
    ).toEqual({ type: "accepted", id: "t1" });

    const requestId = `bridge:${conversation}:t1`;
    await waitForStatus(world, conversation, requestId, "done");
    expect(world.test.faux.state.callCount).toBe(1);
    expect(inputsOf(only(turns.seen))).toEqual([
      '<bridge from="pi" project="proj" kind="turn">hello &lt;pi&gt;</bridge>',
    ]);

    const [entry, ...rest] = await bridgeEntriesOf(world, conversation);
    expect(rest).toEqual([]);
    expect(entry?.kind).toBe(BRIDGE_ENTRY_KIND);
    expect(entry?.data).toEqual({ kind: "turn", project: "proj" });
  });

  it("queues a busy conversation's turn as a followUp, placed after the run that holds it", async () => {
    const world = await bridgeWorld();
    const held = heldTurn();
    const answers = recordedTurn();
    world.test.faux.setResponses([held.step, answers.step]);
    const { client, conversation } = await world.pair("delegate", "proj");

    expect(await answerTo(client, { type: "post", id: "t1", kind: "turn", text: "first" })).toEqual(
      { type: "accepted", id: "t1" },
    );
    await held.reached;

    // Accepted before the holding run ends: the busy conversation queues the followUp.
    expect(
      await answerTo(client, { type: "post", id: "t2", kind: "turn", text: "second" }),
    ).toEqual({ type: "accepted", id: "t2" });
    expect((await submissionOf(world, conversation, `bridge:${conversation}:t2`))?.status).toBe(
      "queued",
    );

    held.release();
    await waitForStatus(world, conversation, `bridge:${conversation}:t1`, "done");
    await waitForStatus(world, conversation, `bridge:${conversation}:t2`, "done");

    // Two runs: the first never saw the second's input; the second was placed after it.
    expect(world.test.faux.state.callCount).toBe(2);
    expect(inputsOf(only(answers.seen))).toEqual([
      '<bridge from="pi" project="proj" kind="turn">first</bridge>',
      '<bridge from="pi" project="proj" kind="turn">second</bridge>',
    ]);
  });
});

describe("post a note (VT-6)", () => {
  it("answers accepted and appends a write that starts no run, which the next turn's context holds", async () => {
    const world = await bridgeWorld();
    const turns = recordedTurn();
    world.test.faux.setResponses([turns.step]);
    const { client, conversation } = await world.pair("delegate", "proj");

    expect(
      await answerTo(client, { type: "post", id: "n1", kind: "note", text: "the build is green" }),
    ).toEqual({ type: "accepted", id: "n1" });

    await waitForStatus(world, conversation, `bridge:${conversation}:n1`, "done");
    // A note is a write: it asks the model nothing.
    expect(world.test.faux.state.callCount).toBe(0);
    expect(turns.seen).toEqual([]);

    const [entry, ...rest] = await bridgeEntriesOf(world, conversation);
    expect(rest).toEqual([]);
    expect(entry?.kind).toBe(BRIDGE_ENTRY_KIND);
    expect(entry?.data).toEqual({ kind: "note", project: "proj" });
    expect(entry?.model?.[0]?.timestamp).toBe(world.host.now());

    expect(await answerTo(client, { type: "post", id: "t1", kind: "turn", text: "next" })).toEqual({
      type: "accepted",
      id: "t1",
    });
    await waitForStatus(world, conversation, `bridge:${conversation}:t1`, "done");

    // The next turn's run is the first request, and the note's content came first.
    const inputs = inputsOf(only(turns.seen));
    const note = inputs.indexOf(
      '<bridge from="pi" project="proj" kind="note">the build is green</bridge>',
    );
    expect(note).toBeGreaterThanOrEqual(0);
    expect(
      inputs.indexOf('<bridge from="pi" project="proj" kind="turn">next</bridge>'),
    ).toBeGreaterThan(note);
  });
});

describe("a resent post (VT-1 idempotence)", () => {
  it("is accepted again with one submission and one spend, even on a resumed connection", async () => {
    const world = await bridgeWorld();
    const turns = recordedTurn();
    world.test.faux.setResponses([turns.step, turns.step, turns.step]);
    const { client, conversation, token } = await world.pair("delegate", "proj");

    const post = { type: "post", id: "dup", kind: "turn", text: "hello" } as const;
    expect(await answerTo(client, post)).toEqual({ type: "accepted", id: "dup" });
    expect(await answerTo(client, post)).toEqual({ type: "accepted", id: "dup" });

    await waitForStatus(world, conversation, `bridge:${conversation}:dup`, "done");
    // A second connection (the older one superseded) resends the same id: accepted, not resubmitted.
    const again = await world.resume(conversation, token);
    expect(again.reply).toEqual({ type: "paired", conversation });
    expect(await answerTo(again.client, post)).toEqual({ type: "accepted", id: "dup" });

    expect((await world.pairingOf(conversation)).spent).toBe(1);
    expect(world.test.faux.state.callCount).toBe(1);
    // The one submission the request id owns: nothing was admitted twice.
    expect(await submissionOf(world, conversation, `bridge:${conversation}:dup`)).toMatchObject({
      requestId: `bridge:${conversation}:dup`,
      status: "done",
    });
    expect(await outboxOf(world, conversation)).toEqual([]);
  });

  it("post-once submits without a requestId", async () => {
    const world = await bridgeWorld();
    const held = heldTurn();
    world.test.faux.setResponses([held.step]);
    const { conversation, token } = await world.pair("delegate", "proj");

    const { client, reply } = await world.firstLine({
      type: "post-once",
      conversation,
      token,
      kind: "turn",
      text: "one shot",
    });
    expect(reply).toEqual({ type: "accepted" });
    expect(reply).not.toHaveProperty("id");
    await client.closed;

    // Held mid-run, the post-once submission is still live and inspectable: it carries no request id.
    await vi.waitFor(async () => {
      expect(await liveSubmissions(world)).toHaveLength(1);
    }, WAIT);
    const [live] = await liveSubmissions(world);
    expect(live?.requestId).toBeUndefined();
    expect(live?.type).toBe("input");
    // A post-once turn still spends its budget (DEC-070).
    expect((await world.pairingOf(conversation)).spent).toBe(1);
    held.release();
  });
});

describe("a withdrawn post (VT-2 F-2)", () => {
  it("appends exactly one not-delivered: withdrawn note on a resend, and delivers it to pi", async () => {
    const world = await bridgeWorld();
    const held = heldTurn();
    world.test.faux.setResponses([held.step, recordedTurn().step]);
    const { client, conversation } = await world.pair("delegate", "proj");

    // A held run makes the conversation busy, so the post stays queued and can be withdrawn.
    expect(
      await answerTo(client, { type: "post", id: "fg", kind: "turn", text: "foreground" }),
    ).toEqual({ type: "accepted", id: "fg" });
    await held.reached;

    const post = { type: "post", id: "X", kind: "turn", text: "doomed" } as const;
    expect(await answerTo(client, post)).toEqual({ type: "accepted", id: "X" });
    // The resend is the lost ack: accepted again, one submission, and no second watch.
    expect(await answerTo(client, post)).toEqual({ type: "accepted", id: "X" });

    const record = await submissionOf(world, conversation, `bridge:${conversation}:X`);
    expect(record?.status).toBe("queued");
    expect(await world.test.harness.abortSubmission(submissionIdOf(record), context)).toBe(
      "aborted",
    );

    await vi.waitFor(async () => {
      expect(await outboxOf(world, conversation)).toHaveLength(1);
    }, WAIT);
    const [notice] = await outboxOf(world, conversation);
    expect(notice?.kind).toBe("note");
    expect(notice?.text).toMatch(
      /^bridge message X not delivered: withdrawn \(unanswered \(.+\)\)$/,
    );

    // Exactly one note reached pi, and the duplicate spent nothing beyond its own turn.
    await vi.waitFor(() => {
      expect(deliveries(client)).toHaveLength(1);
    }, WAIT);
    expect(deliveries(client)[0]).toMatchObject({ type: "deliver", kind: "note" });
    expect((await world.pairingOf(conversation)).spent).toBe(2);
    expect(notifies(world)).toEqual([]);
    held.release();
  });

  it("appends nothing for a delivered turn", async () => {
    const world = await bridgeWorld();
    world.test.faux.setResponses([recordedTurn().step]);
    const { client, conversation } = await world.pair("delegate", "proj");

    expect(
      await answerTo(client, { type: "post", id: "d1", kind: "turn", text: "answered" }),
    ).toEqual({ type: "accepted", id: "d1" });
    await waitForStatus(world, conversation, `bridge:${conversation}:d1`, "done");
    // A settled watch runs on its own: give it the event loop before reading the outbox.
    await new Promise((resolve) => setTimeout(resolve, WAIT.interval));

    expect(await outboxOf(world, conversation)).toEqual([]);
    expect(deliveries(client)).toEqual([]);
    expect(notifies(world)).toEqual([]);
  });

  it("appends one delivered-incomplete note for a turn aborted mid-run", async () => {
    const world = await bridgeWorld();
    const held = heldTurn();
    world.test.faux.setResponses([held.step]);
    const { client, conversation } = await world.pair("delegate", "proj");

    expect(
      await answerTo(client, { type: "post", id: "i1", kind: "turn", text: "half a turn" }),
    ).toEqual({ type: "accepted", id: "i1" });
    await held.reached;

    const record = await submissionOf(world, conversation, `bridge:${conversation}:i1`);
    expect(record?.status).toBe("placed");
    // Placed, so it cannot be withdrawn: the operator's abort stops the run it started.
    // The held step ignores the signal, so the abort settles once the step is released.
    const aborting = (await world.openDurable(conversation)).abort(context);
    held.release();
    await aborting;

    await vi.waitFor(async () => {
      expect(await outboxOf(world, conversation)).toHaveLength(1);
    }, WAIT);
    const [notice] = await outboxOf(world, conversation);
    expect(notice?.text).toMatch(
      /^bridge message i1 not delivered: delivered-incomplete \(unanswered \(.+\)\)$/,
    );
  });

  it("logs one wait failed line and appends nothing when the wait rejects", async () => {
    const world = await bridgeWorld();
    const { conversation } = await world.pair("delegate", "proj");
    // A submission whose wait rejects: the one ending the notice cannot read.
    const failing = failingHandle(idOf(conversation), failingSubmission(fabricatedId(999)));
    const harness = new Proxy(world.test.harness, {
      get(target, property, receiver): unknown {
        if (property === "conversation") {
          return (): Promise<ConversationHandle> => Promise.resolve(failing);
        }
        // The session's methods brand-check their receiver, so the unwrapped target has
        // to be the one called; only `conversation` is overridden here.
        const member: unknown = Reflect.get(target, property, receiver);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    const host = { ...world.host, session: { ...world.host.session, harness } };

    const check = await submitInbound({ host, watches: new Map() }, idOf(conversation), {
      kind: "turn",
      text: "hello",
      id: "W1",
    });
    expect(check).toEqual({ ok: true });

    await vi.waitFor(() => {
      expect(world.logLines).toHaveLength(1);
    }, WAIT);
    expect(world.logLines[0]).toBe(
      `bridge: conversation ${conversation}: message W1: wait failed: the run went away`,
    );
    expect(await outboxOf(world, conversation)).toEqual([]);
    expect(notifies(world)).toEqual([]);
  });
});

describe("an undeliverable notice (VT-3 F-4)", () => {
  it("leaves a full outbox unchanged, logs once and notifies once", async () => {
    const world = await bridgeWorld();
    const held = heldTurn();
    world.test.faux.setResponses([held.step, recordedTurn().step]);
    const { client, conversation } = await world.pair("delegate", "proj");
    await world.updatePairing(conversation, (doc) => {
      for (let i = 0; i < BRIDGE_OUTBOX_CAP; i++) {
        appendOutbox(doc, "note", `kept ${String(i)}`);
      }
    });

    expect(
      await answerTo(client, { type: "post", id: "fg", kind: "turn", text: "foreground" }),
    ).toEqual({ type: "accepted", id: "fg" });
    await held.reached;
    expect(await answerTo(client, { type: "post", id: "X", kind: "turn", text: "doomed" })).toEqual(
      { type: "accepted", id: "X" },
    );
    const record = await submissionOf(world, conversation, `bridge:${conversation}:X`);
    await world.test.harness.abortSubmission(submissionIdOf(record), context);

    await vi.waitFor(() => {
      expect(notifies(world)).toHaveLength(1);
    }, WAIT);
    // The outbox is untouched: nothing appended, nothing renumbered.
    const outbox = await outboxOf(world, conversation);
    expect(outbox).toHaveLength(BRIDGE_OUTBOX_CAP);
    expect(outbox.map((entry) => entry.seq)).toEqual(
      Array.from({ length: BRIDGE_OUTBOX_CAP }, (_, at) => at + 1),
    );
    expect(outbox.every((entry) => entry.text.startsWith("kept "))).toBe(true);

    expect(world.logLines).toHaveLength(1);
    expect(world.logLines[0]).toMatch(
      /^bridge: conversation \d+: bridge message X not delivered: withdrawn \(unanswered \(.+\)\); notice not appended: outbox full, pi is not draining$/,
    );
    const [call] = notifies(world);
    expect(call?.key).toEqual({ conversation: idOf(conversation), kind: "scheduled" });
    expect(call?.args["title"]).toBe("bridge message not delivered");
    expect(call?.args["body"]).toMatch(/^bridge message X not delivered: withdrawn/);
    expect(call?.args["body"]).toMatch(/; outbox full, pi is not draining$/);

    // No notice about the notice: one log line and one call, still.
    await new Promise((resolve) => setTimeout(resolve, WAIT.interval));
    expect(world.logLines).toHaveLength(1);
    expect(notifies(world)).toHaveLength(1);
    held.release();
  });

  it("leaves an ended pairing's outbox unchanged, logs once and notifies once", async () => {
    const world = await bridgeWorld();
    const held = heldTurn();
    world.test.faux.setResponses([held.step, recordedTurn().step]);
    const { client, conversation } = await world.pair("delegate", "proj");

    expect(
      await answerTo(client, { type: "post", id: "fg", kind: "turn", text: "foreground" }),
    ).toEqual({ type: "accepted", id: "fg" });
    await held.reached;
    expect(await answerTo(client, { type: "post", id: "X", kind: "turn", text: "doomed" })).toEqual(
      { type: "accepted", id: "X" },
    );
    // The pairing ends while the post is still queued: the notice cannot be appended.
    await world.updatePairing(conversation, (doc) => {
      doc.ended = true;
    });
    const record = await submissionOf(world, conversation, `bridge:${conversation}:X`);
    await world.test.harness.abortSubmission(submissionIdOf(record), context);

    await vi.waitFor(() => {
      expect(notifies(world)).toHaveLength(1);
    }, WAIT);
    expect(await outboxOf(world, conversation)).toEqual([]);
    expect(world.logLines).toHaveLength(1);
    expect(world.logLines[0]).toMatch(
      /^bridge: conversation \d+: bridge message X not delivered: withdrawn \(unanswered \(.+\)\); notice not appended: pairing ended$/,
    );
    const [call] = notifies(world);
    expect(call?.args["title"]).toBe("bridge message not delivered");
    expect(call?.args["body"]).toMatch(/bridge message X not delivered: withdrawn/);
    expect(call?.args["body"]).toMatch(/; pairing ended$/);
    held.release();
  });
});

describe("post-once (VT-6)", () => {
  it("answers accepted with no id, closes, and binds nothing", async () => {
    const world = await bridgeWorld();
    world.test.faux.setResponses([recordedTurn().step]);
    const { conversation, token } = await world.pair("delegate", "proj");

    const { client, reply } = await world.firstLine({
      type: "post-once",
      conversation,
      token,
      kind: "turn",
      text: "one shot",
    });
    expect(reply).toEqual({ type: "accepted" });
    expect(reply).not.toHaveProperty("id");
    await client.closed;

    // Nothing was bound: a plain resume still answers paired.
    const { reply: again } = await world.resume(conversation, token);
    expect(again).toEqual({ type: "paired", conversation });
  });

  it("refuses a bad token and closes, submitting nothing", async () => {
    const world = await bridgeWorld();
    const { conversation } = await world.pair("delegate", "proj");

    const { client, reply } = await world.firstLine({
      type: "post-once",
      conversation,
      token: "not-the-token",
      kind: "turn",
      text: "one shot",
    });
    expect(reply).toEqual({ type: "refused", reason: "bad token" });
    await client.closed;
    expect(await liveSubmissions(world)).toEqual([]);
    expect((await world.pairingOf(conversation)).spent).toBe(0);
  });
});
