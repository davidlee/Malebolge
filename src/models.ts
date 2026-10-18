// Model catalog: pi-ai's built-in providers, plus models the coding agent has
// learnt from its remote catalog (~/.pi/agent/models-store.json) that this
// pi-ai release does not ship. The remote-catalog machinery lives in the coding
// agent, not pi-ai, so reading its store is the cheap way to see the same models.

import { readFileSync } from "node:fs";
import type {
  AnyModel,
  Model,
  ModelCost,
  ModelInputModality,
  OpenAICompletionsCompat,
  Provider,
  ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createProvider, isModelType, type Models } from "@earendil-works/pi-ai/models";
import { builtinModels, builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { optionalRecord, optionalString, required, requireString } from "./fields.ts";
import { isRecord, type JsonRecord } from "./json.ts";

export type StoredModels = Readonly<Record<string, readonly AnyModel[]>>;

/** `provider`, offering also those of `candidates` its catalog lacks. */
export function withMissingModels(provider: Provider, candidates: readonly AnyModel[]): Provider {
  const known = new Set(provider.getModels().map((model) => model.id));
  const missing = candidates.filter((model) => !known.has(model.id));
  if (missing.length === 0) {
    return provider;
  }
  const missingChat = missing.filter((model) => isModelType(model, "chat"));
  return {
    ...provider,
    getModels: () => [...provider.getModels(), ...missingChat],
    getAllModels: () => [...(provider.getAllModels?.() ?? provider.getModels()), ...missing],
  };
}

/** The coding agent's model store, by provider id; empty when absent. */
export function readModelsStore(path: string): StoredModels {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const store: unknown = JSON.parse(text);
  if (!isRecord(store)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(store).map(([provider, entry]) => [provider, storedModelsOf(entry)]),
  );
}

/** The models of one store entry. The store is the coding agent's, so only identity is checked. */
function storedModelsOf(entry: unknown): AnyModel[] {
  const models = isRecord(entry) ? entry["models"] : undefined;
  return Array.isArray(models) ? models.filter(isStoredModel) : [];
}

function isStoredModel(value: unknown): value is AnyModel {
  return (
    isRecord(value) && typeof value["id"] === "string" && typeof value["provider"] === "string"
  );
}

export function createDaemonModels(stored: StoredModels): Models {
  const models = builtinModels();
  for (const provider of builtinProviders()) {
    const candidates = stored[provider.id];
    if (candidates !== undefined) {
      models.setProvider(withMissingModels(provider, candidates));
    }
  }
  return models;
}

// The gateway-routed provider (design §5.1; user ruling 2026-10-19). Model
// requests go host -> the LLM gateway, which holds the upstream keys; this
// provider reads the catalog `~/flakes` renders for the jails (`piGatewayConfig`,
// the coding agent's models.json shape) and carries a gateway key issued to
// this binary. The key lives in a closure: never in process.env, never on argv.

/** The provider id catalog references use: `gateway/<model id>`. */
export const GATEWAY_PROVIDER = "gateway";

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

/** The `catalog` provider, authenticating every request with `key` (held in the closure). */
export function gatewayProvider(catalog: GatewayCatalog, key: string): Provider {
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
    api: openAICompletionsApi(),
  });
}
