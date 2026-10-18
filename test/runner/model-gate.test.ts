// The model gate (VT-1, VT-3; EX-1, EX-5, EX-6; DEC-057): a `Models` view
// in front of every provider request entry point — the generation's
// `streamSimple`, compaction's `completeSimple`, deferred `streamDeferred` /
// `fetchDeferred` / `cancelDeferred`, and the rest of `runtime.models` a tool
// reaches — that refuses on an exhausted ceiling or unreadable usage with no
// provider call, counts `model_requests` durably, and caps output.

import { join } from "node:path";
import {
  type AssistantMessage,
  type Context,
  type DeferredHandle,
  Type,
} from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import {
  AssistantEntry,
  type Conversation,
  defineExtension,
  defineTool,
  type Harness,
  type HarnessSettings,
  MemoryStorage,
  type SettledSubmissionRecord,
  type UsageState,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { context } from "../../src/context.ts";
import type { JsonRecord } from "../../src/json.ts";
import type { Exhaustion } from "../../src/runner/ceilings.ts";
import type { Ceilings } from "../../src/runner/config.ts";
import {
  type Admission,
  catalogLimits,
  createModelGate,
  type EntryPoint,
  type Gate,
  type GateDeps,
  type GateJob,
  GateRefused,
  gatedModels,
  harnessUsage,
  type Refusal,
  REFUSALS,
  spendOf,
} from "../../src/runner/model-gate.ts";
import { type Job, type JobStore, openRunnerStore } from "../../src/runner/store.ts";
import { tempDir } from "../fixtures.ts";
import {
  type FauxHarnessOptions,
  fauxModels,
  openFauxHarness,
  type TestHarness,
} from "../harness-fixture.ts";
import {
  CHAT_MODEL,
  CLASSIFIER_MODEL,
  IMAGE_MODEL,
  type ProviderMethod,
  recordingModels,
} from "./models-fixture.ts";
import { closeHarness, within } from "./runner-fixture.ts";
import { NEW_JOB, openTestStore, sequentialIds, T0 } from "./store-fixture.ts";

/** A refusal as pi's retry policy sees it: an error assistant message. */
const asProviderError = (errorMessage: string): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: "faux",
  provider: "faux",
  model: "faux-1",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "error",
  errorMessage,
  timestamp: 0,
});

const REFUSAL_REASONS: readonly Refusal[] = [
  "ceiling_exceeded",
  "usage_unavailable",
  "no_job",
  "paused",
];

describe("refusal text (EX-6)", () => {
  it.each(REFUSAL_REASONS)("%s is not pi-ai-retryable", (reason) => {
    expect(isRetryableAssistantError(asProviderError(REFUSALS[reason]))).toBe(false);
  });

  it.each(REFUSAL_REASONS)("%s carries no retryable wording on its own", (reason) => {
    // Each word alone: none may tip pi-ai's retryable pattern.
    for (const word of REFUSALS[reason].split(/\s+/)) {
      expect(isRetryableAssistantError(asProviderError(word))).toBe(false);
    }
  });

  it("a GateRefused carries its reason and the fixed text", () => {
    const refused = new GateRefused("usage_unavailable");
    expect(refused.reason).toBe("usage_unavailable");
    expect(refused.message).toBe(REFUSALS.usage_unavailable);
  });
});

// --- the view, over a scripted gate (VT-3) -----------------------------------------

interface ScriptedGate extends Gate {
  /** Entry points the gate was asked to admit, oldest first. */
  seen: EntryPoint[];
}

/** A gate that admits with `decision`'s cap, or refuses with its reason. */
function scriptedGate(decision: Admission | Refusal): ScriptedGate {
  const seen: EntryPoint[] = [];
  return {
    seen,
    admit: (entryPoint): Promise<Admission> => {
      seen.push(entryPoint);
      return typeof decision === "string"
        ? Promise.reject(new GateRefused(decision))
        : Promise.resolve(decision);
    },
  };
}

const CONTEXT: Context = { messages: [] };
const HANDLE: DeferredHandle = { provider: "rec", modelId: "chat", api: "rec-chat", id: "h-1" };

/** What an entry point's caller got: its stop reason and error, or its rejection. */
interface Outcome {
  stopReason: string;
  errorMessage?: string | undefined;
}

interface EntryRow {
  entry: EntryPoint;
  /** The provider method an admitted request reaches. */
  method: ProviderMethod;
  call: (models: Models, maxTokens?: number) => Promise<Outcome>;
}

