// SL-009 PHASE-05 VT-2 (resume, end, supersede, private socket) and VT-3 (the
// bridge parser's reach: no attach, refusals, unfilled rows), through the real
// listener on a private socket; PHASE-06 VT-2 adds the push (deliver) and the
// per-entry ack. SL-011 PHASE-02 adds pair binding an existing conversation
// (VT-1 to VT-3), written red first against
// .doctrine/state/slice/011/phase-02-brief-tests.md.

import { chmod, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { BRIDGE_LINE_MAX_BYTES, type DaemonFrame, type MessageKind } from "../pi-bridge/wire.ts";
import { serveBridge } from "../src/bridge/listener.ts";
import { appendOutbox, hashToken } from "../src/bridge/pairing.ts";
import { context } from "../src/context.ts";
import { IndexDocument } from "../src/topics.ts";
import { PrivateDirectoryRefused } from "../src/unix-socket.ts";
import { type BridgeWorld, bridgeHost, bridgeWorld, type PiClient } from "./bridge-fixture.ts";
import { rejection, tempDir } from "./fixtures.ts";
import { forkConversation } from "./harness-fixture.ts";

const refused = (reason: string): object => ({ type: "refused", reason });

/** Append one outbox entry to `conversation`, as a later phase's rule would. */
const append = (
  world: BridgeWorld,
  conversation: string,
  text: string,
  kind: MessageKind = "turn",
): Promise<void> =>
  world.updatePairing(conversation, (doc) => {
    appendOutbox(doc, kind, text);
  });

/** Every deliver frame's seq, in arrival order: how a test sees a repeat or an absence. */
const deliveredSeqs = (client: PiClient): number[] =>
  client.received().flatMap((frame) => (frame.type === "deliver" ? [frame.seq] : []));

/** The deliver frames received so far, in arrival order. */
const deliveriesOf = (client: PiClient): DaemonFrame[] =>
  client.received().filter((frame) => frame.type === "deliver");

/**
 * Wait until the client's deliver frames are exactly `seqs`: the next frame the
 * daemon sends unprompted. A missing or repeated seq fails with what did arrive.
 */
async function waitForDeliveries(client: PiClient, seqs: readonly number[]): Promise<void> {
  await vi.waitFor(
    () => {
      expect(deliveredSeqs(client)).toEqual([...seqs]);
    },
    { timeout: 2000, interval: 10 },
  );
}

/** A request frame the daemon answers with its own id, whatever the row does: proof the connection is bound and open. */
async function answersProbe(client: PiClient): Promise<void> {
  await client.send({ type: "post", id: "probe", kind: "note", text: "are you there" });
  // Pushed deliveries are not answers: skip them, so any other frame ahead of the probe's fails.
  let frame = await client.next();
  while (frame.type === "deliver") {
    frame = await client.next();
  }
  expect(frame).toMatchObject({ id: "probe" });
}

describe("resume (VT-2)", () => {
  it("binds with the right token, answering paired without a token", async () => {
    const world = await bridgeWorld();
    const { conversation, token } = await world.pair();
    const { client, reply } = await world.resume(conversation, token);
    expect(reply).toEqual({ type: "paired", conversation });
    expect(reply).not.toHaveProperty("token");
    await answersProbe(client);
  });

  it("refuses a wrong token as bad token, and closes", async () => {
    const world = await bridgeWorld();
    const { conversation } = await world.pair();
    const { client, reply } = await world.resume(conversation, "not-the-token");
    expect(reply).toEqual(refused("bad token"));
    await client.closed;
  });

  type IdOf = (world: BridgeWorld) => string | Promise<string>;
  const NOT_BRIDGED: [string, IdOf][] = [
    ["a plain conversation", (world): Promise<string> => world.plainConversation()],
    ["the root conversation", (world): string => String(world.test.root.id)],
    ["a non-numeric id", (): string => "abc"],
    ["a fractional id", (): string => "1.5"],
    ["an id with trailing text", (): string => "1x"],
    ["no such conversation", (): string => "99999"],
  ];
  it.each(NOT_BRIDGED)(
    "refuses %s as not a bridged conversation, and closes",
    async (_, conversationOf) => {
      const world = await bridgeWorld();
      const { client, reply } = await world.resume(await conversationOf(world), "any-token");
      expect(reply).toEqual(refused("not a bridged conversation"));
      await client.closed;
    },
  );

  it("a refused resume of a plain conversation writes no pairing document", async () => {
    const world = await bridgeWorld();
    const conversation = await world.plainConversation();
    const { client, reply } = await world.resume(conversation, "any-token");
    expect(reply).toEqual(refused("not a bridged conversation"));
    await client.closed;
    expect(await world.storedPairing(conversation)).toBeUndefined();
  });

  it("does not read a bridged conversation's id out of trailing text", async () => {
    const world = await bridgeWorld();
    const { conversation, token } = await world.pair();
    const { client, reply } = await world.resume(`${conversation}x`, token);
    expect(reply).toEqual(refused("not a bridged conversation"));
    await client.closed;
  });

  it("a newer resume supersedes the older connection, which is told and closed", async () => {
    const world = await bridgeWorld();
    const first = await world.pair();
    const second = await world.resume(first.conversation, first.token);
    expect(second.reply).toEqual({ type: "paired", conversation: first.conversation });
    expect(await first.client.next()).toEqual(refused("superseded by a newer connection"));
    await first.client.closed;
    await answersProbe(second.client);
  });

  it("the superseded connection's close does not unbind its successor", async () => {
    const world = await bridgeWorld();
    const first = await world.pair();
    const second = await world.resume(first.conversation, first.token);
    await first.client.closed;
    const third = await world.resume(first.conversation, first.token);
    expect(await second.client.next()).toEqual(refused("superseded by a newer connection"));
    await second.client.closed;
    await answersProbe(third.client);
  });

  it("a closed connection leaves the pairing resumable", async () => {
    const world = await bridgeWorld();
    const { client, conversation, token } = await world.pair();
    client.close();
    await client.closed;
    const { client: again, reply } = await world.resume(conversation, token);
    expect(reply).toEqual({ type: "paired", conversation });
    await answersProbe(again);
  });
});

describe("end (VT-2, EX-4)", () => {
  it("answers pairing ended, closes, and refuses a later resume with the right token", async () => {
    const world = await bridgeWorld();
    const { client, conversation, token } = await world.pair();
    await client.send({ type: "end" });
    expect(await client.next()).toEqual(refused("pairing ended"));
    await client.closed;
    expect((await world.pairingOf(conversation)).ended).toBe(true);

    const late = await world.resume(conversation, token);
    expect(late.reply).toEqual(refused("pairing ended"));
    await late.client.closed;
  });

  it("tells a wrong token bad token, not pairing ended", async () => {
    const world = await bridgeWorld();
    const { client, conversation } = await world.pair();
    await client.send({ type: "end" });
    await client.closed;
    const { reply } = await world.resume(conversation, "not-the-token");
    expect(reply).toEqual(refused("bad token"));
  });

  it("leaves the conversation attachable on the durable path", async () => {
    const world = await bridgeWorld();
    const { client, conversation } = await world.pair();
    await client.send({ type: "end" });
    await client.closed;
    expect(String((await world.openDurable(conversation)).id)).toBe(conversation);
  });

  it("an ended pairing refuses every bound row, as the document is re-read per frame", async () => {
    const world = await bridgeWorld();
    const { client, conversation } = await world.pair();
    await world.updatePairing(conversation, (doc) => {
      doc.ended = true;
    });
    await client.send({ type: "post", id: "p9", kind: "turn", text: "hello" });
    expect(await client.next()).toEqual({ type: "refused", id: "p9", reason: "pairing ended" });
    await client.send({ type: "ack", seq: 1 });
    expect(await client.next()).toEqual(refused("pairing ended"));
    await client.send({ type: "refill" });
    expect(await client.next()).toEqual(refused("pairing ended"));
  });
});

describe("the private socket (VT-2)", () => {
  it("is 0600 in a 0700 directory", async () => {
    const world = await bridgeWorld();
    expect((await stat(world.socketPath)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(world.socketPath))).mode & 0o777).toBe(0o700);
  });

  it("refuses a socket directory open to group and other, creating no socket", async () => {
    const { host } = await bridgeHost();
    const { dir, cleanup } = await tempDir();
    onTestFinished(cleanup);
    await chmod(dir, 0o750);
    const path = join(dir, "bridge.sock");
    const failure = await rejection(serveBridge({ path, host: Promise.resolve(host) }));
    expect(failure).toBeInstanceOf(PrivateDirectoryRefused);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("the first line (VT-3)", () => {
  it.each([
    ["attach", '{"type":"attach","target":{"kind":"root"}}'],
    ["an unknown type", '{"type":"nope"}'],
    ["no type", '{"kind":"root"}'],
    ["non-JSON", "this is not json"],
    ["a bound frame", '{"type":"post","id":"1","kind":"turn","text":"x"}'],
    ["end", '{"type":"end"}'],
    ["an over-long line", "x".repeat(BRIDGE_LINE_MAX_BYTES + 16)],
  ])("refuses %s and closes the connection", async (_, line) => {
    const world = await bridgeWorld();
    const { client, reply } = await world.firstLine(line);
    expect(reply).toMatchObject({ type: "refused" });
    expect(reply).not.toHaveProperty("id");
    await client.closed;
  });

  it("answers post-once with accepted, no id, and closes (VT-6)", async () => {
    const world = await bridgeWorld();
    const { conversation, token } = await world.pair();
    // A note post-once asks the model nothing: the row's answer is all this test needs.
    const { client, reply } = await world.firstLine({
      type: "post-once",
      conversation,
      token,
      kind: "note",
      text: "x",
    });
    expect(reply).toEqual({ type: "accepted" });
    expect(reply).not.toHaveProperty("id");
    await client.closed;
  });
});

describe("a bound connection (VT-3)", () => {
  it.each([
    ["attach", '{"type":"attach","target":{"kind":"root"}}'],
    ["an unknown type", '{"type":"nope"}'],
    ["non-JSON", "this is not json"],
    ["a first-line frame", '{"type":"pair","posture":"delegate","project":"p"}'],
    ["a post without text", '{"type":"post","id":"1","kind":"turn"}'],
  ])("refuses %s and stays open", async (_, line) => {
    const world = await bridgeWorld();
    const { client } = await world.pair();
    await client.send(line);
    expect(await client.next()).toMatchObject({ type: "refused" });
    await answersProbe(client);
  });

  it("answers a post with accepted and its id, and stays open (VT-6)", async () => {
    const world = await bridgeWorld();
    const { client } = await world.pair();
    // A note post asks the model nothing, so the next frame is the probe's.
    await client.send({ type: "post", id: "p1", kind: "note", text: "hi" });
    expect(await client.next()).toEqual({ type: "accepted", id: "p1" });
    await answersProbe(client);
  });

  it("answers refill with no reply at all, the next frame being the probe's (VT-5)", async () => {
    const world = await bridgeWorld();
    const { client } = await world.pair();
    await client.send({ type: "refill" });
    await answersProbe(client);
  });
});

describe("deliver and ack (VT-2)", () => {
  it("delivers an entry appended while bound", async () => {
    const world = await bridgeWorld();
    const { client, conversation } = await world.pair();
    await append(world, conversation, "hello pi");
    await waitForDeliveries(client, [1]);
    expect(deliveriesOf(client)).toEqual([
      { type: "deliver", seq: 1, kind: "turn", text: "hello pi" },
    ]);
  });

  it("delivers only entries above the highest seq sent on this connection", async () => {
    const world = await bridgeWorld();
    const { client, conversation } = await world.pair();
    await append(world, conversation, "one");
    await append(world, conversation, "two");
    await waitForDeliveries(client, [1, 2]);
    await append(world, conversation, "three");
    await waitForDeliveries(client, [1, 2, 3]);
    expect(deliveriesOf(client)).toEqual([
      { type: "deliver", seq: 1, kind: "turn", text: "one" },
      { type: "deliver", seq: 2, kind: "turn", text: "two" },
      { type: "deliver", seq: 3, kind: "turn", text: "three" },
    ]);
  });

  it("delivers entries appended while unbound on the next resume", async () => {
    const world = await bridgeWorld();
    const { client, conversation, token } = await world.pair();
    client.close();
    await client.closed;
    await append(world, conversation, "while away", "note");
    const { client: again, reply } = await world.resume(conversation, token);
    expect(reply).toEqual({ type: "paired", conversation });
    await waitForDeliveries(again, [1]);
    expect(again.received().map((frame) => frame.type)).toEqual(["paired", "deliver"]);
    expect(deliveriesOf(again)).toEqual([
      { type: "deliver", seq: 1, kind: "note", text: "while away" },
    ]);
  });

  it("redelivers every unacked entry right after paired on resume", async () => {
    const world = await bridgeWorld();
    const { client, conversation, token } = await world.pair();
    await append(world, conversation, "one");
    await append(world, conversation, "two");
    await waitForDeliveries(client, [1, 2]);
    client.close();
    await client.closed;
    const { client: again, reply } = await world.resume(conversation, token);
    expect(reply).toEqual({ type: "paired", conversation });
    await waitForDeliveries(again, [1, 2]);
    expect(again.received().map((frame) => frame.type)).toEqual(["paired", "deliver", "deliver"]);
  });

  it("ack removes exactly that entry and answers nothing", async () => {
    const world = await bridgeWorld();
    const { client, conversation } = await world.pair();
    await append(world, conversation, "one");
    await append(world, conversation, "two");
    await waitForDeliveries(client, [1, 2]);
    await client.send({ type: "ack", seq: 1 });
    // The probe's post is the next frame: the ack itself wrote no reply.
    await answersProbe(client);
    expect((await world.pairingOf(conversation)).outbox.map((entry) => entry.seq)).toEqual([2]);
    expect(deliveredSeqs(client)).toEqual([1, 2]);
  });

  it("redelivers an unacked entry on the next resume, but not an acked one", async () => {
    const world = await bridgeWorld();
    const { client, conversation, token } = await world.pair();
    await append(world, conversation, "acked");
    await append(world, conversation, "unacked");
    await waitForDeliveries(client, [1, 2]);
    await client.send({ type: "ack", seq: 1 });
    await answersProbe(client);
    client.close();
    await client.closed;
    const { client: again, reply } = await world.resume(conversation, token);
    expect(reply).toEqual({ type: "paired", conversation });
    await waitForDeliveries(again, [2]);
    expect(deliveriesOf(again)).toEqual([
      { type: "deliver", seq: 2, kind: "turn", text: "unacked" },
    ]);
  });

  it("the superseded connection gets no later deliveries", async () => {
    const world = await bridgeWorld();
    const first = await world.pair();
    const second = await world.resume(first.conversation, first.token);
    expect(await first.client.next()).toEqual(refused("superseded by a newer connection"));
    await first.client.closed;
    await append(world, first.conversation, "after the supersede");
    await waitForDeliveries(second.client, [1]);
    expect(deliveriesOf(second.client)).toEqual([
      { type: "deliver", seq: 1, kind: "turn", text: "after the supersede" },
    ]);
    expect(deliveredSeqs(first.client)).toEqual([]);
  });
});

// --- pair binds an existing conversation (SL-011 PHASE-02, VT-1 to VT-3) ------

/** The conversations and topics a pair attempt must leave exactly as they were. */
interface StoreShape {
  ids: number[];
  topics: string[];
}

/** The store as a refusal must leave it. */
const shapeOf = async (world: BridgeWorld): Promise<StoreShape> => ({
  ids: await world.allIds(),
  topics: await world.topicNames(),
});

/** The attached set the bridge's port reports from now on. */
const attach = (world: BridgeWorld, ids: readonly ConversationId[]): void => {
  world.attached.splice(0, world.attached.length, ...ids);
};

/** One pair first line, its refusal asserted exactly, and the connection it closed. */
async function refusesPair(world: BridgeWorld, frame: object, reason: string): Promise<void> {
  const { client, reply } = await world.firstLine(frame);
  expect(reply).toEqual({ type: "refused", reason });
  await client.closed;
}

/** A refusal writes nothing: no conversation, no topic, and `conversation` still unpaired. */
async function expectNoWrite(
  world: BridgeWorld,
  before: StoreShape,
  conversation: string,
): Promise<void> {
  expect(await world.allIds()).toEqual(before.ids);
  expect(await world.topicNames()).toEqual(before.topics);
  expect(await world.storedPairing(conversation)).toBeUndefined();
}

describe("pair binds an existing conversation", () => {
  it("answers paired with the conversation's id and a token, stored only as its hash", async () => {
    const world = await bridgeWorld();
    const target = String(world.target);
    const before = await shapeOf(world);
    const { client, conversation, token } = await world.pair("consult", "alpha", {
      conversation: target,
    });
    expect(client.received()).toEqual([{ type: "paired", conversation: target, token }]);
    expect(conversation).toBe(target);
    const doc = await world.pairingOf(target);
    expect(doc).toMatchObject({
      tokenHash: hashToken(token),
      posture: "consult",
      project: "alpha",
      ended: false,
      nextSeq: 1,
      outbox: [],
      spent: 0,
    });
    expect(JSON.stringify(doc)).not.toContain(token);
    // The one write is the pairing document: pair creates no topic and no conversation.
    expect(await world.allIds()).toEqual(before.ids);
    expect(await world.topicNames()).toEqual(before.topics);
  });

  it("stores the posture the frame carries on the bound conversation", async () => {
    const world = await bridgeWorld();
    const { conversation } = await world.pair("consult");
    expect(conversation).toBe(String(world.target));
    expect((await world.pairingOf(conversation)).posture).toBe("consult");
  });

  it("pairs a project of exactly 255 bytes, which is under the limit", async () => {
    const world = await bridgeWorld();
    // 127 é are 254 bytes; the trailing "a" makes 255, the longest project pair accepts.
    const project = `${"é".repeat(127)}a`;
    expect(Buffer.byteLength(project, "utf8")).toBe(255);
    const { conversation } = await world.pair("delegate", project);
    expect(conversation).toBe(String(world.target));
    expect((await world.pairingOf(conversation)).project).toBe(project);
  });

  it("refuses an id with trailing text as not a conversation id, writing nothing", async () => {
    const world = await bridgeWorld();
    const before = await shapeOf(world);
    await refusesPair(
      world,
      { type: "pair", posture: "delegate", project: "proj", conversation: "12x" },
      "not a conversation id: 12x",
    );
    await expectNoWrite(world, before, String(world.target));
  });

  it("refuses an id no conversation answers to as no conversation 99999, writing nothing", async () => {
    const world = await bridgeWorld();
    const before = await shapeOf(world);
    await refusesPair(
      world,
      { type: "pair", posture: "delegate", project: "proj", conversation: "99999" },
      "no conversation 99999",
    );
    await expectNoWrite(world, before, String(world.target));
  });

  it("refuses a mail conversation as not interactive, writing nothing", async () => {
    const world = await bridgeWorld();
    await world.conversations.setTopic({ name: "inbox", toolset: "mail" });
    const mail = String(
      (await world.conversations.open({ kind: "topic", name: "inbox", new: false })).id,
    );
    const before = await shapeOf(world);
    await refusesPair(
      world,
      { type: "pair", posture: "delegate", project: "proj", conversation: mail },
      `conversation ${mail} has toolset mail, not interactive`,
    );
    await expectNoWrite(world, before, mail);
  });

  it("refuses an unreconciled index entry (no toolset) as no conversation N, writing nothing", async () => {
    const world = await bridgeWorld();
    const legacy = await world.plainConversation();
    // What a store indexed before the reconcile backfilled toolsets holds: a topic, no toolset.
    await world.test.harness.commit(async (tx) => {
      const index = await tx.doc(IndexDocument);
      index.conversations[legacy] = { topic: "default" };
    }, context);
    // The premise: no toolset reads as no entry at all, which is what the reconcile backfills.
    expect(await world.entryOf(legacy)).toBeUndefined();
    const before = await shapeOf(world);
    await refusesPair(
      world,
      { type: "pair", posture: "delegate", project: "proj", conversation: legacy },
      `no conversation ${legacy}`,
    );
    await expectNoWrite(world, before, legacy);
  });

  it("refuses a project longer than 255 bytes, writing nothing", async () => {
    const world = await bridgeWorld();
    const before = await shapeOf(world);
    // 128 é are 128 characters but 256 bytes of UTF-8: over the limit byte-wise only.
    await refusesPair(
      world,
      { type: "pair", posture: "delegate", project: "é".repeat(128) },
      "project longer than 255 bytes",
    );
    await expectNoWrite(world, before, String(world.target));
  });

  it("binds the single attached conversation when the frame names none", async () => {
    const world = await bridgeWorld();
    const { conversation, token } = await world.pair();
    expect(conversation).toBe(String(world.target));
    expect(typeof token).toBe("string");
    expect((await world.pairingOf(conversation)).posture).toBe("delegate");
  });

  it("refuses when no operator client is attached, writing nothing", async () => {
    const world = await bridgeWorld();
    attach(world, []);
    const before = await shapeOf(world);
    await refusesPair(
      world,
      { type: "pair", posture: "delegate", project: "proj" },
      "no operator client is attached; name a conversation",
    );
    await expectNoWrite(world, before, String(world.target));
  });

  it("refuses when several conversations are attached, listing their ids ascending", async () => {
    const world = await bridgeWorld();
    const other = (await world.conversations.open({ kind: "new" })).id;
    // The higher id first: the refusal names them ascending whatever order they arrive in.
    attach(world, [other, world.target]);
    const ascending = [other, world.target]
      .sort((left, right) => left - right)
      .map(String)
      .join(", ");
    const before = await shapeOf(world);
    await refusesPair(
      world,
      { type: "pair", posture: "delegate", project: "proj" },
      `several conversations are attached (${ascending}); name one`,
    );
    await expectNoWrite(world, before, String(world.target));
  });

  it("pairs the fork of an interactive conversation", async () => {
    const world = await bridgeWorld();
    const parent = await world.openDurable(String(world.target));
    const fork = await forkConversation(world.test.harness, parent);
    // The premise: a fork copies its parent's entry, toolset included, so it is interactive.
    expect(await world.entryOf(String(fork.id))).toMatchObject({ toolset: "interactive" });
    const { conversation } = await world.pair("delegate", "proj", {
      conversation: String(fork.id),
    });
    expect(conversation).toBe(String(fork.id));
    expect(await world.pairingOf(conversation)).toMatchObject({
      posture: "delegate",
      ended: false,
    });
  });
});
