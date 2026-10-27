// The wake extension's dependencies (SL-034 design § Daemon wiring): bound late,
// in two steps, because the registry is built before satan-mcp's tools and before
// the session exist. Every member is read through a getter at use, never captured.

import type { Harness } from "@earendil-works/pi-durable";
import type { Conversations } from "../conversations.ts";
import type { Log, SatanTools } from "../satan-tools.ts";
import type { WakePolicy, WakeSettings } from "./policy.ts";

export interface WakeDeps {
  settings: WakeSettings;
  policy: WakePolicy;
  /** The harness clock: the same function the session's `now` is. */
  now(): number;
  /** Uniform in [0, 1). */
  random(): number;
  satan: Pick<SatanTools, "call" | "refresh">;
  /** `wake.md`, read per fire; throws when it is missing. */
  fragment(): string;
  log: Log;
  harness: Pick<Harness, "inspect" | "abortTask" | "abortSubmission">;
  conversations: Pick<Conversations, "setTopic" | "open">;
}
