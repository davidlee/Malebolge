// The caller's origin (SL-006 design § The origin; PHASE-05 VT-1): the newest
// input entry a conversation's turn starts from, scanned newest first and paged,
// and the refusal when a conversation has none. A real indexed harness; every
// entry is appended in a commit, as a task or a fixture appends one.

import {
  AssistantEntry,
  type ConversationId,
  type EntryRecord,
  type Harness,
  type JsonObject,
  ResetEntry,
  UserEntry,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { BRIDGE_ENTRY_KIND } from "../src/bridge/inbound.ts";
import { context } from "../src/context.ts";
import { callerOrigin, Refusal } from "../src/threads/admission.ts";
import type { Origin } from "../src/threads/origin.ts";
import { POST_KIND } from "../src/threads/task.ts";
import { WAKE_KIND } from "../src/wake/task.ts";
import { createConversation, openIndexedHarness } from "./harness-fixture.ts";

/** An entry appended to `conversation` in its own commit. */
function append(
  harness: Harness,
  conversation: ConversationId,
  kind: string,
  data?: JsonObject,
): Promise<EntryRecord> {
  return harness.commit(
    (tx) => tx.appendEntry(conversation, data === undefined ? { kind } : { kind, data }),
    context,
  );
}

/** The origin `callerOrigin` reads for `conversation`, inside a commit. */
function originIn(harness: Harness, conversation: ConversationId): Promise<Origin> {
  return harness.commit((tx) => callerOrigin(tx, conversation), context);
}

describe("the caller's origin (PHASE-05 VT-1)", () => {
  it("a human input and a wake open origins", async () => {
    const { harness } = await openIndexedHarness();

    const human = await createConversation(harness);
    const input = await append(harness, human.id, UserEntry.kind);
    await expect(originIn(harness, human.id)).resolves.toEqual({
      conversation: human.id,
      entry: input.id,
      kind: "human",
    });

    const waking = await createConversation(harness);
    const wake = await append(harness, waking.id, WAKE_KIND, { episodeClass: "seclude" });
    await expect(originIn(harness, waking.id)).resolves.toEqual({
      conversation: waking.id,
      entry: wake.id,
      kind: "wake",
      episodeClass: "seclude",
    });
  });

  it("a post inherits its post's origin", async () => {
    const { harness } = await openIndexedHarness();
    const caller = await createConversation(harness);
    const inherited = {
      conversation: caller.id,
      entry: 41,
      kind: "wake",
      episodeClass: "attend",
    };
    await append(harness, caller.id, POST_KIND, {
      letter: "post",
      to: caller.id,
      from: caller.id,
      topic: "research",
      origin: inherited,
      intent: "Summarise the failing test runs",
    });

    await expect(originIn(harness, caller.id)).resolves.toEqual(inherited);
  });

  it("a reset opens a human origin of its own", async () => {
    const { harness } = await openIndexedHarness();
    const caller = await createConversation(harness);
    await append(harness, caller.id, UserEntry.kind);
    const reset = await append(harness, caller.id, ResetEntry.kind, { note: "handoff" });

    await expect(originIn(harness, caller.id)).resolves.toEqual({
      conversation: caller.id,
      entry: reset.id,
      kind: "human",
    });
  });

  it("walks past non-input entries and across more than one page", async () => {
    const { harness } = await openIndexedHarness();
    const caller = await createConversation(harness);
    const input = await append(harness, caller.id, UserEntry.kind);
    // More non-input entries than one scan page (16), all newer than the input.
    await harness.commit(async (tx) => {
      for (let n = 0; n < 20; n += 1) {
        await tx.appendEntry(caller.id, { kind: "test.note", data: { note: n } });
      }
    }, context);

    await expect(originIn(harness, caller.id)).resolves.toEqual({
      conversation: caller.id,
      entry: input.id,
      kind: "human",
    });
  });

  it("no input entry to take an origin from", async () => {
    const { harness } = await openIndexedHarness();
    const caller = await createConversation(harness);
    await append(harness, caller.id, AssistantEntry.kind);

    const call = originIn(harness, caller.id);
    await expect(call).rejects.toThrow(Refusal);
    await expect(call).rejects.toThrow("no input entry to take an origin from");
  });

  it("an input entry that carries no origin is a breach, not an older origin", async () => {
    const { harness } = await openIndexedHarness();
    const caller = await createConversation(harness);
    await append(harness, caller.id, UserEntry.kind);
    const post = await append(harness, caller.id, POST_KIND, { letter: "post" });

    const call = originIn(harness, caller.id);
    await expect(call).rejects.not.toThrow(Refusal);
    await expect(call).rejects.toThrow(`entry ${String(post.id)} (satan.post) carries no origin`);
  });
});

describe("a bridge-started turn's origin (PHASE-06, DEC-105)", () => {
  it('a bridge turn opens origin kind: "bridge"', async () => {
    const { harness } = await openIndexedHarness();
    const caller = await createConversation(harness);
    await append(harness, caller.id, UserEntry.kind);
    const turn = await append(harness, caller.id, BRIDGE_ENTRY_KIND, {
      kind: "turn",
      project: "proj",
    });

    await expect(originIn(harness, caller.id)).resolves.toEqual({
      conversation: caller.id,
      entry: turn.id,
      kind: "bridge",
    });
  });

  it("a post round-trips a bridge origin (DEC-105 EX-1)", async () => {
    const { harness } = await openIndexedHarness();
    const caller = await createConversation(harness);
    const inherited = { conversation: caller.id, entry: 41, kind: "bridge" };
    await append(harness, caller.id, POST_KIND, {
      letter: "post",
      to: caller.id,
      from: caller.id,
      topic: "research",
      origin: inherited,
      intent: "Summarise the failing test runs",
    });

    await expect(originIn(harness, caller.id)).resolves.toEqual(inherited);
  });

  it("a bridge note keeps the human origin (RV-029 F-4)", async () => {
    const { harness } = await openIndexedHarness();
    const caller = await createConversation(harness);
    const input = await append(harness, caller.id, UserEntry.kind);
    await append(harness, caller.id, BRIDGE_ENTRY_KIND, { kind: "note", project: "proj" });

    await expect(originIn(harness, caller.id)).resolves.toEqual({
      conversation: caller.id,
      entry: input.id,
      kind: "human",
    });
  });

  it("a bridge note keeps the bridge turn's origin", async () => {
    const { harness } = await openIndexedHarness();
    const caller = await createConversation(harness);
    const turn = await append(harness, caller.id, BRIDGE_ENTRY_KIND, {
      kind: "turn",
      project: "proj",
    });
    await append(harness, caller.id, BRIDGE_ENTRY_KIND, { kind: "note", project: "proj" });

    await expect(originIn(harness, caller.id)).resolves.toEqual({
      conversation: caller.id,
      entry: turn.id,
      kind: "bridge",
    });
  });
});
