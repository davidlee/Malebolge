// PHASE-01 spike (design §6 OQ-1, RV-025 F-1): a Models view gating
// `streamSimple` and `completeSimple` sits in the path of every provider
// request pi-durable 1.3.0 makes — generation, its retry, and compaction — and
// its durable attempt counter survives a harness reopen.

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  AssistantEntry,
  type Conversation,
  defineExtension,
  defineTool,
  type Harness,
  type HarnessSettings,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { context } from "../../src/context.ts";
import { tempDir } from "../fixtures.ts";
import { type FauxHarnessOptions, openFauxHarness, type TestHarness } from "../harness-fixture.ts";
import {
  ATTEMPTS_SCHEMA,
  GATE_REFUSAL,
  type Gate,
  gatedModels,
  requestGate,
} from "./gate-fixture.ts";
import { closeHarness, openSharedStore } from "./runner-fixture.ts";

const answer = (text: string) => fauxAssistantMessage([fauxText(text)]);
const providerError = (errorMessage: string) =>
  fauxAssistantMessage([], { stopReason: "error", errorMessage });

const FAST_RETRY: HarnessSettings["retry"] = { enabled: true, maxRetries: 3, baseDelayMs: 1 };
const NO_RETRY: HarnessSettings["retry"] = { enabled: false };

type Gated = TestHarness & { gate: Gate };

/** A faux-model harness on a SQLite file whose provider requests pass a gate of `budget`. */
async function openGated(
  dir: string,
  budget: number,
  options: FauxHarnessOptions = {},
): Promise<Gated> {
  const { db, storage } = await openSharedStore(dir, ATTEMPTS_SCHEMA);
  const gate = requestGate(db, budget);
  const opened = await openFauxHarness(storage, {
    ...options,
    models: (models) => gatedModels(models, gate),
  });
  return { ...opened, gate };
}

const ask = async (root: Conversation, content: string) =>
  (await root.submit({ type: "input", content }, context)).wait(context);

/** The newest assistant message: the run's last answer or failure. */
async function lastAnswer(root: Conversation): Promise<AssistantMessage> {
  const page = await root.entries({}, 50, undefined, context);
  const entry = page.items.find((item) => AssistantEntry.is(item));
  return entry?.model?.[0] as AssistantMessage;
}

const textOfAnswer = (message: AssistantMessage) =>
  message.content.map((block) => (block.type === "text" ? block.text : "")).join("");

