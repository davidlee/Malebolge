// A Harness on memory storage driven by pi-ai's faux provider, which replays
// scripted assistant messages in place of a model.

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import {
  type FauxProviderHandle,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  type JsonObject,
  type Conversation,
  type Extension,
  Harness,
  type HarnessOptions,
  type HarnessSettings,
  MemoryStorage,
  type Registry,
  type Storage,
  ToolResultEntry,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { context } from "../src/context.ts";
import { isRecord } from "../src/json.ts";
import { registryOf } from "../src/registry.ts";
import { openSession } from "../src/session.ts";

export const FAUX_MODEL = { provider: "faux", modelId: "faux-1" } as const;

export interface TestHarness {
  harness: Harness;
  root: Conversation;
  faux: FauxProviderHandle;
}

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
    env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }),
  });
  return { ...session, faux };
}

export interface FauxHarnessOptions {
  extensions?: readonly Extension[];
  /** The registry the harness reads, in place of one built from `extensions`. */
  registry?: Registry;
  fauxOptions?: FauxOptions;
  /** What the harness sees in place of the faux catalog, e.g. a gated view of it. */
  models?: (models: Models) => Models;
  settings?: HarnessSettings;
  env?: HarnessOptions["env"];
  /** Enable scheduling once open (default). `false` leaves a passive harness that only reads. */
  resume?: boolean;
}

function harnessOptionsOf(options: FauxHarnessOptions, models: Models): HarnessOptions {
  return {
    models: options.models?.(models) ?? models,
    registry: options.registry ?? registryOf(options.extensions ?? []),
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    ...(options.env === undefined ? {} : { env: options.env }),
  };
}

/**
 * A harness on `storage` whose root runs the faux model, with the harness options
 * `openSession` fixes (settings, environment, scheduling) open to the test.
 */
export async function openFauxHarness(
  storage: Storage,
  options: FauxHarnessOptions = {},
): Promise<TestHarness> {
  const { faux, models } = fauxModels(options.fauxOptions);
  const harness = await Harness.open(storage, harnessOptionsOf(options, models), context);
  const root = await harness.root(context, { agent: { model: FAUX_MODEL } });
  if (options.resume ?? true) {
    harness.resume();
  }
  return { harness, root, faux };
}

/** Scripted model turns: one tool call, then a final text answer. */
export const callThenAnswer = (
  tool: string,
  args: JsonObject,
  answer: string,
): [call: AssistantMessage, answer: AssistantMessage] => [
  fauxAssistantMessage([fauxToolCall(tool, args, { id: "call-1" })], { stopReason: "toolUse" }),
  fauxAssistantMessage([fauxText(answer)]),
];

/** The tool result messages of `conversation` (default: the harness's root), oldest first. */
export async function toolResults(
  harness: Harness,
  conversation?: Conversation,
): Promise<ToolResultMessage[]> {
  const of = conversation ?? (await harness.root(context));
  const page = await of.entries({}, 50, undefined, context);
  return [...page.items]
    .reverse()
    .filter((entry) => ToolResultEntry.is(entry))
    .map((entry) => entry.model?.[0])
    .filter((message) => message?.role === "toolResult");
}

export const textOf = (message: ToolResultMessage): string =>
  message.content.map((block) => (block.type === "text" ? block.text : "")).join("");

/**
 * Run one turn, close the harness, and return the sections of each system
 * prompt it recorded, newest first (the order `entries` pages in).
 */
export async function systemPromptSections(test: TestHarness): Promise<unknown[]> {
  test.faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
  await (await test.root.submit({ type: "input", content: "hi" }, context)).wait(context);
  const page = await test.root.entries({}, 50, undefined, context);
  await test.harness.close(context);
  // The prompt is recorded as a system entry whose message is outside pi-ai's Message type.
  return page.items
    .flatMap((entry): unknown[] => [...(entry.model ?? [])])
    .filter(isRecord)
    .filter((message) => message["role"] === "system")
    .map((message) => message["sections"]);
}
