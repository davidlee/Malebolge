// SL-009 PHASE-06 VT-1: bridge_post through the model's own tool call, on a
// conversation paired, at the cap, ended, plain, or with an over-long text.
// Written red first against
// .doctrine/state/slice/009/briefs/phase-06-contract.md.

import { describe, expect, it } from "vitest";
import { BRIDGE_BODY_MAX_BYTES, capHeadTail, type Posture } from "../pi-bridge/wire.ts";
import { bridgeExtension } from "../src/bridge/extension.ts";
import {
  appendOutbox,
  BRIDGE_OUTBOX_CAP,
  endPairing,
  openPairing,
  type OutboxEntry,
  pairingDoc,
  pairingSnapshot,
} from "../src/bridge/pairing.ts";
import { context } from "../src/context.ts";
import { selectionOf } from "../src/toolsets.ts";
import {
  callThenAnswer,
  openIndexedHarness,
  type TestHarness,
  textOf,
  toolResults,
} from "./harness-fixture.ts";

/** One tool call's result as the model saw it. */
interface ToolRun {
  text: string;
  isError: boolean;
}

/**
 * A harness whose root runs the bridge toolset, so the model can call
 * `bridge_post`; no pairing is opened.
 */
async function bridgeToolset(): Promise<TestHarness> {
  const test = await openIndexedHarness([bridgeExtension]);
  await test.root.configure({ extensions: selectionOf(["bridge"]) }, context);
  return test;
}

interface PairingOptions {
  posture?: Posture;
  /** Unacked messages to open the outbox with: seqs 1..entries. */
  entries?: number;
  ended?: boolean;
}

/** The bridge toolset, with a pairing opened on the root as `options` asks. */
async function openPaired(options: PairingOptions = {}): Promise<TestHarness> {
  const test = await bridgeToolset();
  await test.harness.commit(async (tx) => {
    const doc = await pairingDoc(tx, test.root.id);
    openPairing(doc, options.posture ?? "delegate", "proj", "root-token");
    for (let i = 0; i < (options.entries ?? 0); i++) {
      appendOutbox(doc, "note", `queued ${String(i + 1)}`);
    }
    if (options.ended === true) {
      endPairing(doc);
    }
  }, context);
  return test;
}

/** One model turn on the root calling `bridge_post` with `text`: the result it read. */
async function postFromModel(test: TestHarness, text: string): Promise<ToolRun> {
  test.faux.setResponses(callThenAnswer("bridge_post", { text }, "done"));
  const settled = await (await test.root.submit({ type: "input", content: "go" }, context)).wait(
    context,
  );
  expect(settled.status).toBe("done");
  const result = (await toolResults(test.harness, test.root)).at(-1);
  if (result === undefined) {
    throw new Error("the turn made no tool call");
  }
  return { text: textOf(result), isError: result.isError };
}

/** The root's outbox, read without a commit. */
const outboxOf = async (test: TestHarness): Promise<readonly OutboxEntry[]> =>
  (await pairingSnapshot(test.harness, test.root.id))?.outbox ?? [];

describe("bridge_post (VT-1)", () => {
  it("answers sent #1, then sent #2, storing each turn without echoing its text", async () => {
    const test = await openPaired();
    const first = await postFromModel(test, "the first message for pi");
    expect(first).toEqual({ text: "sent #1", isError: false });
    const second = await postFromModel(test, "the second message for pi");
    expect(second).toEqual({ text: "sent #2", isError: false });
    expect(first.text).not.toContain("the first message for pi");
    expect(second.text).not.toContain("the second message for pi");
    expect(await outboxOf(test)).toEqual([
      { seq: 1, kind: "turn", text: "the first message for pi" },
      { seq: 2, kind: "turn", text: "the second message for pi" },
    ]);
  });

  it("refuses an outbox at the cap as outbox full, keeping every entry", async () => {
    const test = await openPaired({ entries: BRIDGE_OUTBOX_CAP });
    const before = await outboxOf(test);
    expect(before).toHaveLength(BRIDGE_OUTBOX_CAP);
    expect(await postFromModel(test, "one too many")).toEqual({
      text: "outbox full, pi is not draining",
      isError: true,
    });
    expect(await outboxOf(test)).toEqual(before);
  });

  it("refuses an ended pairing as pairing ended, storing nothing", async () => {
    const test = await openPaired({ ended: true });
    expect(await postFromModel(test, "too late")).toEqual({ text: "pairing ended", isError: true });
    expect(await outboxOf(test)).toEqual([]);
  });

  it("refuses a plain conversation, writing no pairing document", async () => {
    const test = await bridgeToolset();
    expect(await postFromModel(test, "anyone there")).toEqual({
      text: "not a bridged conversation",
      isError: true,
    });
    expect(await pairingSnapshot(test.harness, test.root.id)).toBeUndefined();
  });

  it("stores a text over the body cap as capHeadTail of it", async () => {
    const test = await openPaired();
    const long = `${"head ".repeat(BRIDGE_BODY_MAX_BYTES)}tail`;
    expect(await postFromModel(test, long)).toEqual({ text: "sent #1", isError: false });
    const [entry] = await outboxOf(test);
    expect(entry).toEqual({ seq: 1, kind: "turn", text: capHeadTail(long, BRIDGE_BODY_MAX_BYTES) });
  });
});