const options = (maxTokens?: number): { maxTokens?: number } =>
  maxTokens === undefined ? {} : { maxTokens };

const ENTRY_ROWS: readonly EntryRow[] = [
  {
    entry: "stream",
    method: "stream",
    call: (m, max) => m.stream(CHAT_MODEL, CONTEXT, options(max)).result(),
  },
  {
    entry: "complete",
    method: "stream",
    call: (m, max) => m.complete(CHAT_MODEL, CONTEXT, options(max)),
  },
  {
    entry: "streamSimple",
    method: "streamSimple",
    call: (m, max) => m.streamSimple(CHAT_MODEL, CONTEXT, options(max)).result(),
  },
  {
    entry: "completeSimple",
    method: "streamSimple",
    call: (m, max) => m.completeSimple(CHAT_MODEL, CONTEXT, options(max)),
  },
  {
    entry: "streamDeferred",
    method: "fetchDeferred",
    call: (m) => m.streamDeferred(CHAT_MODEL, HANDLE).result(),
  },
  {
    entry: "fetchDeferred",
    method: "fetchDeferred",
    call: (m) => m.fetchDeferred(CHAT_MODEL, HANDLE),
  },
  {
    entry: "cancelDeferred",
    method: "cancelDeferred",
    call: async (m): Promise<Outcome> => {
      await m.cancelDeferred(CHAT_MODEL, HANDLE);
      return { stopReason: "stop" };
    },
  },
  {
    entry: "generateImages",
    method: "generateImages",
    call: (m) => m.generateImages(IMAGE_MODEL, { input: [] }),
  },
  {
    entry: "classify",
    method: "classify",
    call: (m) => m.classify(CLASSIFIER_MODEL, { state: {}, questions: {} }),
  },
];

const CAPPED_ROWS = ENTRY_ROWS.filter(
  (row) => row.method === "stream" || row.method === "streamSimple",
);

describe("every runtime.models entry point is gated (VT-3, EX-5)", () => {
  it.each(ENTRY_ROWS)("$entry admitted: one gate admission, one provider request", async (row) => {
    const gate = scriptedGate({ maxTokens: 300 });
    const real = recordingModels();

    const outcome = await row.call(gatedModels(real.models, gate));

    expect(outcome.stopReason).toBe("stop");
    expect(gate.seen).toEqual([row.entry]);
    expect(real.calls.map((call) => call.method)).toEqual([row.method]);
  });

  it.each(ENTRY_ROWS.filter((row) => row.entry !== "cancelDeferred"))(
    "$entry refused: no provider request, the refusal is an error result",
    async (row) => {
      const gate = scriptedGate("ceiling_exceeded");
      const real = recordingModels();

      const outcome = await row.call(gatedModels(real.models, gate));

      expect(outcome).toMatchObject({
        stopReason: "error",
        errorMessage: REFUSALS.ceiling_exceeded,
      });
      expect(gate.seen).toEqual([row.entry]);
      expect(real.calls).toEqual([]);
    },
  );

  it("cancelDeferred refused: rejects GateRefused, no provider request", async () => {
    const gate = scriptedGate("usage_unavailable");
    const real = recordingModels();

    const cancelled = gatedModels(real.models, gate).cancelDeferred(CHAT_MODEL, HANDLE);

    await expect(cancelled).rejects.toBeInstanceOf(GateRefused);
    await expect(cancelled).rejects.toMatchObject({ reason: "usage_unavailable" });
    expect(real.calls).toEqual([]);
  });

  it.each(CAPPED_ROWS)(
    "$entry: the provider's maxTokens is the least of caller's and gate's",
    async (row) => {
      const real = recordingModels();
      const view = gatedModels(real.models, scriptedGate({ maxTokens: 300 }));

      await row.call(view, 900);
      await row.call(view, 100);
      await row.call(view);

      expect(real.calls.map((call) => call.maxTokens)).toEqual([300, 100, 300]);
    },
  );

  it("hands out no provider: a raw provider would reach the network ungated (OQ-B)", () => {
    const view = gatedModels(recordingModels().models, scriptedGate({ maxTokens: 1 }));

    expect(view.getProviders()).toEqual([]);
    expect(view.getProvider("rec")).toBeUndefined();
    expect(view.getModel("rec", "chat")).toEqual(CHAT_MODEL);
  });
});

// --- the gate on a harness (VT-1, VT-3) ----------------------------------------------

