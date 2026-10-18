// PHASE-01 spike (design §5 "One warning", §6 spike confirmations): a
// `whenBusy: "steer"` input made mid-run is placed after the current tool
// round and before the next model request, and `Harness.submission(id).status()`
// reads a submission on a harness whose scheduling is paused without enabling it.

import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import {
  type Conversation,
  type Harness,
  MemoryStorage,
  type Submission,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { context } from "../../src/context.ts";
import { tempDir } from "../fixtures.ts";
import { callThenAnswer, openFauxHarness } from "../harness-fixture.ts";
import { blockingTool, closeHarness, openSharedStore, within } from "./runner-fixture.ts";

const WARNING = "Ceiling near: commit work in progress and write notes now.";

const steer = (root: Conversation, requestId: string): Promise<Submission> =>
  root.submit({ type: "input", content: WARNING, whenBusy: "steer", requestId }, context);

/** Text of a message, whatever its role. */
const textOf = (message: Message): string =>
  typeof message.content === "string"
    ? message.content
    : message.content.map((block) => (block.type === "text" ? block.text : "")).join("");

/** The conversation's model messages, oldest first, as `role: text`; positional system entries left out. */
async function transcript(root: Conversation): Promise<string[]> {
  const page = await root.entries({}, 50, undefined, context);
  return [...page.items]
    .reverse()
    .flatMap((entry) => entry.model ?? [])
    .filter((message) => {
      // Wider than the type admits: positional system entries carry role "system".
      const role: string = message.role;
      return role !== "system";
    })
    .map((message) => `${message.role}: ${textOf(message)}`);
}

describe("steer placement and passive status", () => {
  let cleanup: (() => Promise<void>) | undefined;
  let open: Harness | undefined;
  afterEach(async () => {
    if (open !== undefined) {
      await closeHarness(open);
    }
    open = undefined;
    await cleanup?.();
  });

  it("a mid-run steer is placed after the tool round, before the next model request", async () => {
    const tool = blockingTool("work");
    const seen: string[][] = [];
    const { harness, root, faux } = await openFauxHarness(new MemoryStorage(), {
      extensions: [tool.extension],
    });
    open = harness;
    const [call, final] = callThenAnswer("work", {}, "done");
    faux.setResponses([
      call,
      (request): AssistantMessage => {
        seen.push(request.messages.map((message) => `${message.role}: ${textOf(message)}`));
        return final;
      },
    ]);

    const started = tool.started();
    const input = await root.submit({ type: "input", content: "go" }, context);
    await started;
    const warning = await steer(root, "warn-x");
    tool.release();
    await input.wait(context);

    expect(await transcript(root)).toEqual([
      "user: go",
      "assistant: ",
      "toolResult: released",
      `user: ${WARNING}`,
      "assistant: done",
    ]);
    // The second model request already carried the steer, after the tool result.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.slice(-2)).toEqual(["toolResult: released", `user: ${WARNING}`]);
    expect((await warning.status(context)).entry).toBeDefined();
  });

  it("a repeated requestId returns the same submission, queued or placed", async () => {
    const tool = blockingTool("work");
    const { harness, root, faux } = await openFauxHarness(new MemoryStorage(), {
      extensions: [tool.extension],
    });
    open = harness;
    faux.setResponses(callThenAnswer("work", {}, "done"));

    const started = tool.started();
    const input = await root.submit({ type: "input", content: "go" }, context);
    await started;
    const first = await steer(root, "warn-x");
    const again = await steer(root, "warn-x");
    tool.release();
    await input.wait(context);
    const afterPlacement = await steer(root, "warn-x");

    expect(again.id).toBe(first.id);
    expect(afterPlacement.id).toBe(first.id);
    const page = await root.entries({}, 50, undefined, context);
    expect(page.items.filter((entry) => entry.kind === "pi.user")).toHaveLength(2);
  });

  it("status() on a paused harness reads placed and queued steers without scheduling", async () => {
    const tmp = await tempDir();
    cleanup = tmp.cleanup;

    // First process: one run whose steer is placed, then a second run closed
    // mid-tool with its steer still queued.
    const firstTool = blockingTool("work");
    const first = await openFauxHarness((await openSharedStore(tmp.dir)).storage, {
      extensions: [firstTool.extension],
    });
    open = first.harness;
    first.faux.setResponses([
      ...callThenAnswer("work", {}, "one"),
      ...callThenAnswer("work", {}, "never"),
    ]);
    let started = firstTool.started();
    const run = await first.root.submit({ type: "input", content: "go" }, context);
    await started;
    const placed = await steer(first.root, "warn-x");
    firstTool.release();
    await run.wait(context);
    started = firstTool.started();
    await first.root.submit({ type: "input", content: "again" }, context);
    await started;
    const queued = await steer(first.root, "warn-y");
    await within(5000, "close mid-tool", closeHarness(first.harness));
    open = undefined;

    // Reopened without resume(): a passive harness.
    const secondTool = blockingTool("work");
    const second = await openFauxHarness((await openSharedStore(tmp.dir)).storage, {
      extensions: [secondTool.extension],
      resume: false,
    });
    open = second.harness;
    second.faux.setResponses([fauxAssistantMessage([fauxText("resumed")])]);
    const before = await second.harness.inspect(context);

    const placedRecord = await (await second.harness.submission(placed.id, context))?.status(
      context,
    );
    const queuedRecord = await (await second.harness.submission(queued.id, context))?.status(
      context,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(placedRecord).toMatchObject({ status: "done" });
    expect(placedRecord?.entry).toBeDefined();
    expect(queuedRecord).toMatchObject({ status: "queued" });
    expect(queuedRecord?.entry).toBeUndefined();
    const after = await second.harness.inspect(context);
    expect(before.scheduling).toBe("paused");
    expect(after).toEqual(before);
    expect(before.tasks.length).toBeGreaterThan(0);
    expect(second.faux.state.callCount).toBe(0);

    // Control: resume() is what lets the same work progress.
    second.harness.resume();
    await within(5000, "resumed run", second.harness.waitForIdle(context));
    expect(second.faux.state.callCount).toBe(1);
    const resumedRecord = await (await second.harness.submission(queued.id, context))?.status(
      context,
    );
    expect(resumedRecord?.entry).toBeDefined();
  });
});
