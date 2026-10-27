// The gateway-routed provider both binaries use (design §5.1; user ruling
// 2026-10-19). Model requests go host -> the LLM gateway, which holds the
// upstream keys; this provider reads the catalog `~/flakes` renders for the
// jails (`piGatewayConfig`, the coding agent's models.json shape) and carries a
// gateway key issued to the binary. The key lives in a closure: never in
// process.env, never on argv.

import { readFile } from "node:fs/promises";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Model,
  type ModelCost,
  type ModelInputModality,
  type OpenAICompletionsCompat,
  type Provider,
  type ProviderStreams,
  type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels, createProvider, type Models } from "@earendil-works/pi-ai/models";
import { durationOf } from "./duration.ts";
import { optionalRecord, optionalString, required, requireString } from "./fields.ts";
import { isRecord, type JsonRecord } from "./json.ts";
import { messageOf } from "./message-of.ts";

/** The provider id catalog references use: `gateway/<model id>`. */
export const GATEWAY_PROVIDER = "gateway";

export interface ModelRef {
  provider: string;
  modelId: string;
}

export const DEFAULT_MODEL = "gateway/deepseek-flash";

export function parseModel(ref: string): ModelRef {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    throw new Error(`model must be provider/model, got ${JSON.stringify(ref)}`);
  }
  return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

type GatewayModel = Model<"openai-completions">;

/** A parsed gateway catalog: the provider's endpoint and its models, `provider` and `baseUrl` set. */
export interface GatewayCatalog {
  baseUrl: string;
  models: readonly GatewayModel[];
}

/** `fields[key]` as a finite number; the catalog is data we render, but a gap must not price a model at zero. */
function requireNumber(fields: JsonRecord, key: string, where: string): number {
  const value = fields[key];
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  throw new Error(`${where}${key} must be a non-negative number`);
}

function requirePositiveInt(fields: JsonRecord, key: string): number {
  const value = requireNumber(fields, key, "");
  if (!Number.isInteger(value) || value === 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
}

/** Required: a gateway model without a price would make the cost ceiling inert (DEC-057). */
function requireCost(fields: JsonRecord): ModelCost {
  const cost = required(fields, "cost", optionalRecord);
  return {
    input: requireNumber(cost, "input", "cost."),
    output: requireNumber(cost, "output", "cost."),
    cacheRead: requireNumber(cost, "cacheRead", "cost."),
    cacheWrite: requireNumber(cost, "cacheWrite", "cost."),
  };
}

const isModality = (value: unknown): value is ModelInputModality =>
  value === "text" || value === "image";

function inputOf(fields: JsonRecord): ModelInputModality[] {
  const input = fields["input"] ?? ["text"];
  if (Array.isArray(input) && input.length > 0 && input.every(isModality)) {
    return input;
  }
  throw new Error('input must be a non-empty array of "text" / "image"');
}

// The two pass-through tables are the coding agent's own schema, rendered from
// our nix; only their shape (a table) is checked here.
const isThinkingLevelMap = (value: unknown): value is ThinkingLevelMap => isRecord(value);
const isCompat = (value: unknown): value is OpenAICompletionsCompat => isRecord(value);

function gatewayModel(fields: JsonRecord, baseUrl: string): GatewayModel {
  const id = requireString(fields, "id");
  const thinkingLevelMap = fields["thinkingLevelMap"];
  const compat = fields["compat"];
  const reasoning = fields["reasoning"];
  const model: GatewayModel = {
    id,
    name: optionalString(fields, "name") ?? id,
    api: "openai-completions",
    provider: GATEWAY_PROVIDER,
    baseUrl,
    input: inputOf(fields),
    cost: requireCost(fields),
    reasoning: reasoning === true,
    contextWindow: requirePositiveInt(fields, "contextWindow"),
    maxTokens: requirePositiveInt(fields, "maxTokens"),
  };
  if (isThinkingLevelMap(thinkingLevelMap)) {
    model.thinkingLevelMap = thinkingLevelMap;
  }
  if (isCompat(compat)) {
    model.compat = compat;
  }
  return model;
}

/** The only provider entry of a catalog document. */
function soleProvider(doc: unknown): JsonRecord {
  const providers =
    isRecord(doc) && isRecord(doc["providers"]) ? Object.values(doc["providers"]) : [];
  const [entry, ...rest] = providers;
  if (!isRecord(entry) || rest.length > 0) {
    throw new Error("gateway catalog must hold exactly one provider");
  }
  return entry;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error("gateway catalog is not valid JSON", { cause: error });
  }
}

/**
 * The one provider of a gateway catalog (`models.json` text). Anything else
 * refuses, with the offending field named: nothing is defaulted (I13).
 */