/** Generous ceilings; each test lowers the one it exercises. */
const CEILINGS: Ceilings = {
  model_requests: 100,
  cost_usd: 100,
  tokens: 1_000_000,
  active_wall_clock_s: 3600,
};

interface GatedOptions extends FauxHarnessOptions {
  ceilings?: Partial<Ceilings>;
  usageOf?: GateDeps["usageOf"];
  /** The run's pause signal, as the meter reads it; default: never fired. */
  pausePending?: () => boolean;
}

interface GatedWorld extends TestHarness {
  jobs: JobStore;
  job: Job;
  /** Entry points the gate was asked to admit, oldest first. */
  seen: EntryPoint[];
  /** Refusals the run was told of. */
  refusals: Exhaustion[];
  modelRequests: () => Promise<number | undefined>;
  ceilingEvents: () => Promise<JsonRecord[]>;
}

/**
 * A runner store at `path` with one `running` job, seated, and a faux-model
 * harness on the same adapter whose catalog is the gated view.
 */
async function openGated(path: string, options: GatedOptions = {}): Promise<GatedWorld> {
  const store = await openRunnerStore(path, { newId: sequentialIds() });
  const { jobs } = store;
  // Bound once open, as start.ts binds them.
  const usage = harnessUsage();
  const late: { seated?: GateJob } = {};
  const gate = createModelGate({
    seated: () => late.seated,
    jobs,
    now: () => T0 + 10,
    usageOf: options.usageOf ?? usage.usageOf,
  });
  const seen: EntryPoint[] = [];
  const spied: Gate = {
    admit: (entryPoint, model): Promise<Admission> => {
      seen.push(entryPoint);
      return gate.admit(entryPoint, model);
    },
  };
  const opened = await openFauxHarness(store.storage, {
    ...options,
    models: (models) => gatedModels(models, spied),
  });
  usage.bind(opened.harness);
  let { job } = await jobs.submit(NEW_JOB, T0);
  if (job.state === "queued") {
    await jobs.transition(job.id, "preparing", T0 + 1);
    job = await jobs.transition(job.id, "running", T0 + 2);
  }
  const refusals: Exhaustion[] = [];
  late.seated = {
    id: job.id,
    meter: {
      conversation: opened.root.id,
      ceilings: { ...CEILINGS, ...options.ceilings },
      softThreshold: 0.8,
      refused: (reason): void => {
        refusals.push(reason);
      },
      warnDue: (): void => undefined,
      pausePending: options.pausePending ?? ((): boolean => false),
    },
  };
  return {
    ...opened,
    jobs,
    job,
    seen,
    refusals,
    modelRequests: async () => (await jobs.get(job.id))?.modelRequests,
    ceilingEvents: async () =>
      (await jobs.events(job.id))
        .filter((event) => event.kind === "ceiling")
        .map((event) => event.payload),
  };
}

const answer = (text: string): AssistantMessage => fauxAssistantMessage([fauxText(text)]);
const providerError = (errorMessage: string): AssistantMessage =>
  fauxAssistantMessage([], { stopReason: "error", errorMessage });

const FAST_RETRY: HarnessSettings["retry"] = { enabled: true, maxRetries: 3, baseDelayMs: 1 };
const NO_RETRY: HarnessSettings["retry"] = { enabled: false };
const SETTLE_MS = 10_000;

const ask = async (root: Conversation, content: string): Promise<SettledSubmissionRecord> =>
  within(
    SETTLE_MS,
    "submission",
    (await root.submit({ type: "input", content }, context)).wait(context),
  );

/** The newest assistant message: the run's last answer or failure. */
async function lastAnswer(root: Conversation): Promise<AssistantMessage> {
  const page = await root.entries({}, 50, undefined, context);
  const entry = page.items.find((item) => AssistantEntry.is(item));
  const message = entry?.model?.[0];
  if (message?.role !== "assistant") {
    throw new Error("no assistant answer");
  }
  return message;
}

