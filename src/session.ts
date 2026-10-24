// One durable session: a Harness over a storage, root opened as the default
// conversation, and any run the last process left unfinished resumed.

import type { Models } from "@earendil-works/pi-ai/models";
import {
  type AgentChange,
  type Conversation,
  Harness,
  type HarnessOptions,
  type Registry,
  type Storage,
} from "@earendil-works/pi-durable";
import { context } from "./context.ts";
import { backfillIndex, indexConversation } from "./topics.ts";

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
  /**
   * pi-durable's per-call environment hook: where the agent's tools run, for
   * which conversation, and with what they run (daemon-env.ts). Its target
   * carries the conversation's id, its cwd and an index reader, so a hook is
   * where the `SATAN_*` variables enter a tool's environment (DEC-020).
   */
  env: NonNullable<HarnessOptions["env"]>;
}

export async function openSession(storage: Storage, options: SessionOptions): Promise<Session> {
  const harness = await Harness.open(
    storage,
    {
      models: options.models,
      registry: options.registry,
      env: options.env,
      conversationCreated: indexConversation,
    },
    context,
  );
  const root = await harness.root(context);
  await root.configure(options.agent, context);
  // After `root()`, so root is indexed by the hook like every other conversation,
  // and before `resume()`, so no client and no resumed task outruns the backfill.
  await backfillIndex(harness);
  harness.resume();
  return { harness, root };
}
