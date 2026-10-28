// A job's conversation: created and recorded by one function, which submit
// and the scheduler share (PHASE-07 §3), and reopened from its row text.

import { type Conversation, defineExtension, type Harness } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { context } from "../../src/context.ts";
import { registryOf } from "../../src/registry.ts";
import {
  type Conversations,
  ensureConversation,
  harnessConversations,
  jobConversation,
} from "../../src/runner/conversations.ts";
import { conversationText } from "../../src/runner/durable-ids.ts";
import { openRunnerStore } from "../../src/runner/store.ts";
import { requireInstalled, selectionOf, toolsetList } from "../../src/toolsets.ts";
import { openFauxHarness, toolsetProbe } from "../harness-fixture.ts";
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

/**
 * A runner harness on a fresh in-memory store, with the job toolset's extensions and
 * `persona`, so the registry union differs from the job list; closed afterwards.
 */
async function withJobHarness<T>(run: (harness: Harness) => Promise<T>): Promise<T> {
  const store = await openRunnerStore(":memory:");
  const { harness } = await openFauxHarness(store.storage, {
    resume: false,
    registry: registryOf([
      defineExtension({ name: "job-tools" }),
      defineExtension({ name: "job-guard" }),
      defineExtension({ name: "persona" }),
    ]),
  });
  try {
    return await run(harness);
  } finally {
    await closeHarness(harness);
  }
}

/** The conversation `harnessConversations` creates for a job, as a handle. */
async function jobOn(harness: Harness): Promise<Conversation> {
  const conversation = await jobConversation(harness, await harnessConversations(harness).create());
  if (conversation === undefined) {
    throw new Error("the job's conversation is missing");
  }
  return conversation;
}

describe("a job's toolset", () => {
  it("VT-3 gives a job's conversation the job toolset", async () => {
    await withJobHarness(async (harness) => {
      expect((await toolsetProbe(await jobOn(harness))).extensions).toEqual([
        ...toolsetList("job"),
      ]);
    });
  });

  it("VT-3 re-derives the job toolset at admission", async () => {
    await withJobHarness(async (harness) => {
      const conversation = await jobOn(harness);
      // A drifted stored selection, as an upgrade that renamed a name could leave it.
      await conversation.configure({ extensions: [defineExtension({ name: "persona" })] }, context);
      // What run.ts admission writes on every run.
      await conversation.configure({ extensions: selectionOf(toolsetList("job")) }, context);
      expect((await toolsetProbe(conversation)).extensions).toEqual([...toolsetList("job")]);
    });
  });

  it("VT-3 refuses a runner without the job toolset's extensions", () => {
    expect(() => {
      requireInstalled(toolsetList("job"), new Set(["job-tools"]));
    }).toThrow(/extension job-guard is not installed/);
  });

  it("VT-3 negative control: a job conversation with no selection takes the whole registry (RV-015 F-11)", async () => {
    await withJobHarness(async (harness) => {
      const unselected = await harness.createConversation(
        { ownership: { kind: "ownerless" } },
        context,
      );
      const probe = await toolsetProbe(unselected);
      expect(probe.extensions).toEqual(["job-tools", "job-guard", "persona"]);
      expect(probe.extensions).not.toEqual([...toolsetList("job")]);
    });
  });
});
