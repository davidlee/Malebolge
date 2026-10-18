// Model catalog: pi-ai's built-in providers, plus models the coding agent has
// learnt from its remote catalog (~/.pi/agent/models-store.json) that this
// pi-ai release does not ship. The remote-catalog machinery lives in the coding
// agent, not pi-ai, so reading its store is the cheap way to see the same models.

import { readFileSync } from "node:fs";
import type { AnyModel, Provider } from "@earendil-works/pi-ai";
import { isModelType, type Models } from "@earendil-works/pi-ai/models";
import { builtinModels, builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { isRecord } from "./json.ts";

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
