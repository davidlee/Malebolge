// Helpers shared by the durable task kinds (SL-006 design § Components and
// boundaries): the scheduled satan-mcp connection, a best-effort notification
// over it, and a phase's failure reason, which rethrows at a close.

import type { ConversationId } from "@earendil-works/pi-durable";
import { messageOf } from "./message-of.ts";
import type { PoolKey } from "./satan-pool.ts";
import type { SatanTools } from "./satan-tools.ts";

/** How long each scheduled satan-mcp call (presence, percept, notify) may take. */
export const SATAN_CALL_DEADLINE_MS = 10_000;

/** Where a task's scheduled satan-mcp calls go: the conversation's own connection of that kind. */
export const scheduledKey = (conversation: ConversationId): PoolKey => ({
  conversation,
  kind: "scheduled",
});

/** A desktop notification, best effort: a notify that throws changes nothing. */
export const notifyBestEffort = async (
  satan: Pick<SatanTools, "call">,
  key: PoolKey,
  title: string,
  body: string,
): Promise<void> => {
  await satan
    .call(key, "notify_send", { title, body }, SATAN_CALL_DEADLINE_MS)
    .catch(() => undefined);
};

/** `work`'s failure as a reason, or rethrown when the invocation ended: a close is not a failure. */
export const reasonOf = (runtime: { readonly signal: AbortSignal }, error: unknown): string => {
  if (runtime.signal.aborted) {
    throw error;
  }
  return messageOf(error);
};
