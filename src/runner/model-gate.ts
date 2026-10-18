// The model gate (design §5.4 "Ceilings", DEC-057 as amended at PHASE-01): a
// `Models` view in front of every provider request entry point the job can
// reach. Before each request the gate refuses if a ceiling is exhausted or
// usage is unreadable; otherwise it counts the request durably and caps its
// output from the remaining budget. It also refuses while the seated job's
// room-down pause is pending (PHASE-09 STOP-1): the run aborts the
// conversation once a call ends with the pause marked, and a request racing
// that abort must not reach the provider. That refusal is not a ceiling.
//
// The view is an explicit object literal, not a Proxy: tsc fails when pi-ai
// grows a member, forcing a review. Each request member admits, then calls
// the *same-named* real method: pi-ai's `complete` calls its own `stream`
// (`this` is the real catalog), so delegating across names would count twice.

import type {
  AnyModel,
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  StreamOptions,
} from "@earendil-works/pi-ai";
import { lazyStream } from "@earendil-works/pi-ai/api/lazy";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  classifierErrorResult,
  imageErrorResult,
  isModelType,
} from "@earendil-works/pi-ai/utils/model-operations";
import {
  type ConversationId,
  type Harness,
  UsageDoc,
  type UsageState,
} from "@earendil-works/pi-durable";
import { context } from "../context.ts";
import { setDefined } from "../fields.ts";
import {
  type Budget,
  type Exhaustion,
  exhausted,
  type ModelLimits,
  maxTokens,
  shouldWarn,
  type Usage,
} from "./ceilings.ts";
import type { Ceilings } from "./config.ts";
import type { Job, JobStore } from "./store.ts";

/** The `Models` members that send a provider request. */
export const ENTRY_POINTS = [
  "stream",
  "complete",
  "streamSimple",
  "completeSimple",
  "streamDeferred",
  "fetchDeferred",
  "cancelDeferred",
  "generateImages",
  "classify",
] as const satisfies readonly (keyof Models)[];

export type EntryPoint = (typeof ENTRY_POINTS)[number];

/**
 * Why the gate refused: a job ceiling, no job seated to charge (fail
 * closed), or the job's pause pending.
 */
export type Refusal = Exhaustion | "no_job" | "paused";

/**
 * The refusal as the model run sees it (`errorMessage`). Fixed text, never
 * pi-ai-retryable (EX-6): "out of budget" matches pi-ai's non-retryable
 * pattern, which is checked first.
 */
export const REFUSALS: Readonly<Record<Refusal, string>> = {
  ceiling_exceeded: "model gate refused the request: job ceiling exhausted (out of budget)",
  usage_unavailable: "model gate refused the request: job usage unreadable (out of budget)",
  no_job: "model gate refused the request: no job to charge (out of budget)",
  // Not a budget: matches neither of pi-ai's patterns, so not retryable either.
  paused: "model gate refused the request: job paused while its room is down",
};

/** A gate refusal. Match it by type and `reason`, never by message. */
export class GateRefused extends Error {
  readonly reason: Refusal;

  constructor(reason: Refusal) {
    super(REFUSALS[reason]);
    this.name = "GateRefused";
    this.reason = reason;
  }
}

/** What an admitted request may spend. */
export interface Admission {
  /** The output cap; applied where the entry point takes one. */
  maxTokens: number;
}

export interface Gate {
  /** Admits (and counts) one request through `entryPoint` to `model`, or throws `GateRefused`. */
  admit: (entryPoint: EntryPoint, model: AnyModel) => Promise<Admission>;
}

/**
 * `options` with `maxTokens` lowered to the admission's cap. Typed at
 * `StreamOptions`: under a free `TApi` no new object is provably
 * `ApiStreamOptions<TApi>`, so `stream`/`complete` are called at `Api`.
 */
const capped = (
  options: StreamOptions | undefined,
  admission: Admission,
): StreamOptions & { maxTokens: number } => ({
  ...options,
  maxTokens: Math.min(options?.maxTokens ?? Number.POSITIVE_INFINITY, admission.maxTokens),
});

/**
 * `call` once the gate admits; `refused` of the refusal otherwise, so an
 * entry point keeps its own failure contract.
 */
async function gatedCall<R>(
  gate: Gate,
  entryPoint: EntryPoint,
  model: AnyModel,
  call: (admission: Admission) => Promise<R>,
  refused: (error: unknown) => R | Promise<R>,
): Promise<R> {
  let admission: Admission;
  try {
    admission = await gate.admit(entryPoint, model);
  } catch (error) {
    return refused(error);
  }
  return call(admission);
}

/** A stream that opens through `open` once the gate admits; a refusal ends it with an error event. */
const gatedStream = (
  gate: Gate,
  entryPoint: EntryPoint,
  model: Model<string>,
  open: (admission: Admission) => AssistantMessageEventStream,
): AssistantMessageEventStream =>
  lazyStream(model, async () => open(await gate.admit(entryPoint, model)));