export function parseGatewayCatalog(text: string): GatewayCatalog {
  const entry = soleProvider(parseJson(text));
  if (entry["api"] !== "openai-completions") {
    throw new Error('gateway catalog api must be "openai-completions"');
  }
  const baseUrl = requireString(entry, "baseUrl");
  const models = entry["models"];
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error("gateway catalog models must be a non-empty array");
  }
  return {
    baseUrl,
    models: models.map((model: unknown) => {
      if (!isRecord(model)) {
        throw new Error("gateway catalog model must be an object");
      }
      return gatewayModel(model, baseUrl);
    }),
  };
}

/**
 * How long one model request may run, from its start across headers and the
 * whole body (design sec-5, Model stream deadline). pi-ai's `timeoutMs` stops
 * at response headers on this path: the OpenAI SDK clears its timer once
 * `fetch` returns (RV-062 F-13).
 */
export const MODEL_STREAM_DEADLINE_MS = 2 * 60 * 60 * 1000;

/**
 * The error a request past its deadline ends with. Deliberately not wording
 * pi-ai's classifier deems transient, so pi-durable fails the run with
 * `model_error` rather than retrying it (RV-062 F-16). It carries no streamed
 * partial: the run fails either way.
 */
function expiredMessage(model: Model<Api>, ms: number): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: `model stream exceeded ${durationOf(ms)}`,
    timestamp: Date.now(),
  };
}

/**
 * The stream `open` starts on a signal that also fires `ms` after the request
 * starts; past that, the request is aborted and the stream ends as an error.
 */
function bounded(
  model: Model<Api>,
  ms: number,
  caller: AbortSignal | undefined,
  open: (signal: AbortSignal) => AssistantMessageEventStream,
): AssistantMessageEventStream {
  const outer = createAssistantMessageEventStream();
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    // Ended first, so whatever the abort makes the inner request send is dropped.
    const error = expiredMessage(model, ms);
    outer.push({ type: "error", reason: "error", error });
    outer.end(error);
    deadline.abort();
  }, ms);
  const inner = open(
    caller === undefined ? deadline.signal : AbortSignal.any([caller, deadline.signal]),
  );
  void (async (): Promise<void> => {
    try {
      for await (const event of inner) {
        outer.push(event);
      }
      outer.end(await inner.result());
    } finally {
      clearTimeout(timer);
    }
  })();
  return outer;
}

/**
 * `api` with every model request bounded by `ms` (design sec-5; RV-062 F-13,
 * F-16). Only `stream` and `streamSimple`: deferred fetches pass through
 * unbounded, and the gateway's openai-completions API has none.
 */
export function withStreamDeadline(api: ProviderStreams, ms: number): ProviderStreams {
  return {
    ...api,
    stream: (model, context, options) =>
      bounded(model, ms, options?.signal, (signal) =>
        api.stream(model, context, { ...options, signal }),
      ),
    streamSimple: (model, context, options) =>
      bounded(model, ms, options?.signal, (signal) =>
        api.streamSimple(model, context, { ...options, signal }),
      ),
  };
}

/**
 * The `catalog` provider, authenticating every request with `key` (held in the
 * closure), each request bounded by `deadlineMs`.
 */
export function gatewayProvider(
  catalog: GatewayCatalog,
  key: string,
  deadlineMs = MODEL_STREAM_DEADLINE_MS,
): Provider {
  return createProvider({
    id: GATEWAY_PROVIDER,
    name: "LLM gateway",
    baseUrl: catalog.baseUrl,
    auth: {
      apiKey: {
        name: "LLM gateway key",
        resolve: () => Promise.resolve({ auth: { apiKey: key }, source: "systemd credential" }),
      },
    },
    models: [...catalog.models],
    api: withStreamDeadline(openAICompletionsApi(), deadlineMs),
  });
}

/** The text of `path`, or an error naming `what` and the path. */
async function readRequired(path: string, what: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`${what} ${path}: ${messageOf(error)}`, { cause: error });
  }
}

/** The key in file `path`: its text less one trailing newline. */
async function readKey(path: string): Promise<string> {
  const key = (await readRequired(path, "gateway credential")).replace(/\n$/, "");
  if (key === "") {
    throw new Error(`gateway credential ${path}: file is empty`);
  }
  return key;
}

/**
 * A catalog holding the gateway provider alone, from the catalog file and key
 * file at the given paths. Every failure names a path; none carries the key.
 * Both daemon profiles and the runner load their models here.
 */
export async function loadGatewayModels(
  catalogPath: string,
  keyPath: string,
  deadlineMs = MODEL_STREAM_DEADLINE_MS,
): Promise<Models> {
  const key = await readKey(keyPath);
  const text = await readRequired(catalogPath, "gateway catalog");
  let provider: Provider;
  try {
    provider = gatewayProvider(parseGatewayCatalog(text), key, deadlineMs);
  } catch (error) {
    throw new Error(`gateway catalog ${catalogPath}: ${messageOf(error)}`, { cause: error });
  }
  const models = createModels();
  models.setProvider(provider);
  return models;
}
