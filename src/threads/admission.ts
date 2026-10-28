// Admission's data (SL-006 design § The origin): the origin a post carries and
// how journals, tombstones and envelopes name it. The caller's-origin read and
// every refusal follow in later phases.

import type { ConversationId } from "@earendil-works/pi-durable";
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
