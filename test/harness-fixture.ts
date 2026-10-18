// A Harness on memory storage driven by pi-ai's faux provider, which replays
// scripted assistant messages in place of a model.

import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import {
  type FauxProviderHandle,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { JsonObject } from "@earendil-works/pi-durable";
import {
  type Conversation,
  createRegistry,
  type Extension,
  Harness,
  type HarnessOptions,
  type HarnessSettings,
  MemoryStorage,
  type Storage,
  ToolResultEntry,
} from "@earendil-works/pi-durable";
import { context } from "../src/context.ts";
import { openSession } from "../src/session.ts";

export const FAUX_MODEL = { provider: "faux", modelId: "faux-1" } as const;

export type TestHarness = { harness: Harness; root: Conversation; faux: FauxProviderHandle };

export type FauxOptions = Parameters<typeof fauxProvider>[0];

/** A model catalog holding only a fresh faux provider. */
export function fauxModels(fauxOptions?: FauxOptions): {
  faux: FauxProviderHandle;
  models: Models;
} {
  const faux = fauxProvider(fauxOptions);
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models };
}

/** A session on memory storage whose root runs the faux model. */
export async function openTestHarness(
  extensions: readonly Extension[],
  fauxOptions?: FauxOptions,
): Promise<TestHarness> {
  const { faux, models } = fauxModels(fauxOptions);
  const session = await openSession(new MemoryStorage(), {
    models,
    extensions,
    agent: { model: FAUX_MODEL },
  });
  return { ...session, faux };
}

export type FauxHarnessOptions = {
  extensions?: readonly Extension[];
  fauxOptions?: FauxOptions;
  /** What the harness sees in place of the faux catalog, e.g. a gated view of it. */
  models?: (models: Models) => Models;
  settings?: HarnessSettings;
  env?: HarnessOptions["env"];
  /** Enable scheduling once open (default). `false` leaves a passive harness that only reads. */
  resume?: boolean;
};

/**
 * A harness on `storage` whose root runs the faux model, with the harness options
 * `openSession` fixes (settings, environment, scheduling) open to the test.
 */
export async function openFauxHarness(
  storage: Storage,
  options: FauxHarnessOptions = {},
): Promise<TestHarness> {
  const { faux, models } = fauxModels(options.fauxOptions);
  const registry = createRegistry();
  for (const extension of options.extensions ?? []) registry.install(extension);
  const harness = await Harness.open(
    storage,
    {
      models: options.models?.(models) ?? models,
      registry,
      ...(options.settings === undefined ? {} : { settings: options.settings }),
      ...(options.env === undefined ? {} : { env: options.env }),
    },
    context,
  );
  const root = await harness.root(context, { agent: { model: FAUX_MODEL } });
  if (options.resume ?? true) harness.resume();
  return { harness, root, faux };
}

/** Scripted model turns: one tool call, then a final text answer. */
export const callThenAnswer = (tool: string, args: JsonObject, answer: string) => [
  fauxAssistantMessage([fauxToolCall(tool, args, { id: "call-1" })], { stopReason: "toolUse" }),
  fauxAssistantMessage([fauxText(answer)]),
];

/** The tool result messages of a conversation, oldest first. */
export async function toolResults(harness: Harness): Promise<ToolResultMessage[]> {
  const root = await harness.root(context);
  const page = await root.entries({}, 50, undefined, context);
  return [...page.items]
    .reverse()
    .filter((entry) => ToolResultEntry.is(entry))
    .map((entry) => entry.model?.[0] as ToolResultMessage);
}

export const textOf = (message: ToolResultMessage): string =>
  message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
