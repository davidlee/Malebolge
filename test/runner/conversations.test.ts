// A job's conversation: created and recorded by one function, which submit
// and the scheduler share (PHASE-07 §3), and reopened from its row text.

import { describe, expect, it } from "vitest";
import {
  type Conversations,
  ensureConversation,
  harnessConversations,
  jobConversation,
} from "../../src/runner/conversations.ts";
import { conversationText } from "../../src/runner/durable-ids.ts";
import { openRunnerStore } from "../../src/runner/store.ts";
import { openFauxHarness } from "../harness-fixture.ts";
import { closeHarness } from "./runner-fixture.ts";
import { NEW_JOB, openTestStore, T0 } from "./store-fixture.ts";

/** Conversations named `c1`, `c2`, … in creation order. */
function countingConversations(): Conversations & { created: () => number } {
  let created = 0;
  return {
    create: () => Promise.resolve(`c${String(++created)}`),
    created: () => created,
  };
}

describe("ensureConversation", () => {
  it("creates and records a conversation for a job without one, audited", async () => {
    const { jobs } = await openTestStore();
    const { job } = await jobs.submit(NEW_JOB, T0);
    const conversations = countingConversations();

    const recorded = await ensureConversation(jobs, conversations, job, T0 + 1);

    expect(recorded.conversationId).toBe("c1");
    expect((await jobs.get(job.id))?.conversationId).toBe("c1");
    expect((await jobs.events(job.id)).map((event) => [event.kind, event.payload])).toEqual([
      ["submitted", expect.anything()],
      ["conversation", { conversationId: "c1" }],
    ]);
  });

  it("leaves a job that has one as it is, creating nothing", async () => {
    const { jobs } = await openTestStore();
    const { job } = await jobs.submit(NEW_JOB, T0);
    const conversations = countingConversations();
    const first = await ensureConversation(jobs, conversations, job, T0 + 1);

    const again = await ensureConversation(jobs, conversations, first, T0 + 2);

    expect(again.conversationId).toBe("c1");
    expect(conversations.created()).toBe(1);
  });

  it("keeps the first recorded when two callers race on a stale row", async () => {
    const { jobs } = await openTestStore();
    const { job } = await jobs.submit(NEW_JOB, T0);
    const conversations = countingConversations();

    const [a, b] = await Promise.all([
      ensureConversation(jobs, conversations, job, T0 + 1),
      ensureConversation(jobs, conversations, job, T0 + 1),
    ]);

    expect(a.conversationId).toBe("c1");
    expect(b.conversationId).toBe("c1");
    const kinds = (await jobs.events(job.id)).map((event) => event.kind);
    expect(kinds.filter((kind) => kind === "conversation")).toHaveLength(1);
  });
});

describe("jobConversation", () => {
  it("opens the conversation a row's text names; none for unknown text", async () => {
    // Closing the harness closes the store's storage and database.
    const store = await openRunnerStore(":memory:");
    const { harness } = await openFauxHarness(store.storage, { resume: false });
    try {
      const text = await harnessConversations(harness).create();

      const conversation = await jobConversation(harness, text);

      expect(conversation === undefined ? undefined : conversationText(conversation.id)).toBe(text);
      expect(await jobConversation(harness, "9999")).toBeUndefined();
    } finally {
      await closeHarness(harness);
    }
  });
});
