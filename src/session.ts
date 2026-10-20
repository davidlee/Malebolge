// One durable session: a Harness over a storage, root opened as the default
// conversation, and any run the last process left unfinished resumed.

import type { Models } from "@earendil-works/pi-ai/models";
import {
  type AgentChange,
  type Conversation,
  Harness,
  type Registry,
  type Storage,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { context } from "./context.ts";

export interface Session {
  harness: Harness;
  root: Conversation;
}

export interface SessionOptions {
  models: Models;
  /** The tools and prompt sections this session reads; used as given. */
  registry: Registry;
  /** Applied to root on every open, so a changed model or cwd takes effect on restart. */
  agent: AgentChange;
  /** pi-durable's per-call environment hook: where the agent's tools run (daemon-env.ts). */
  env: (state: { cwd?: string }) => ExecutionEnv;
}

export async function openSession(storage: Storage, options: SessionOptions): Promise<Session> {
  const harness = await Harness.open(
    storage,
    {
      models: options.models,
      registry: options.registry,
      env: options.env,
    },
    context,
  );
  const root = await harness.root(context);
  await root.configure(options.agent, context);
  harness.resume();
  return { harness, root };
}