/** The error message pi-ai makes of a failed request setup (`stopReason: "error"`). */
const failedMessage = (model: Model<string>, error: unknown): Promise<AssistantMessage> =>
  lazyStream(model, () =>
    Promise.reject(error instanceof Error ? error : new Error(String(error))),
  ).result();

/** Rethrows: the entry point's contract is to reject. */
const rethrow = (error: unknown): never => {
  throw error;
};

/**
 * `real` behind `gate`. Providers are not handed out (`getProviders` is
 * empty, `getProvider` none): a raw provider would reach the network
 * ungated (OQ-B). Every other non-request member delegates to `real`.
 */
export function gatedModels(real: Models, gate: Gate): Models {
  return {
    getProviders: () => [],
    getProvider: () => undefined,
    getModels: real.getModels.bind(real),
    getModel: real.getModel.bind(real),
    getModelsOfType: real.getModelsOfType.bind(real),
    getModelOfType: real.getModelOfType.bind(real),
    getAllModels: real.getAllModels.bind(real),
    refresh: real.refresh.bind(real),
    checkAuth: real.checkAuth.bind(real),
    getAvailable: real.getAvailable.bind(real),
    getAvailableOfType: real.getAvailableOfType.bind(real),
    getAllAvailable: real.getAllAvailable.bind(real),
    getAuth: real.getAuth.bind(real),
    login: real.login.bind(real),
    logout: real.logout.bind(real),
    stream: (model, context, options) =>
      gatedStream(gate, "stream", model, (admission) =>
        real.stream<Api>(model, context, capped(options, admission)),
      ),
    complete: (model, context, options) =>
      gatedCall(
        gate,
        "complete",
        model,
        (admission) => real.complete<Api>(model, context, capped(options, admission)),
        (error) => failedMessage(model, error),
      ),
    streamSimple: (model, context, options) =>
      gatedStream(gate, "streamSimple", model, (admission) =>
        real.streamSimple(model, context, capped(options, admission)),
      ),
    completeSimple: (model, context, options) =>
      gatedCall(
        gate,
        "completeSimple",
        model,
        (admission) => real.completeSimple(model, context, capped(options, admission)),
        (error) => failedMessage(model, error),
      ),
    streamDeferred: (model, handle, options) =>
      gatedStream(gate, "streamDeferred", model, () => real.streamDeferred(model, handle, options)),
    fetchDeferred: (model, handle, options) =>
      gatedCall(
        gate,
        "fetchDeferred",
        model,
        () => real.fetchDeferred(model, handle, options),
        (error) => failedMessage(model, error),
      ),
    cancelDeferred: (model, handle, options) =>
      gatedCall(
        gate,
        "cancelDeferred",
        model,
        () => real.cancelDeferred(model, handle, options),
        rethrow,
      ),
    generateImages: (model, context, options) =>
      gatedCall(
        gate,
        "generateImages",
        model,
        () => real.generateImages(model, context, options),
        (error) => imageErrorResult(model, error),
      ),
    classify: (model, context, options) =>
      gatedCall(
        gate,
        "classify",
        model,
        () => real.classify(model, context, options),
        (error) => classifierErrorResult(model, error),
      ),
  };
}

// --- the gate --------------------------------------------------------------------

/** The seated job's side of the gate, for one run. */
export interface Meter {
  /** The job's conversation: whose `pi.usage` is charged. */
  conversation: ConversationId;
  /** The resolved policy's ceilings. */
  ceilings: Ceilings;
  /** `[maxima].soft_threshold`. */
  softThreshold: number;
  /**
   * Told of a refusal before the gate throws it. Signals the run; must not
   * abort the conversation: the gate runs inside a pi task, and an abort
   * from there joins that task (self-join, hang).
   */
  refused: (reason: Exhaustion) => void;
  /** Told after an admission that leaves the warning due (batch B delivers it). */
  warnDue: () => void;
  /** Whether the run's pause signal has fired: the job's pause is pending. */
  pausePending: () => boolean;
}

/** The job a request is charged to: the one seated (DEC-056; pi passes the gate no conversation). */
export interface GateJob {
  id: string;
  meter: Meter;
}

/** Usage the gate reads from pi: tokens and cost. */
export type Spend = Pick<Usage, "tokens" | "costUsd">;

export interface GateDeps {
  seated: () => GateJob | undefined;
  jobs: Pick<JobStore, "admitModelRequest">;
  now: () => number;
  /** The conversation's `pi.usage`; a rejection is unreadable usage (I10). */
  usageOf: (conversation: ConversationId) => Promise<Spend>;
}

/** Entry points whose options take `maxTokens`; the rest are only counted. */
const CAPPED: ReadonlySet<EntryPoint> = new Set([
  "stream",
  "complete",
  "streamSimple",
  "completeSimple",
]);

/**
 * What one request to `model` can cost at most (AS-3). Output is priced at
 * the dearest tier (fail closed). Only a chat model has an output limit; for
 * the others no cap applies, and 0 keeps them from looking near a ceiling.
 */
