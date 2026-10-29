// Model catalogs for the model catalog port's tests (SL-010): a real pi-ai
// `Models` built the way production builds the gateway's, and a literal stub
// of the port for tests that want no pi-ai at all.

import type { AnyModel, ImageModel } from "@earendil-works/pi-ai";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import {
  gatewayProvider,
  type ModelCatalog,
  type ModelRef,
  parseGatewayCatalog,
  parseModel,
  UnknownModel,
} from "../src/models.ts";

/** A chat ref whose model id contains slashes: only the first `/` separates provider from id. */
export const SLASHED_REF = "gateway/openai-david/gpt-6.1-terra";

/** A second chat model, so `refs()` sorting is observable. */
export const FLASH_REF = "gateway/deepseek-flash";

/** A non-chat model on the same provider: `refs()` lists chat models only, so it is absent. */
export const IMAGE_REF = "gateway/openai-david/terra-image";

const BASE_URL = "http://127.0.0.1:4000/v1";

/** The catalog document `piGatewayConfig` renders, with two chat models, listed unsorted. */
const CATALOG_TEXT = JSON.stringify({
  providers: {
    gateway: {
      baseUrl: BASE_URL,
      api: "openai-completions",
      models: [
        {
          id: "openai-david/gpt-6.1-terra",
          name: "GPT-6.1 Terra",
          input: ["text"],
          contextWindow: 400_000,
          maxTokens: 128_000,
          cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
        },
        {
          id: "deepseek-flash",
          name: "DeepSeek V4.1 Flash",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 1_000_000,
          maxTokens: 384_000,
          cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
        },
      ],
    },
  },
});

/** An image model: pi-ai lets a chat provider's listing also hold non-chat models. */
const IMAGE_MODEL: ImageModel<"openrouter-images"> = {
  type: "image",
  id: "openai-david/terra-image",
  name: "Terra Image",
  api: "openrouter-images",
  provider: "gateway",
  baseUrl: BASE_URL,
  input: ["text"],
  output: ["image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/**
 * A real pi-ai `Models` catalog holding {@link SLASHED_REF} and {@link FLASH_REF},
 * built the production way (`parseGatewayCatalog` + `gatewayProvider`), plus a
 * non-chat model so `refs()` can be shown to leave it out.
 */
export function slashedModels(): Models {
  const models = createModels();
  const provider = gatewayProvider(parseGatewayCatalog(CATALOG_TEXT), "test-key");
  // `gatewayProvider` lists only the catalog's chat models; extend that listing
  // rather than rebuild the provider by hand.
  const all: AnyModel[] = [...provider.getModels(), IMAGE_MODEL];
  models.setProvider({ ...provider, getAllModels: () => all });
  return models;
}

/**
 * A literal stub of the port over a fixed ref list, for tests of what reads the
 * port (not of pi-ai): `require` parses a listed ref and refuses the rest, and
 * `refs` returns the list sorted.
 */
export function catalogOf(...refs: string[]): ModelCatalog {
  const known = new Set(refs);
  return {
    require: (ref: string): ModelRef => {
      if (!known.has(ref)) {
        throw new UnknownModel(ref);
      }
      return parseModel(ref);
    },
    refs: () => [...refs].sort(),
  };
}
