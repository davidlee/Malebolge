import { type ConversationId, type Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { context } from "../../src/context.ts";
import { conversationIdOf, conversationText } from "../../src/runner/durable-ids.ts";
import { openFauxHarness } from "../harness-fixture.ts";
import { closeHarness } from "./runner-fixture.ts";

/** A passive harness on memory storage (it only creates and reads). */
async function passiveHarness(): Promise<Harness> {
  return (await openFauxHarness(new MemoryStorage(), { resume: false })).harness;
}

async function createConversations(harness: Harness, count: number): Promise<ConversationId[]> {
  const ids: ConversationId[] = [];
  for (let n = 0; n < count; n++) {
    ids.push((await harness.createConversation({ ownership: { kind: "ownerless" } }, context)).id);
  }
  return ids;
}

describe("conversationIdOf", () => {
  let harness: Harness | undefined;
  afterEach(async () => {
    if (harness !== undefined) {
      await closeHarness(harness);
    }
    harness = undefined;
  });

  it("recovers the branded id from its text, and the conversation opens", async () => {
    harness = await passiveHarness();
    const [, middle] = await createConversations(harness, 3);
    if (middle === undefined) {
      throw new Error("no conversation created");
    }

    const found = await conversationIdOf(harness, conversationText(middle));

    expect(found).toBe(middle);
    if (found === undefined) {
      return;
    }
    expect((await harness.conversation(found, context))?.id).toBe(middle);
  });

  it.each(["999999", "", "abc", " 1"])("is undefined for text %j that names none", async (text) => {
    harness = await passiveHarness();
    await createConversations(harness, 2);

    expect(await conversationIdOf(harness, text)).toBeUndefined();
  });

  it("follows the scan past its first page", async () => {
    harness = await passiveHarness();
    const [oldest] = await createConversations(harness, 70);
    if (oldest === undefined) {
      throw new Error("no conversation created");
    }

    expect(await conversationIdOf(harness, conversationText(oldest))).toBe(oldest);
  });
});
