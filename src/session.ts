// One durable session: a Harness over a storage, root opened as the default
// conversation, the index backfilled and the toolsets reconciled, and any run
// the last process left unfinished resumed.
//
// The startup reconcile (design sec-3) is what makes a stored conversation's
// extensions a function of its toolset: it refuses a fork or a task-owned
// conversation, backfills an entry written without a toolset, refuses a
// toolset the profile does not allow, and re-derives every list that drifted.
// It runs in one commit, so a refusal rolls back the backfill with it.

import type { Models } from "@earendil-works/pi-ai/models";
import {
  AgentDoc,
  type AgentChange,
  type AgentState,
  type Conversation,
  type ConversationId,
  type ConversationRecord,
  configure,
  Harness,
  type HarnessOptions,
  type Registry,
  type Storage,
} from "@earendil-works/pi-durable";
import type { Profile } from "./config.ts";
import { context } from "./context.ts";
import type { Log } from "./satan-tools.ts";
import {
  backfillIndex,
  entryToolsets,
  type NamedTopic,
  indexConversation,
  scanAll,
} from "./topics.ts";
import {
  type DaemonToolset,
  PROFILE_TOOLSETS,
  type ProfileToolsets,
  requireAllowed,
  selectionOf,
  toolsetList,
} from "./toolsets.ts";

export interface Session {
  harness: Harness;
  root: Conversation;
}

export interface SessionOptions {
  models: Models;
  /** The tools and prompt sections this session reads; used as given. */
  registry: Registry;
  /**
   * Applied to root on every open, so a changed model or cwd takes effect on restart.
   * No `extensions`: the startup reconcile alone writes root's list (design sec-3).
   */
  agent: Omit<AgentChange, "extensions">;
  /**
   * pi-durable's per-call environment hook: where the agent's tools run, for
   * which conversation, and with what they run (daemon-env.ts). Its target
   * carries the conversation's id, its cwd and an index reader, so a hook is
   * where the `SATAN_*` variables enter a tool's environment (DEC-020).
   */
  env: NonNullable<HarnessOptions["env"]>;
  /** The execution profile this store serves: which toolsets its conversations may use. */
  profile: Profile;
  /** Logs the reconcile's changes: one line per conversation whose list it rewrote. */
  log: Log;
  /** The harness clock (pi-durable's `HarnessOptions.now`); a wake's env reads the same function. */
  now?: () => number;
  /** The harness timer (pi-durable's `HarnessOptions.setTimer`); default `setTimeout`. */
  setTimer?: HarnessOptions["setTimer"];
  /**
   * Called synchronously with the complete session after the backfill and the
   * reconcile, before `resume()`: the last point no task has run and no client
   * has been served.
   */
  beforeResume?: (session: Session) => void;
}

/** Whether `stored` is exactly `list`, name for name: a list that drifted is rewritten. */
function sameNames(stored: AgentState["extensions"], list: readonly string[]): boolean {
  return (
    Array.isArray(stored) &&
    stored.length === list.length &&
    stored.every((name, at) => name === list[at])
  );
}

/**
 * Step 0: refuse what this slice cannot reconcile, naming the first in scan order,
 * so neither a fork nor a task-owned conversation is ever given a default toolset.
 */
function refuseUnsupported(records: readonly ConversationRecord[]): void {
  for (const record of records) {
    if (record.parent !== undefined) {
      throw new Error(`conversation ${String(record.id)}: forks are not supported`);
    }
    if (record.owner !== undefined) {
      throw new Error(
        `conversation ${String(record.id)}: task-owned conversations are not supported`,
      );
    }
  }
}

/** One reconciled conversation: its toolset, allowed by step 2, and the list derived from it. */
interface Reconciled {
  id: ConversationId;
  toolset: DaemonToolset;
  list: readonly string[];
}

/**
 * Step 2: every stored topic's toolset and every conversation's is one the profile
 * allows — refused before the first list write, so a refusal leaves the store as it was.
 */
function allowedToolsets(
  entries: readonly { id: ConversationId; toolset: DaemonToolset }[],
  topics: readonly NamedTopic[],
  profile: Profile,
  policy: ProfileToolsets,
): Reconciled[] {
  for (const topic of topics) {
    if (topic.toolset !== undefined) {
      requireAllowed(topic.toolset, profile, policy, `topic ${topic.name}`);
    }
  }
  return entries.map(({ id, toolset }): Reconciled => {
    requireAllowed(toolset, profile, policy, `conversation ${String(id)}`);
    return { id, toolset, list: toolsetList(toolset, profile) };
  });
}

/**
 * Startup reconcile (design sec-3), in one commit: every conversation read before
 * any write, then the entry toolset backfill, the profile's refusals, and the
 * re-derivation of each list. A throw takes the backfill down with it.
 */
async function reconcileToolsets(
  harness: Harness,
  profile: Profile,
  log: Log,
  policy: ProfileToolsets,
): Promise<void> {
  await harness.commit(async (tx) => {
    // Step 0: every scan first — a table read after a table write is pi-durable's `ReadAfterWrite`.
    const records = await scanAll(tx);
    refuseUnsupported(records);

    // Steps 1-2: an entry written without a toolset takes the profile's default, then the checks.
    const { entries, topics } = await entryToolsets(
      tx,
      records.map((record) => record.id),
      policy.default,
    );
    // Step 3: each list that drifted from its toolset's is rewritten and logged.
    for (const each of allowedToolsets(entries, topics, profile, policy)) {
      if (sameNames((await tx.doc(AgentDoc, each.id)).extensions, each.list)) {
        continue;
      }
      await configure(tx, each.id, { extensions: selectionOf(each.list) });
      log(`conversation ${String(each.id)}: toolset ${each.toolset} list changed`);
    }
  }, context);
}

export async function openSession(storage: Storage, options: SessionOptions): Promise<Session> {
  const harness = await Harness.open(
    storage,
    {
      models: options.models,
      registry: options.registry,
      env: options.env,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.setTimer === undefined ? {} : { setTimer: options.setTimer }),
      conversationCreated: indexConversation,
    },
    context,
  );
  const root = await harness.root(context);
  await root.configure(options.agent, context);
  // After `root()`, so root is indexed by the hook like every other conversation,
  // and before `resume()`, so no client and no resumed task outruns either write.
  await backfillIndex(harness);
  await reconcileToolsets(harness, options.profile, options.log, PROFILE_TOOLSETS[options.profile]);
  const session = { harness, root };
  options.beforeResume?.(session);
  harness.resume();
  return session;
}
