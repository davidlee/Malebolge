// The wake extension's dependencies (SL-034 design § Daemon wiring): bound late, in
// two steps, because the registry is built before satan-mcp's tools and before the
// session exists; see late-binding.ts.

import {
  defineExtension,
  type Extension,
  type Harness,
  type Task,
} from "@earendil-works/pi-durable";
import type { Profile } from "../config.ts";
import type { Conversations } from "../conversations.ts";
import { type LateBinding, lateBinding } from "../late-binding.ts";
import type { Log, SatanTools } from "../satan-tools.ts";
import type { WakePolicy, WakeSettings } from "./policy.ts";
import { type WakeInput, type WakeResult, type WakeState, wakeTask } from "./task.ts";
import { wakeCancel, wakeList, wakeSchedule } from "./tools.ts";

export interface WakeDeps {
  /** The daemon's execution profile: the reach check reads its talk sets (design sec-6). */
  profile: Profile;
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

/** What `startDaemon` binds before it serves: everything but the session's own parts. */
export type EarlyWakeDeps = Omit<WakeDeps, "harness" | "conversations">;

/** What `startDaemon` binds in `beforeResume`, from the one session. */
export type LateWakeDeps = Pick<WakeDeps, "harness" | "conversations">;

/** The getter the extension reads, and its two binding steps; reading before both throws. */
export type WakeBinding = LateBinding<EarlyWakeDeps, LateWakeDeps>;

export const wakeBinding = (): WakeBinding => lateBinding("wake");

/** The room's `tasks` extension: satan.wake and the three tools SATAN schedules it with. */
export const tasksExtension = (
  deps: () => WakeDeps,
  task: Task<WakeInput, WakeState, WakeResult, object> = wakeTask(deps),
): Extension =>
  defineExtension({
    name: "tasks",
    tasks: [task],
    tools: [wakeSchedule(deps, task), wakeCancel(deps), wakeList(deps)],
  });
