// One durable session: a Harness over a storage, its root conversation, and
// any run the last process left unfinished resumed.

import type { Models } from "@earendil-works/pi-ai/models";
import {
  type AgentChange,
  type Conversation,
  type Extension,
  Harness,
  type Storage,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { context } from "./context.ts";
import { registryOf } from "./registry.ts";

export interface Session {
  harness: Harness;
  root: Conversation;
}

export interface SessionOptions {
  models: Models;
  extensions: readonly Extension[];
  /** Applied on every open, so a changed model or cwd takes effect on restart. */
  agent: AgentChange;
}

export async function openSession(storage: Storage, options: SessionOptions): Promise<Session> {
  const harness = await Harness.open(
    storage,
    {
      models: options.models,
      registry: registryOf(options.extensions),
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }),
    },
    context,
  );
  const root = await harness.root(context);
  await root.configure(options.agent, context);
  harness.resume();
  return { harness, root };
}