describe("model gate spike", () => {
  let cleanup: (() => Promise<void>) | undefined;
  let open: Harness | undefined;
  afterEach(async () => {
    if (open) await closeHarness(open);
    open = undefined;
    await cleanup?.();
  });

  const start = async (budget: number, options: FauxHarnessOptions = {}) => {
    const tmp = await tempDir();
    cleanup = tmp.cleanup;
    const gated = await openGated(tmp.dir, budget, options);
    open = gated.harness;
    return { ...gated, dir: tmp.dir };
  };

  it("streamSimple: budget available — the provider is called and the attempt counted", async () => {
    const { root, faux, gate } = await start(1);
    faux.setResponses([answer("hello")]);

    await ask(root, "hi");

    expect(faux.state.callCount).toBe(1);
    expect(await gate.attempts()).toEqual(["streamSimple"]);
    expect(textOfAnswer(await lastAnswer(root))).toBe("hello");
  });

  it("streamSimple: budget exhausted — a generation request reaches no provider", async () => {
    const { root, faux, gate } = await start(0);
    faux.setResponses([answer("never")]);

    await ask(root, "hi");

    expect(faux.state.callCount).toBe(0);
    expect(await gate.attempts()).toEqual([]);
    const refused = await lastAnswer(root);
    expect(refused.stopReason).toBe("error");
    expect(refused.errorMessage).toBe(GATE_REFUSAL);
  });

  it("retry: a retryable failure is retried through the gate (control)", async () => {
    const { root, faux, gate } = await start(2, { settings: { retry: FAST_RETRY } });
    faux.setResponses([providerError("503 overloaded"), answer("recovered")]);

    await ask(root, "hi");

    expect(faux.state.callCount).toBe(2);
    expect(await gate.attempts()).toEqual(["streamSimple", "streamSimple"]);
    expect(textOfAnswer(await lastAnswer(root))).toBe("recovered");
  });

  it("retry: budget exhausted by the failed attempt — the retry reaches no provider", async () => {
    const { root, faux, gate } = await start(1, { settings: { retry: FAST_RETRY } });
    faux.setResponses([providerError("503 overloaded"), answer("never")]);

    await ask(root, "hi");

    expect(faux.state.callCount).toBe(1);
    expect(await gate.attempts()).toEqual(["streamSimple"]);
    expect((await lastAnswer(root)).errorMessage).toBe(GATE_REFUSAL);
  });

  const compactable = { compaction: { keepRecentTokens: 1 }, retry: NO_RETRY } as const;

  it("completeSimple: a manual compaction summary passes the gate (control)", async () => {
    const { harness, root, faux, gate } = await start(3, { settings: compactable });
    faux.setResponses([answer("one"), answer("two"), answer("the summary")]);
    await ask(root, "a");
    await ask(root, "b");

    const task = await root.compact(undefined, context);
    const settled = await harness.waitForTask(task, context);

    expect(settled.state.outcome.status).toBe("completed");
    expect(faux.state.callCount).toBe(3);
    expect(await gate.attempts()).toEqual(["streamSimple", "streamSimple", "completeSimple"]);
  });

  it("completeSimple: budget exhausted — a compaction summary reaches no provider", async () => {
    const { harness, root, faux, gate } = await start(2, { settings: compactable });
    faux.setResponses([answer("one"), answer("two"), answer("never")]);
    await ask(root, "a");
    await ask(root, "b");

    const task = await root.compact(undefined, context);
    const settled = await harness.waitForTask(task, context);

    expect(settled.state.outcome).toMatchObject({ status: "failed" });
    expect(JSON.stringify(settled.state.outcome)).toContain(GATE_REFUSAL);
    expect(faux.state.callCount).toBe(2);
    expect(await gate.attempts()).toEqual(["streamSimple", "streamSimple"]);
  });

  /** A small context window, so the second request first compacts (blocking). */
  const smallWindow: FauxHarnessOptions = {
    fauxOptions: { models: [{ id: "faux-1", contextWindow: 2000, maxTokens: 100 }] },
    settings: {
      retry: NO_RETRY,
      compaction: { keepRecentTokens: 1, reserveTokens: 1000, backgroundTokens: 0 },
    },
  };
  const longAnswer = answer("word ".repeat(1200));

  it("completeSimple: a threshold compaction summary passes the gate (control)", async () => {
    const { root, faux, gate } = await start(3, smallWindow);
    faux.setResponses([longAnswer, answer("the summary"), answer("two")]);
    await ask(root, "a");

    await ask(root, "b");

    expect(faux.state.callCount).toBe(3);
    expect(await gate.attempts()).toEqual(["streamSimple", "completeSimple", "streamSimple"]);
    expect(textOfAnswer(await lastAnswer(root))).toBe("two");
  });

  it("completeSimple: budget exhausted — a threshold compaction reaches no provider", async () => {
    const { root, faux, gate } = await start(1, smallWindow);
    faux.setResponses([longAnswer, answer("never"), answer("never")]);
    await ask(root, "a");

    const settled = await ask(root, "b");

    expect(faux.state.callCount).toBe(1);
    expect(await gate.attempts()).toEqual(["streamSimple"]);
    // The blocked generation never requests; the input settles unanswered with the refusal.
    expect(settled).toMatchObject({ status: "unanswered", reason: "model_error" });
    expect(settled.detail).toContain(GATE_REFUSAL);
  });

  it("the attempt counter counts a failed attempt and survives a harness reopen", async () => {
    const first = await start(2, { settings: { retry: NO_RETRY } });
    first.faux.setResponses([providerError("400 invalid request"), answer("two")]);
    await ask(first.root, "a");
    await ask(first.root, "b");
    expect((await first.gate.attempts()).length).toBe(2);
    await closeHarness(first.harness);
    open = undefined;

    const second = await openGated(first.dir, 2, { settings: { retry: NO_RETRY } });
    open = second.harness;
    second.faux.setResponses([answer("never")]);
    expect(await second.gate.attempts()).toEqual(["streamSimple", "streamSimple"]);

    await ask(second.root, "c");

    expect(second.faux.state.callCount).toBe(0);
    expect((await lastAnswer(second.root)).errorMessage).toBe(GATE_REFUSAL);
  });

  it("deferred polling passes through the view uncounted: fetchDeferred is not gated", async () => {
    const { root, faux, gate } = await start(1, {
      settings: { stream: { deferred: true } },
      fauxOptions: { deferred: { pendingFetches: 1, pollAfterMs: 1 } },
    });
    faux.setResponses([answer("late")]);

    await ask(root, "hi");

    expect(faux.state.callCount).toBe(1);
    expect(faux.state.deferredFetchCount).toBeGreaterThanOrEqual(1);
    expect(await gate.attempts()).toEqual(["streamSimple"]);
    expect(textOfAnswer(await lastAnswer(root))).toBe("late");
  });

  it("a tool's runtime.models is the gated view, but its ungated entry points reach the provider", async () => {
    const outcomes: string[] = [];
    const probe = defineTool({
      name: "probe",
      description: "Calls the model itself.",
      parameters: Type.Object({}),
      execute: async (_args, api) => {
        const model = api.models.getModel("faux", "faux-1");
        if (model === undefined) throw new Error("no faux model");
        const request = { messages: [] };
        outcomes.push((await api.models.completeSimple(model, request)).stopReason);
        outcomes.push((await api.models.complete(model, request)).stopReason);
        return { output: [{ type: "text", text: "probed" }] };
      },
    });
    const { root, faux, gate } = await start(1, {
      extensions: [defineExtension({ name: "probe", tools: [probe] })],
      settings: { retry: NO_RETRY },
    });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("probe", {}, { id: "call-1" })], {
        stopReason: "toolUse",
      }),
      answer("from complete"),
      answer("never"),
    ]);

    await ask(root, "probe");

    // completeSimple refused; complete (not gated) reached the provider.
    expect(outcomes).toEqual(["error", "stop"]);
    expect(faux.state.callCount).toBe(2);
    expect(await gate.attempts()).toEqual(["streamSimple"]);
  });
});
