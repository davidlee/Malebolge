// One conversation's context, and the two things built from it: the `SATAN_*`
// variables its tools run with, and the line, rendered as the `conversation`
// section of its system prompt (design sec-2, sec-5; DEC-018, DEC-019, DEC-021).
//
// The index stays `topics.ts`'s: this module reads it the one way, never
// writes, and maps the result purely — so a caller may build the mapping as
// often as it likes (an env per tool attempt) without a second source of truth.

import {
  type ConversationId,
  defineExtension,
  type Extension,
  section,
} from "@earendil-works/pi-durable";
import type { Profile } from "./config.ts";
import { type IndexEntry, type IndexReader, readIndex, storedEntry } from "./topics.ts";

/** A conversation as its tools and prompt see it: the id, and the entry when the index has one. */
export interface ConversationContext {
  id: ConversationId;
  entry?: IndexEntry;
}

/**
 * The one read of the index: `id`'s entry, or none when the index lacks it —
 * a task-owned conversation, which is no topic's (DEC-012).
 */
export async function contextOf(
  read: IndexReader,
  id: ConversationId,
): Promise<ConversationContext> {
  const entry = storedEntry(await readIndex(read), id);
  return entry === undefined ? { id } : { id, entry };
}

/**
 * The variables the conversation's tools run with. All six are set, empty when
 * the context has no value for one (DEC-021): pi-env drops an `undefined`
 * value, so a key left out would leave an inherited `SATAN_*` of that name in
 * place in the room — no key may be omitted, now or by a later conditional
 * spread (RV-012 F-1).
 */
export function conversationVars(
  profile: Profile,
  cwd: string,
  context: ConversationContext,
): Record<string, string> {
  const entry = context.entry;
  return {
    SATAN_HARNESS: "malebolge",
    SATAN_PROFILE: profile,
    SATAN_CONVERSATION: String(context.id),
    SATAN_CWD: cwd,
    SATAN_TOPIC: entry?.topic ?? "",
    SATAN_PARENT_CONVERSATION: entry?.parent === undefined ? "" : String(entry.parent),
  };
}

/** The prompt line: the conversation, and its topic when the index has one (DEC-019). */
export function conversationLine(context: ConversationContext): string {
  const line = `Conversation: ${String(context.id)}`;
  return context.entry === undefined ? line : `${line} (topic: ${context.entry.topic})`;
}

/**
 * The line as a system prompt section, untagged like `cwd`'s: the conversation
 * speaks for itself, so it needs no `<conversation>` wrapper.
 */
export const conversationExtension: Extension = defineExtension({
  name: "conversation",
  sections: [
    section(
      "conversation",
      async ({ read, conversationId }) => conversationLine(await contextOf(read, conversationId)),
      { tag: false },
    ),
  ],
});
