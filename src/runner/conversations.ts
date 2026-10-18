// A job's pi-durable conversation (design §5.4 "Submit to review"): created
// ownerless, its id recorded as `jobs.conversation_id` text, and reopened
// from that text. Submit and the scheduler share `ensureConversation`, so a
// job is given its conversation one way whoever gets there first.

import type { Conversation, Harness, Session } from "@earendil-works/pi-durable";
import { context } from "../context.ts";
import { conversationIdOf, conversationText } from "./durable-ids.ts";
import type { Job, JobStore } from "./store.ts";

/** Creates a job's conversation; its id as row text. */
export interface Conversations {
  create: () => Promise<string>;
}

/** Ownerless conversations on `harness`. Creating one schedules nothing (I14). */
export function harnessConversations(harness: Pick<Harness, "createConversation">): Conversations {
  return {
    create: async () =>
      conversationText(
        (await harness.createConversation({ ownership: { kind: "ownerless" } }, context)).id,
      ),
  };
}

/**
 * `job` with its conversation: created and recorded, audited `conversation`,
 * when the row has none. The record is first-wins: a caller that lost a race
 * gets the recorded one (its own stays unused, ownerless and empty).
 */
export async function ensureConversation(
  jobs: JobStore,
  conversations: Conversations,
  job: Job,
  now: number,
): Promise<Job> {
  if (job.conversationId !== undefined) {
    return job;
  }
  const conversationId = await conversations.create();
  return jobs.change(job.id, now, (current) =>
    current.conversationId === undefined
      ? { update: { conversationId }, event: { kind: "conversation", payload: { conversationId } } }
      : undefined,
  );
}

/**
 * The conversation whose id text is `text`; undefined when pi has none. Never
 * call from inside a runner store transaction (EVD-008).
 */
export async function jobConversation(
  harness: Pick<Harness, "conversation"> & Pick<Session, "commit">,
  text: string,
): Promise<Conversation | undefined> {
  const id = await conversationIdOf(harness, text);
  return id === undefined ? undefined : harness.conversation(id, context);
}
