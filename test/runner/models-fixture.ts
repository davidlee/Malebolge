// A real pi-ai catalog (`createModels`) over one recording provider that
// implements every provider request method, so a view over the catalog is
// tested through pi-ai's own dispatch. The faux provider has no `classify` or
// `generateImages`; this one has all of them and answers each at once.

import type {
  Api,
  AssistantMessageEventStream,
  ClassifierApi,
  ClassifierModel,
  ImageApi,
  ImageModel,
  Model,
  ModelCost,
  ModelInputModality,
  ProviderStreams,
} from "@earendil-works/pi-ai";
import { createModels, createProvider, type Models } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

/** The provider methods a request reaches. */
export type ProviderMethod =
  | "stream"
  | "streamSimple"
  | "fetchDeferred"
  | "cancelDeferred"
  | "generateImages"
  | "classify";

export interface ProviderCall {
  method: ProviderMethod;
  /** The output cap the provider was asked for, where the method takes one. */
  maxTokens?: number | undefined;
}

const COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const TEXT: ModelInputModality[] = ["text"];
const BASE = { provider: "rec", baseUrl: "http://rec.invalid", input: TEXT, cost: COST };

export const CHAT_MODEL: Model<Api> = {
  ...BASE,
  id: "chat",
  name: "chat",
  api: "rec-chat",
  reasoning: false,
  contextWindow: 10_000,
  maxTokens: 1000,
};

export const IMAGE_MODEL: ImageModel<ImageApi> = {
  ...BASE,
  id: "image",
  name: "image",
  api: "rec-images",
  type: "image",
  output: ["image"],
};

export const CLASSIFIER_MODEL: ClassifierModel<ClassifierApi> = {
  ...BASE,
  id: "classifier",
  name: "classifier",
  api: "rec-classify",
  type: "classifier",
  contextWindow: 10_000,
};

/** A stream that answers "ok" at once. */
function answered(): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const message = fauxAssistantMessage("ok");
  stream.push({ type: "done", reason: "stop", message });
  stream.end(message);
  return stream;
}

export interface RecordingModels {
  models: Models;
  /** Every provider request, oldest first. */
  calls: ProviderCall[];
}

/** A catalog of the three `rec` models whose provider records each request. */
export function recordingModels(): RecordingModels {
  const calls: ProviderCall[] = [];
  const api: ProviderStreams = {
    stream: (_model, _context, options) => {
      calls.push({ method: "stream", maxTokens: options?.maxTokens });
      return answered();
    },
    streamSimple: (_model, _context, options) => {
      calls.push({ method: "streamSimple", maxTokens: options?.maxTokens });
      return answered();
    },
    fetchDeferred: () => {
      calls.push({ method: "fetchDeferred" });
      return answered();
    },
    cancelDeferred: () => {
      calls.push({ method: "cancelDeferred" });
      return Promise.resolve();
    },
  };
  const provider = createProvider({
    id: "rec",
    auth: { apiKey: { name: "Rec", resolve: () => Promise.resolve({ auth: {} }) } },
    models: [CHAT_MODEL, IMAGE_MODEL, CLASSIFIER_MODEL],
    api,
    images: {
      "rec-images": {
        generateImages: (model) => {
          calls.push({ method: "generateImages" });
          return Promise.resolve({
            api: model.api,
            provider: model.provider,
            model: model.id,
            output: [],
            stopReason: "stop",
            timestamp: 0,
          });
        },
      },
    },
    classifiers: {
      "rec-classify": {
        classify: (model) => {
          calls.push({ method: "classify" });
          return Promise.resolve({
            api: model.api,
            provider: model.provider,
            model: model.id,
            answers: {},
            stopReason: "stop",
            timestamp: 0,
          });
        },
      },
    },
  });
  const models = createModels();
  models.setProvider(provider);
  return { models, calls };
}
