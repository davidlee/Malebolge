// The origin a post carries (SL-006 design § The origin): the input that opened a
// cascade, how journals, tombstones and envelopes name it, and its data check.
// Pure data, so admission, the post task and the tombstones share it without a cycle.

import type { ConversationId } from "@earendil-works/pi-durable";
import { isRecord } from "../json.ts";
import type { EpisodeClass } from "../wake/task.ts";

export interface Origin {
  /** The conversation whose input opened the cascade. */
  conversation: ConversationId;
  /** That input's entry. pi-durable mints entry ids from one store-wide sequence, so a higher id is younger. */
  entry: number;
  kind: "human" | "wake";
  /** A wake origin's episode class; absent for a human origin. Recorded only (DEC-036 addendum). */
  episodeClass?: EpisodeClass;
}

/** How journals, tombstones and envelopes name an origin: "12/340". */
export const originKey = (origin: Origin): string =>
  `${String(origin.conversation)}/${String(origin.entry)}`;

/** A positive safe integer as pi-durable's branded conversation id (there is no public parser). */
const isConversationId = (value: unknown): value is ConversationId =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** A wake episode class, as its entry's data carries it. */
export const isEpisodeClass = (value: unknown): value is EpisodeClass =>
  value === "attend" || value === "seclude";

/** Whether `value` reads as an origin: a wake origin carries its episode class. */
export const isOrigin = (value: unknown): value is Origin => {
  if (!isRecord(value)) {
    return false;
  }
  const kind = value["kind"];
  return (
    isConversationId(value["conversation"]) &&
    typeof value["entry"] === "number" &&
    (kind === "human" || (kind === "wake" && isEpisodeClass(value["episodeClass"])))
  );
};
