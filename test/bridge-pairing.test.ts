// SL-009 PHASE-05 VT-4 (the pure pairing rules over plain values) and VT-1
// (`pair` through the real listener: topic, toolset, model, token). Written red
// first against .doctrine/state/slice/009/briefs/phase-05-contract.md.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BRIDGE_BODY_MAX_BYTES, capHeadTail } from "../pi-bridge/wire.ts";
import {
  ackEntry,
  admitTurn,
  appendOutbox,
  BRIDGE_OUTBOX_CAP,
  BRIDGE_TURN_BUDGET,
  checkToken,
  endPairing,
  hashToken,
  isBridged,
  mintToken,
  openPairing,
  type PairingDoc,
  refill,
} from "../src/bridge/pairing.ts";
import { writeTopicRecord } from "../src/topics.ts";
import { bridgeWorld, DEFAULT_REF, GHOST_REF } from "./bridge-fixture.ts";
import { FLASH_REF } from "./model-fixture.ts";
import { forkConversation, NAME_RULE } from "./harness-fixture.ts";

/** The document's initial value, as the contract spells it: no pairing. */
const initialDoc = (): PairingDoc => ({
  tokenHash: "",
  posture: "delegate",
  project: "",
  ended: false,
  nextSeq: 1,
  outbox: [],
  spent: 0,
});

/** A document with a pairing opened on `token`. */
function opened(token = "secret-token"): PairingDoc {
  const doc = initialDoc();
  openPairing(doc, "consult", "proj", token);
  return doc;
}

/** `doc` with `count` unacked entries, seqs 1..count. */
function withEntries(count: number): PairingDoc {
  const doc = opened();
  for (let i = 0; i < count; i++) {
    appendOutbox(doc, "note", `m${String(i + 1)}`);
  }
  return doc;
}

const seqsOf = (doc: PairingDoc): number[] => doc.outbox.map((entry) => entry.seq);
const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

