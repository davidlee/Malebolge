// SL-009 PHASE-05 VT-2 (resume, end, supersede, private socket) and VT-3 (the
// bridge parser's reach: no attach, refusals, unfilled rows), through the real
// listener on a private socket. Written red first against
// .doctrine/state/slice/009/briefs/phase-05-contract.md.

import { chmod, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { BRIDGE_LINE_MAX_BYTES } from "../pi-bridge/wire.ts";
import { serveBridge } from "../src/bridge/listener.ts";
import { PrivateDirectoryRefused } from "../src/unix-socket.ts";
import { type BridgeWorld, bridgeHost, bridgeWorld, type PiClient } from "./bridge-fixture.ts";
import { rejection, tempDir } from "./fixtures.ts";

const refused = (reason: string): object => ({ type: "refused", reason });

/** A request frame the daemon answers with its own id, whatever the row does: proof the connection is bound and open. */
async function answersProbe(client: PiClient): Promise<void> {
  await client.send({ type: "post", id: "probe", kind: "note", text: "are you there" });
  expect(await client.next()).toMatchObject({ id: "probe" });
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
    ["ack", { type: "ack", seq: 1 }, {}],
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
