// pi-durable's ids as the runner stores them. A `ConversationId` is a branded
// number with no public parser, and `jobs.conversation_id` is TEXT; so the
// runner writes the id's decimal text and recovers the branded value from
// pi's own records, never by assertion (PHASE-07 §0).

import type { ConversationId, Cursor, Session, SubmissionRecord } from "@earendil-works/pi-durable";
import { context } from "../context.ts";

/** Conversations read per scan page. */
const PAGE_SIZE = 64;

/** The text a job row holds for `id`. */
export const conversationText = (id: ConversationId): string => String(id);

/**
 * The branded id of the conversation whose text is `text`, read from pi's
 * records; `undefined` when none has it. Scans newest first (ids are
 * creation-ordered, and a job's conversation is recent): O(conversations).
 * Reads only through `tx`, writes nothing; never call it from inside a runner
 * store transaction (EVD-008: the database handle is shared).
 */
export function conversationIdOf(
  session: Pick<Session, "commit">,
  text: string,
): Promise<ConversationId | undefined> {
  return session.commit(async (tx) => {
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanConversations({ order: "descending" }, PAGE_SIZE, cursor);
      const found = page.items.find((record) => conversationText(record.id) === text);
      if (found !== undefined) {
        return found.id;
      }
      cursor = page.next;
    } while (cursor !== undefined);
    return undefined;
  }, context);
}

/**
 * The record of the submission admitted to `conversation` with `requestId`;
 * `undefined` when none was. Its `id` is the branded `SubmissionId`, so a
 * receipt's text id is never parsed. Read-only, never enables scheduling; the
 * same transaction rule as `conversationIdOf` (EVD-008).
 */
export function submissionRecordOf(
  session: Pick<Session, "commit">,
  conversation: ConversationId,
  requestId: string,
): Promise<SubmissionRecord | undefined> {
  return session.commit((tx) => tx.submissionByRequest(conversation, requestId), context);
}