describe("the gate on a harness (VT-1)", () => {
  let cleanup: (() => Promise<void>) | undefined;
  let open: Harness | undefined;
  afterEach(async () => {
    if (open !== undefined) {
      await closeHarness(open);
    }
    open = undefined;
    await cleanup?.();
  });

  const start = async (options: GatedOptions = {}): Promise<GatedWorld & { path: string }> => {
    const tmp = await tempDir();
    cleanup = tmp.cleanup;
    const path = join(tmp.dir, "runner.sqlite");
    const world = await openGated(path, options);
    open = world.harness;
    return { ...world, path };
  };

  it("streamSimple: budget available — one provider request, model_requests = 1", async () => {
    const w = await start();
    w.faux.setResponses([answer("hello")]);

    await ask(w.root, "hi");

    expect(w.faux.state.callCount).toBe(1);
    expect(w.seen).toEqual(["streamSimple"]);
    expect(await w.modelRequests()).toBe(1);
    expect(await w.ceilingEvents()).toEqual([]);
  });

  it.each([
    ["marked durably", false],
    ["signalled to the run", true],
  ])(
    "the job's pause %s: refused paused — no provider request, no count, no ceiling event, no latch",
    async (_how, signalled) => {
      const w = await start({ pausePending: () => signalled });
      if (!signalled) {
        await w.jobs.markPause(w.job.id, T0 + 5, { op: "exec" });
      }
      w.faux.setResponses([answer("never")]);

      await ask(w.root, "hi");

      expect(w.faux.state.callCount).toBe(0);
      expect(await w.modelRequests()).toBe(0);
      expect(await w.ceilingEvents()).toEqual([]);
      expect(w.refusals).toEqual([]);
      expect((await lastAnswer(w.root)).errorMessage).toBe(REFUSALS.paused);
    },
  );

  it("streamSimple: model_requests exhausted — no provider request, one ceiling event", async () => {
    const w = await start({ ceilings: { model_requests: 1 } });
    w.faux.setResponses([answer("one"), answer("never")]);
    await ask(w.root, "a");

    await ask(w.root, "b");
    await ask(w.root, "c");

    expect(w.faux.state.callCount).toBe(1);
    expect(await w.modelRequests()).toBe(1);
    expect((await lastAnswer(w.root)).errorMessage).toBe(REFUSALS.ceiling_exceeded);
    expect(w.refusals).toEqual(["ceiling_exceeded", "ceiling_exceeded"]);
    expect(await w.ceilingEvents()).toEqual([
      { reason: "ceiling_exceeded", source: "gate", entryPoint: "streamSimple" },
    ]);
  });

  it("retry: the failed attempt spends the last request; the refusal is not retryable, no retry", async () => {
    const w = await start({ ceilings: { model_requests: 1 }, settings: { retry: FAST_RETRY } });
    w.faux.setResponses([providerError("503 overloaded"), answer("never")]);

    await ask(w.root, "hi");

    expect(w.faux.state.callCount).toBe(1);
    // The retryable failure is retried once; the refusal ends it (not 3+ asks).
    expect(w.seen).toEqual(["streamSimple", "streamSimple"]);
    const refused = await lastAnswer(w.root);
    expect(refused.errorMessage).toBe(REFUSALS.ceiling_exceeded);
    expect(isRetryableAssistantError(refused)).toBe(false);
    expect(await w.modelRequests()).toBe(1);
  });

  const compactable = { compaction: { keepRecentTokens: 1 }, retry: NO_RETRY } as const;

  it("completeSimple: a manual compaction is refused when exhausted", async () => {
    const w = await start({ ceilings: { model_requests: 2 }, settings: compactable });
    w.faux.setResponses([answer("one"), answer("two"), answer("never")]);
    await ask(w.root, "a");
    await ask(w.root, "b");

    const task = await w.root.compact(undefined, context);
    const settled = await within(SETTLE_MS, "compaction", w.harness.waitForTask(task, context));

    expect(settled.state.outcome).toMatchObject({ status: "failed" });
    expect(JSON.stringify(settled.state.outcome)).toContain(REFUSALS.ceiling_exceeded);
    expect(w.faux.state.callCount).toBe(2);
    expect(w.seen).toEqual(["streamSimple", "streamSimple", "completeSimple"]);
  });

  it("completeSimple: a threshold compaction is refused when exhausted", async () => {
    const w = await start({
      ceilings: { model_requests: 1 },
      fauxOptions: { models: [{ id: "faux-1", contextWindow: 2000, maxTokens: 100 }] },
      settings: {
        retry: NO_RETRY,
        compaction: { keepRecentTokens: 1, reserveTokens: 1000, backgroundTokens: 0 },
      },
    });
    w.faux.setResponses([answer("word ".repeat(1200)), answer("never"), answer("never")]);
    await ask(w.root, "a");

    const settled = await ask(w.root, "b");

    expect(w.faux.state.callCount).toBe(1);
    expect(w.seen).toEqual(["streamSimple", "completeSimple"]);
    expect(settled).toMatchObject({ status: "unanswered", reason: "model_error" });
    expect(settled.detail).toContain(REFUSALS.ceiling_exceeded);
  });

  it("a failed attempt counts, and model_requests survives a reopen", async () => {
    const first = await start({ ceilings: { model_requests: 2 }, settings: { retry: NO_RETRY } });
    first.faux.setResponses([providerError("400 invalid request"), answer("two")]);
    await ask(first.root, "a");
    await ask(first.root, "b");
    expect(await first.modelRequests()).toBe(2);
    await closeHarness(first.harness);
    open = undefined;

    const second = await openGated(first.path, {
      ceilings: { model_requests: 2 },
      settings: { retry: NO_RETRY },
    });
    open = second.harness;
    second.faux.setResponses([answer("never")]);

    await ask(second.root, "c");

    expect(second.job.id).toBe(first.job.id);
    expect(second.faux.state.callCount).toBe(0);
    expect(await second.modelRequests()).toBe(2);
    expect(second.refusals).toEqual(["ceiling_exceeded"]);
  });

  it("unreadable usage refuses usage_unavailable, no provider request (I10)", async () => {
    const w = await start({ usageOf: () => Promise.reject(new Error("usage gone")) });
    w.faux.setResponses([answer("never")]);

    await ask(w.root, "hi");

    expect(w.faux.state.callCount).toBe(0);
    expect(await w.modelRequests()).toBe(0);
    expect((await lastAnswer(w.root)).errorMessage).toBe(REFUSALS.usage_unavailable);
    expect(w.refusals).toEqual(["usage_unavailable"]);
    expect(await w.ceilingEvents()).toMatchObject([{ reason: "usage_unavailable" }]);
  });

  it("caps maxTokens from the remaining tokens and cost; a cap under 1 refuses", async () => {
    const asked: (number | undefined)[] = [];
    const recordCap: FauxResponseStep = (_context, streamOptions) => {
      asked.push(streamOptions?.maxTokens);
      return answer("ok");
    };
    const priced = { models: [{ id: "faux-1", maxTokens: 16_384, cost: PER_TOKEN_DOLLAR }] };
    const byTokens = await start({ ceilings: { tokens: 50 } });
    byTokens.faux.setResponses([recordCap]);
    await ask(byTokens.root, "a");
    await closeHarness(byTokens.harness);
    const byCost = await start({ ceilings: { cost_usd: 7 }, fauxOptions: priced });
    byCost.faux.setResponses([recordCap]);
    await ask(byCost.root, "a");
    await closeHarness(byCost.harness);
    const capless = await start({ ceilings: { cost_usd: 0.5 }, fauxOptions: priced });
    open = capless.harness;
    capless.faux.setResponses([recordCap]);
    await ask(capless.root, "a");

    expect(asked).toEqual([50, 7]);
    expect(capless.faux.state.callCount).toBe(0);
    expect(capless.refusals).toEqual(["ceiling_exceeded"]);
  });

  it("fetchDeferred: every deferred poll is counted; an exhausted one reaches no provider", async () => {
    const deferred: GatedOptions = {
      settings: { stream: { deferred: true }, retry: NO_RETRY },
      fauxOptions: { deferred: { pendingFetches: 1, pollAfterMs: 1 } },
    };
    const counted = await start(deferred);
    counted.faux.setResponses([answer("late")]);
    await ask(counted.root, "hi");
    expect(counted.faux.state.deferredFetchCount).toBeGreaterThanOrEqual(1);
    expect(counted.seen).toContain("fetchDeferred");
    expect(await counted.modelRequests()).toBe(1 + counted.faux.state.deferredFetchCount);
    await closeHarness(counted.harness);

    const exhausted = await start({ ...deferred, ceilings: { model_requests: 1 } });
    open = exhausted.harness;
    exhausted.faux.setResponses([answer("never")]);
    await ask(exhausted.root, "hi");

    expect(exhausted.faux.state.deferredFetchCount).toBe(0);
    expect(exhausted.seen).toEqual(["streamSimple", "fetchDeferred"]);
    expect(await exhausted.ceilingEvents()).toMatchObject([{ entryPoint: "fetchDeferred" }]);
  });

  it("cancelDeferred: refused when exhausted (DEC-057, OQ-A); the abort still completes", async () => {
    const w = await start({
      ceilings: { model_requests: 1 },
      settings: { stream: { deferred: true }, retry: NO_RETRY },
      fauxOptions: { deferred: { pendingFetches: 1, pollAfterMs: 60_000 } },
    });
    w.faux.setResponses([answer("never")]);
    const submission = await w.root.submit({ type: "input", content: "hi" }, context);
    await vi.waitFor(() => {
      expect(w.faux.state.callCount).toBe(1);
    });
    // Let the generation commit its poll checkpoint before the abort reads it.
    await new Promise((resolve) => setTimeout(resolve, 200));

    await within(SETTLE_MS, "abort", w.root.abort(context));
    await within(SETTLE_MS, "settle", submission.wait(context));

    expect(w.seen).toEqual(["streamSimple", "cancelDeferred"]);
    expect(w.faux.state.cancelledDeferred).toEqual([]);
    expect(await w.ceilingEvents()).toMatchObject([{ entryPoint: "cancelDeferred" }]);
  });

  it("runtime.models from a tool: complete, stream and completeSimple are gated and counted", async () => {
    const outcomes: string[] = [];
    const probe = defineTool({
      name: "probe",
      description: "Calls the model itself.",
      parameters: Type.Object({}),
      execute: async (_args, api) => {
        const model = api.models.getModel("faux", "faux-1");
        if (model === undefined) {
          throw new Error("no faux model");
        }
        const request = { messages: [] };
        outcomes.push((await api.models.completeSimple(model, request)).stopReason);
        outcomes.push((await api.models.complete(model, request)).stopReason);
        outcomes.push((await api.models.stream(model, request).result()).stopReason);
        return { output: [{ type: "text", text: "probed" }] };
      },
    });
    const w = await start({
      ceilings: { model_requests: 2 },
      extensions: [defineExtension({ name: "probe", tools: [probe] })],
      settings: { retry: NO_RETRY },
    });
    w.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("probe", {}, { id: "call-1" })], {
        stopReason: "toolUse",
      }),
      answer("from completeSimple"),
      answer("never"),
    ]);

    await ask(w.root, "probe");

    // Generation and the tool's completeSimple admitted; complete and stream refused.
    expect(outcomes).toEqual(["stop", "error", "error"]);
    expect(w.faux.state.callCount).toBe(2);
    expect(w.seen.slice(0, 4)).toEqual(["streamSimple", "completeSimple", "complete", "stream"]);
    expect(await w.modelRequests()).toBe(2);
  });

  it("no seated job: refused no_job, nothing counted, nothing signalled", async () => {
    const store = await openTestStore();
    const gate = createModelGate({
      seated: () => undefined,
      jobs: store.jobs,
      now: () => T0,
      usageOf: () => Promise.resolve({ tokens: 0, costUsd: 0 }),
    });

    await expect(gate.admit("streamSimple", CHAT_MODEL)).rejects.toMatchObject({
      reason: "no_job",
    });
  });
});

