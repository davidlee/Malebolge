// SL-009 PHASE-05 VT-2 (resume, end, supersede, private socket) and VT-3 (the
// bridge parser's reach: no attach, refusals, unfilled rows), through the real
// listener on a private socket; PHASE-06 VT-2 adds the push (deliver) and the
// per-entry ack. Written red first against
// .doctrine/state/slice/009/briefs/phase-05-contract.md and
// .doctrine/state/slice/009/briefs/phase-06-contract.md.

import { chmod, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { BRIDGE_LINE_MAX_BYTES, type DaemonFrame, type MessageKind } from "../pi-bridge/wire.ts";
import { serveBridge } from "../src/bridge/listener.ts";
import { appendOutbox } from "../src/bridge/pairing.ts";
import { PrivateDirectoryRefused } from "../src/unix-socket.ts";
import { type BridgeWorld, bridgeHost, bridgeWorld, type PiClient } from "./bridge-fixture.ts";
import { rejection, tempDir } from "./fixtures.ts";

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

  it("answers post-once as not implemented yet, and closes", async () => {
    const world = await bridgeWorld();
    const { client, reply } = await world.firstLine({
      type: "post-once",
      conversation: "1",
      token: "t",
      kind: "turn",
      text: "x",
    });
    expect(reply).toEqual(refused("post-once is not implemented yet"));
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

  it.each([
    ["post", { type: "post", id: "p1", kind: "turn", text: "hi" }, { id: "p1" }],
    ["refill", { type: "refill" }, {}],
  ])("answers %s as not implemented yet and stays open", async (type, frame, id) => {
    const world = await bridgeWorld();
    const { client } = await world.pair();
    await client.send(frame);
    expect(await client.next()).toEqual({
      type: "refused",
      ...id,
      reason: `${type} is not implemented yet`,
    });
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
