// Model catalog: pi-ai's built-in providers, plus models the coding agent has
// learnt from its remote catalog (~/.pi/agent/models-store.json) that this
// pi-ai release does not ship. The remote-catalog machinery lives in the coding
// agent, not pi-ai, so reading its store is the cheap way to see the same models.

import { readFileSync } from "node:fs";
import type { AnyModel, Api, Model, Provider } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { builtinModels, builtinProviders } from "@earendil-works/pi-ai/providers/all";

export type StoredModels = Readonly<Record<string, readonly AnyModel[]>>;

/** `provider`, offering also those of `candidates` its catalog lacks. */
export function withMissingModels(provider: Provider, candidates: readonly AnyModel[]): Provider {
  const known = new Set(provider.getModels().map((model) => model.id));
  const missing = candidates.filter((model) => !known.has(model.id)) as Model<Api>[];
  if (missing.length === 0) return provider;
  return {
    ...provider,
    getModels: () => [...provider.getModels(), ...missing],
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
  const store = JSON.parse(text) as Record<string, { models?: AnyModel[] }>;
  return Object.fromEntries(
    Object.entries(store).map(([provider, entry]) => [provider, entry.models ?? []]),
  );
}

export function createDaemonModels(stored: StoredModels): Models {
  const models = builtinModels();
  for (const provider of builtinProviders()) {
    const candidates = stored[provider.id];
    if (candidates) models.setProvider(withMissingModels(provider, candidates));
  }
  return models;
}
