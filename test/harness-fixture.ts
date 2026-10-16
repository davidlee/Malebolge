// A Harness on memory storage driven by pi-ai's faux provider, which replays
// scripted assistant messages in place of a model.

import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
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
  type Extension,
  type Harness,
  MemoryStorage,
  ToolResultEntry,
} from "@earendil-works/pi-durable";
import { context } from "../src/context.ts";
import { openSession } from "../src/session.ts";

export const FAUX_MODEL = { provider: "faux", modelId: "faux-1" } as const;

export type TestHarness = { harness: Harness; root: Conversation; faux: FauxProviderHandle };

/** A session on memory storage whose root runs the faux model. */
export async function openTestHarness(
  extensions: readonly Extension[],
  fauxOptions?: Parameters<typeof fauxProvider>[0],
): Promise<TestHarness> {
  const faux = fauxProvider(fauxOptions);
  const models = createModels();
  models.setProvider(faux.provider);
  const session = await openSession(new MemoryStorage(), {
    models,
    extensions,
    agent: { model: FAUX_MODEL },
  });
  return { ...session, faux };
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