describe("tokens (VT-4)", () => {
  it("hashToken is sha256 hex", () => {
    expect(hashToken("abc")).toBe(createHash("sha256").update("abc").digest("hex"));
    expect(hashToken("abc")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("mintToken is 32 random bytes as base64url, and two mints differ", () => {
    const [a, b] = [mintToken(), mintToken()];
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });
});

describe("openPairing and isBridged (VT-4)", () => {
  it("the initial value is not bridged", () => {
    expect(isBridged(initialDoc())).toBe(false);
  });

  it("opens a bridged, unended pairing and keeps only the token's hash", () => {
    const doc = opened("secret-token");
    expect(isBridged(doc)).toBe(true);
    expect(doc).toMatchObject({
      tokenHash: hashToken("secret-token"),
      posture: "consult",
      project: "proj",
      ended: false,
      nextSeq: 1,
      outbox: [],
      spent: 0,
    });
    expect(JSON.stringify(doc)).not.toContain("secret-token");
  });

  it("resets a used document to a fresh pairing", () => {
    const doc = withEntries(3);
    doc.spent = 4;
    endPairing(doc);
    openPairing(doc, "delegate", "other", "next-token");
    expect(doc).toEqual({
      tokenHash: hashToken("next-token"),
      posture: "delegate",
      project: "other",
      ended: false,
      nextSeq: 1,
      outbox: [],
      spent: 0,
    });
  });
});

describe("checkToken (VT-4)", () => {
  it("accepts the right token", () => {
    expect(checkToken(opened("t1"), "t1")).toEqual({ ok: true });
  });

  it("refuses the initial value as not a bridged conversation, whatever the token", () => {
    expect(checkToken(initialDoc(), "")).toEqual({
      ok: false,
      reason: "not a bridged conversation",
    });
    expect(checkToken(initialDoc(), "t1")).toEqual({
      ok: false,
      reason: "not a bridged conversation",
    });
  });

  it("refuses a wrong token as bad token", () => {
    expect(checkToken(opened("t1"), "t2")).toEqual({ ok: false, reason: "bad token" });
  });

  it("tells pairing ended only to the holder of the right token", () => {
    const doc = opened("t1");
    endPairing(doc);
    expect(checkToken(doc, "t1")).toEqual({ ok: false, reason: "pairing ended" });
    expect(checkToken(doc, "t2")).toEqual({ ok: false, reason: "bad token" });
  });
});

describe("appendOutbox (VT-4)", () => {
  it("allocates seqs from 1 upward and stores kind and text", () => {
    const doc = opened();
    expect(appendOutbox(doc, "turn", "first")).toEqual({ ok: true, seq: 1 });
    expect(appendOutbox(doc, "note", "second")).toEqual({ ok: true, seq: 2 });
    expect(doc.outbox).toEqual([
      { seq: 1, kind: "turn", text: "first" },
      { seq: 2, kind: "note", text: "second" },
    ]);
    expect(doc.nextSeq).toBe(3);
  });

  it("refuses at the cap, leaving the document unchanged", () => {
    const doc = withEntries(BRIDGE_OUTBOX_CAP);
    const before = structuredClone(doc);
    expect(appendOutbox(doc, "turn", "one too many")).toEqual({
      ok: false,
      reason: "outbox full, pi is not draining",
    });
    expect(doc).toEqual(before);
  });

  it("accepts again once an ack makes room", () => {
    const doc = withEntries(BRIDGE_OUTBOX_CAP);
    ackEntry(doc, 1);
    expect(appendOutbox(doc, "turn", "fits")).toEqual({ ok: true, seq: BRIDGE_OUTBOX_CAP + 1 });
  });

  it("refuses an ended pairing, ahead of a full outbox", () => {
    const doc = withEntries(BRIDGE_OUTBOX_CAP);
    endPairing(doc);
    const before = structuredClone(doc);
    expect(appendOutbox(doc, "turn", "late")).toEqual({ ok: false, reason: "pairing ended" });
    expect(doc).toEqual(before);
  });

  it("stores an over-long text head-and-tail capped within the body cap", () => {
    const doc = opened();
    const long = `${"head ".repeat(BRIDGE_BODY_MAX_BYTES)}tail`;
    appendOutbox(doc, "turn", long);
    const stored = doc.outbox[0]?.text ?? "";
    expect(bytes(stored)).toBeLessThanOrEqual(BRIDGE_BODY_MAX_BYTES);
    expect(stored).toBe(capHeadTail(long, BRIDGE_BODY_MAX_BYTES));
    expect(stored.startsWith("head ")).toBe(true);
    expect(stored.endsWith("tail")).toBe(true);
  });

  it("stores a text within the cap as it is", () => {
    const doc = opened();
    const exact = "x".repeat(BRIDGE_BODY_MAX_BYTES);
    appendOutbox(doc, "note", exact);
    expect(doc.outbox[0]?.text).toBe(exact);
  });
});

describe("ackEntry (VT-4)", () => {
  it("removes exactly the entry with that seq", () => {
    const doc = withEntries(3);
    expect(ackEntry(doc, 2)).toBe(true);
    expect(seqsOf(doc)).toEqual([1, 3]);
  });

  it.each([
    ["an unknown seq", 99],
    ["a seq past the allocator", 4],
    ["seq 0", 0],
  ])("%s is a no-op that answers false", (_, seq) => {
    const doc = withEntries(3);
    const before = structuredClone(doc);
    expect(ackEntry(doc, seq)).toBe(false);
    expect(doc).toEqual(before);
  });

  it("a repeated ack is a no-op that answers false", () => {
    const doc = withEntries(3);
    ackEntry(doc, 2);
    const before = structuredClone(doc);
    expect(ackEntry(doc, 2)).toBe(false);
    expect(doc).toEqual(before);
  });

  it("never reuses a seq after an ack", () => {
    const doc = withEntries(2);
    ackEntry(doc, 1);
    ackEntry(doc, 2);
    expect(appendOutbox(doc, "turn", "later")).toEqual({ ok: true, seq: 3 });
    expect(seqsOf(doc)).toEqual([3]);
  });
});

describe("the turn budget (VT-4)", () => {
  it("is ten turns", () => {
    expect(BRIDGE_TURN_BUDGET).toBe(10);
  });

  it("admits the budget, then refuses without spending more", () => {
    const doc = opened();
    for (let i = 1; i <= BRIDGE_TURN_BUDGET; i++) {
      expect(admitTurn(doc)).toEqual({ ok: true });
      expect(doc.spent).toBe(i);
    }
    expect(admitTurn(doc)).toEqual({
      ok: false,
      reason: "budget exhausted, waiting on the operator",
    });
    expect(doc.spent).toBe(BRIDGE_TURN_BUDGET);
  });

  it("refill resets spent, and turns are admitted again", () => {
    const doc = opened();
    for (let i = 0; i < BRIDGE_TURN_BUDGET; i++) {
      admitTurn(doc);
    }
    refill(doc);
    expect(doc.spent).toBe(0);
    expect(admitTurn(doc)).toEqual({ ok: true });
    expect(doc.spent).toBe(1);
  });

  it("refill leaves the rest of the document alone", () => {
    const doc = withEntries(2);
    doc.spent = 5;
    const before = structuredClone(doc);
    refill(doc);
    expect(doc).toEqual({ ...before, spent: 0 });
  });
});

describe("endPairing (VT-4)", () => {
  it("ends the pairing, idempotently", () => {
    const doc = opened();
    endPairing(doc);
    endPairing(doc);
    expect(doc.ended).toBe(true);
  });
});

describe("pair, through the listener (VT-1)", () => {
  it("creates a conversation in <project>-bridge on the bridge toolset", async () => {
    const world = await bridgeWorld();
    const { conversation } = await world.pair("delegate", "alpha");
    expect(await world.entryOf(conversation)).toMatchObject({
      topic: "alpha-bridge",
      toolset: "bridge",
    });
    expect(await world.idsInTopic("alpha-bridge")).toEqual([Number(conversation)]);
  });

  it("answers paired with the conversation id and a token, stored only as its hash", async () => {
    const world = await bridgeWorld();
    const { client, conversation, token } = await world.pair("consult", "alpha");
    expect(client.received()).toEqual([{ type: "paired", conversation, token }]);
    expect(typeof conversation).toBe("string");
    const doc = await world.pairingOf(conversation);
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
  });

  it("writes an absent topic with the bridge toolset, no model and no directory", async () => {
    const world = await bridgeWorld();
    await world.pair("delegate", "alpha");
    expect(await world.topicRecord("alpha-bridge")).toEqual({ toolset: "bridge" });
  });

  it("takes the daemon default model when the topic names none", async () => {
    const world = await bridgeWorld();
    const { conversation } = await world.pair("delegate", "alpha");
    expect(await world.modelOf(conversation)).toBe(DEFAULT_REF);
  });

  it("takes the topic's model when it names one", async () => {
    const world = await bridgeWorld();
    await world.conversations.setTopic({
      name: "alpha-bridge",
      toolset: "bridge",
      model: FLASH_REF,
    });
    const { conversation } = await world.pair("delegate", "alpha");
    expect(await world.modelOf(conversation)).toBe(FLASH_REF);
  });

  it("reuses an existing bridge topic without rewriting it, and a second pairing is a second conversation", async () => {
    const world = await bridgeWorld();
    await world.conversations.setTopic({
      name: "alpha-bridge",
      toolset: "bridge",
      cwd: "/work/alpha",
      model: FLASH_REF,
    });
    const first = await world.pair("delegate", "alpha");
    const second = await world.pair("consult", "alpha");
    expect(second.conversation).not.toBe(first.conversation);
    expect(second.token).not.toBe(first.token);
    expect(await world.idsInTopic("alpha-bridge")).toHaveLength(2);
    expect(await world.topicRecord("alpha-bridge")).toEqual({
      toolset: "bridge",
      cwd: "/work/alpha",
      model: FLASH_REF,
    });
  });

  it("refuses a stored model the catalog lacks, creating no conversation", async () => {
    const world = await bridgeWorld();
    // Written past setTopic's own catalog check, as an older store might hold it.
    await writeTopicRecord(world.test.harness, "alpha-bridge", {
      toolset: "bridge",
      model: GHOST_REF,
    });
    const before = await world.allIds();
    const { client, reply } = await world.firstLine({
      type: "pair",
      posture: "delegate",
      project: "alpha",
    });
    expect(reply).toEqual({ type: "refused", reason: `unknown model ${GHOST_REF}` });
    await client.closed;
    expect(await world.idsInTopic("alpha-bridge")).toEqual([]);
    expect(await world.allIds()).toEqual(before);
  });

  it("refuses a topic of that name on another toolset, creating nothing and rewriting nothing", async () => {
    const world = await bridgeWorld();
    await world.conversations.setTopic({ name: "alpha-bridge", toolset: "interactive" });
    const before = await world.allIds();
    const { client, reply } = await world.firstLine({
      type: "pair",
      posture: "delegate",
      project: "alpha",
    });
    expect(reply).toEqual({
      type: "refused",
      reason: "topic alpha-bridge has toolset interactive, not bridge",
    });
    await client.closed;
    expect(await world.topicRecord("alpha-bridge")).toEqual({ toolset: "interactive" });
    expect(await world.idsInTopic("alpha-bridge")).toEqual([]);
    expect(await world.allIds()).toEqual(before);
  });

  it("refuses a project that breaks the topic rule, creating no topic", async () => {
    const world = await bridgeWorld();
    const topicsBefore = await world.topicNames();
    const before = await world.allIds();
    const { client, reply } = await world.firstLine({
      type: "pair",
      posture: "delegate",
      project: "Bad Project",
    });
    expect(reply).toEqual({ type: "refused", reason: NAME_RULE });
    await client.closed;
    expect(await world.topicNames()).toEqual(topicsBefore);
    expect(await world.allIds()).toEqual(before);
  });
});

describe("the pairing document's scope (VT-4)", () => {
  it("a plain conversation holds the initial value, so it is not bridged", async () => {
    const world = await bridgeWorld();
    const plain = await world.plainConversation();
    expect(await world.pairingOf(plain)).toEqual(initialDoc());
    expect(isBridged(await world.pairingOf(plain))).toBe(false);
  });

  it("a fork of a bridged conversation is not bridged and inherits no token hash", async () => {
    const world = await bridgeWorld();
    const { conversation } = await world.pair("delegate", "alpha");
    const fork = await forkConversation(world.test.harness, await world.openDurable(conversation));
    const doc = await world.pairingOf(String(fork.id));
    expect(isBridged(doc)).toBe(false);
    expect(doc.tokenHash).toBe("");
  });
});
