// Which conversation a wire reference names: `root`, the one an id names, or a
// new one carrying the daemon's creation defaults. `runner/durable-ids.ts`
// answers the other half of the id question (recover the branded id from the
// runner's TEXT column); this module answers the daemon's, from the attach frame.
//
// Invariants (design sec-1): a non-root conversation's model and cwd are the
// daemon's creation-time defaults, and its stored agent settings are never
// rewritten; a conversation id names a conversation only inside this profile's
// store; `cwd` is an opaque string handed to pi, confinement being the jail's
// (DEC-107, CON-005).

import {
  type AgentChange,
  type AgentEventStream,
  type Conversation,
  type ConversationId,
  watchEvents,
} from "@earendil-works/pi-durable";
import { context } from "./context.ts";
import type { AttachTarget } from "./protocol.ts";
import type { Session } from "./session.ts";

/** The daemon's creation defaults; `cwd` is required so the fallback is always a string. */
export type ConversationDefaults = AgentChange & { cwd: string };

export interface Conversations {
  root: Conversation;
  /** The conversation `target` names, or created; rejects with a client-facing message. */
  open(target: AttachTarget): Promise<Conversation>;
  /** The event stream of `conversation`: the transport's only route to the Harness. */
  watch(conversation: Conversation): Promise<AgentEventStream>;
  /** One page of this store's ownerless conversations, newest first (DEC-007). */
  list(): Promise<ConversationPage>;
}

/** Conversations read per listing page: small, so a listing never stalls the turn chain. */
export const LIST_PAGE = 50;

/** One page of a listing: the ids newest first, and whether the page was cut. */
export interface ConversationPage {
  ids: number[];
  truncated: boolean;
}

/** The safe positive integer the wire parser accepts, as pi's branded id. */
export function isConversationKey(n: number): n is ConversationId {
  return Number.isSafeInteger(n) && n > 0;
}

/** A target no conversation in this store answers to. */
const noConversation = (id: number): Error => new Error(`no conversation ${String(id)}`);

/** One read, then ownership: pi's record is the only source of the id kept. */
async function resolveExisting(session: Session, id: ConversationId): Promise<Conversation> {
  const record = await session.harness.commit((tx) => tx.conversation(id), context);
  if (record === undefined) {
    throw noConversation(id);
  }
  if (record.owner !== undefined) {
    throw new Error(`conversation ${String(id)} belongs to a task`);
  }
  const conversation = await session.harness.conversation(record.id, context);
  if (conversation === undefined) {
    throw noConversation(id);
  }
  return conversation;
}

/** A new ownerless conversation: model and cwd land in the creating commit. */
function create(
  session: Session,
  target: Extract<AttachTarget, { kind: "new" }>,
  defaults: ConversationDefaults,
): Promise<Conversation> {
  return session.harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: { ...defaults, cwd: target.cwd ?? defaults.cwd },
    },
    context,
  );
}

export function conversations(session: Session, defaults: ConversationDefaults): Conversations {
  return {
    root: session.root,
    open: async (target): Promise<Conversation> => {
      switch (target.kind) {
        case "root":
          return session.root;
        case "existing": {
          const { id } = target;
          if (!isConversationKey(id)) {
            throw noConversation(id);
          }
          return resolveExisting(session, id);
        }
        case "new":
          return create(session, target, defaults);
      }
    },
    watch: (conversation) => watchEvents(session.harness, conversation.id, context),
    list: async (): Promise<ConversationPage> => {
      // One read, one page, no cursor kept: `next` means the page was cut, not "keep going".
      const page = await session.harness.commit(
        (tx) => tx.scanConversations({ order: "descending" }, LIST_PAGE),
        context,
      );
      return {
        // A task-owned conversation is refused at attach, so listing one would be noise.
        ids: page.items.filter((record) => record.owner === undefined).map((record) => record.id),
        truncated: page.next !== undefined,
      };
    },
  };
}