/** USD 1 per output token: `model.cost` is USD per million tokens. */
const PER_TOKEN_DOLLAR = { input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0 };

describe("the gate's usage read (I10, AS-2)", () => {
  const usage = (totalTokens: number, total: number): UsageState["models"][string] => ({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
  });

  it("sums tokens and cost over the models and tools buckets; none yet is zero", () => {
    const state: UsageState = {
      models: { "faux/faux-1": usage(100, 0.5), "faux/faux-2": usage(20, 0.25) },
      tools: { bash: usage(3, 0.125) },
    };

    expect(spendOf(state)).toEqual({ tokens: 123, costUsd: 0.875 });
    expect(spendOf(undefined)).toEqual({ tokens: 0, costUsd: 0 });
  });

  it("is unreadable until a harness is bound", async () => {
    const { harness, root } = await openFauxHarness(new MemoryStorage(), { resume: false });
    onTestFinished(() => closeHarness(harness));

    await expect(harnessUsage().usageOf(root.id)).rejects.toThrow("harness not open");
  });
});

describe("catalogLimits: a recorded policy's model limits", () => {
  it("reads the catalog's model; undefined for an unknown or malformed reference", () => {
    const { models } = fauxModels();
    const limitsOf = catalogLimits(models);
    expect(limitsOf("faux/faux-1")?.maxOutputTokens).toBeGreaterThan(0);
    expect(limitsOf("faux/nope")).toBeUndefined();
    expect(limitsOf("no-slash")).toBeUndefined();
  });
});