export function modelLimits(model: AnyModel): ModelLimits {
  const rates = [model.cost.output, ...(model.cost.tiers ?? []).map((tier) => tier.output)];
  return {
    maxOutputTokens: isModelType(model, "chat") ? model.maxTokens : 0,
    outputCostPerToken: Math.max(...rates) / 1e6,
  };
}

/** One request as the judge sees it, less the job row. */
interface Request {
  entryPoint: EntryPoint;
  meter: Meter;
  spend: Spend | undefined;
  limits: ModelLimits;
  now: number;
}

type Verdict =
  | { kind: "admit"; budget: Budget }
  | { kind: "decline" }
  | {
      kind: "refuse";
      reason: Exhaustion;
      ceiling: { reason: Exhaustion; source: "gate"; entryPoint: EntryPoint };
    };

/**
 * Decline while the job's pause is marked (nothing recorded). Refuse when a
 * ceiling is exhausted or usage unreadable, or when a capped request could
 * get no output: a provider may read `maxTokens: 0` as "no limit" (AS-4).
 * Else admit, with the budget before this request.
 */
function judge(request: Request, job: Job): Verdict {
  if (job.pauseRequested) {
    return { kind: "decline" };
  }
  const { meter, spend } = request;
  const budget: Budget = setDefined<Budget>(
    {
      ceilings: meter.ceilings,
      softThreshold: meter.softThreshold,
      used: spend === undefined ? undefined : { ...spend, modelRequests: job.modelRequests },
      activeMs: job.activeMs,
      now: request.now,
      model: request.limits,
    },
    { runningSince: job.runningSince },
  );
  const capless = CAPPED.has(request.entryPoint) && maxTokens(budget) < 1;
  const reason = exhausted(budget) ?? (capless ? "ceiling_exceeded" : undefined);
  return reason === undefined
    ? { kind: "admit", budget }
    : {
        kind: "refuse",
        reason,
        ceiling: { reason, source: "gate", entryPoint: request.entryPoint },
      };
}

/** `budget` with the admitted request counted. */
const counted = (budget: Budget): Budget =>
  budget.used === undefined
    ? budget
    : { ...budget, used: { ...budget.used, modelRequests: budget.used.modelRequests + 1 } };

/**
 * The gate. Binding order per request: the seated job (none: refuse
 * `no_job`, nothing else); its pause signal (fired: refuse `paused`, nothing
 * else); its usage, read from pi outside any host transaction; the judgement
 * and its count or `ceiling` event in one host transaction (a marked pause
 * declines, writing nothing); then refuse `paused` (declined: no signal),
 * refuse (signal the run, throw) or admit (warn if due, return the cap).
 */
export function createModelGate(deps: GateDeps): Gate {
  return {
    admit: async (entryPoint, model): Promise<Admission> => {
      const job = deps.seated();
      if (job === undefined) {
        throw new GateRefused("no_job");
      }
      const { meter } = job;
      if (meter.pausePending()) {
        throw new GateRefused("paused");
      }
      const spend = await deps.usageOf(meter.conversation).catch(() => undefined);
      const now = deps.now();
      const request: Request = { entryPoint, meter, spend, limits: modelLimits(model), now };
      const { verdict } = await deps.jobs.admitModelRequest(job.id, now, (row) =>
        judge(request, row),
      );
      if (verdict.kind === "decline") {
        throw new GateRefused("paused");
      }
      if (verdict.kind === "refuse") {
        meter.refused(verdict.reason);
        throw new GateRefused(verdict.reason);
      }
      if (shouldWarn(counted(verdict.budget))) {
        meter.warnDue();
      }
      return { maxTokens: maxTokens(verdict.budget) };
    },
  };
}

/** Tokens and cost over every bucket of a conversation's `pi.usage`; none yet is zero. */
export function spendOf(state: Readonly<UsageState> | undefined): Spend {
  const spend: Spend = { tokens: 0, costUsd: 0 };
  const buckets = state === undefined ? [] : [state.models, state.tools];
  for (const usage of buckets.flatMap((bucket) => Object.values(bucket))) {
    spend.tokens += usage.totalTokens;
    spend.costUsd += usage.cost.total;
  }
  return spend;
}

/** `usageOf` over a harness bound once it opens. */
export interface HarnessUsage {
  usageOf: GateDeps["usageOf"];
  bind: (harness: Pick<Harness, "snapshot">) => void;
}

/**
 * The gate's usage reads, from the job conversation's `pi.usage`. Bound late:
 * the gate is built before the harness it sits in; until `bind`, usage is
 * unreadable (I10).
 */
export function harnessUsage(): HarnessUsage {
  let bound: Pick<Harness, "snapshot"> | undefined;
  return {
    usageOf: async (conversation): Promise<Spend> => {
      if (bound === undefined) {
        throw new Error("harness not open");
      }
      return spendOf(await bound.snapshot(UsageDoc, conversation, context));
    },
    bind: (harness): void => {
      bound = harness;
    },
  };
}
