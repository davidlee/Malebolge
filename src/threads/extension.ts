// The threads module's dependencies (SL-006 design § Components and boundaries),
// bound late in two steps as the wake's are: the extension is built before the
// session exists. PHASE-04 registers the satan.post task only; tools and the
// prompt section follow in PHASE-05.

import {
  defineExtension,
  type Extension,
  type Harness,
  type Task,
} from "@earendil-works/pi-durable";
import type { Profile } from "../config.ts";
import type { ConversationDefaults } from "../conversations.ts";
import { type LateBinding, lateBinding } from "../late-binding.ts";
import type { Log, SatanTools } from "../satan-tools.ts";
import { type PostInput, type PostResult, type PostState, postTask } from "./task.ts";

export interface ThreadDeps {
  profile: Profile;
  /** Model and cwd a started thread takes; cwd yields to its topic's. */
  defaults: ConversationDefaults;
  now(): number;
  log: Log;
  satan: Pick<SatanTools, "call">;
  harness: Pick<Harness, "inspect" | "abortSubmission">;
}

/** What `startDaemon` binds before it serves: everything but the session's own parts. */
export type EarlyThreadDeps = Omit<ThreadDeps, "harness">;

/** What `startDaemon` binds in `beforeResume`, from the one session. */
export type LateThreadDeps = Pick<ThreadDeps, "harness">;

/** The getter the extension reads, and its two binding steps; reading before both throws. */
export type ThreadBinding = LateBinding<EarlyThreadDeps, LateThreadDeps>;

export const threadBinding = (): ThreadBinding => lateBinding("threads");

/** The room's `threads` extension: the satan.post task, and nothing else yet. */
export const threadsExtension = (
  deps: () => ThreadDeps,
  task: Task<PostInput, PostState, PostResult, object> = postTask(deps),
): Extension =>
  defineExtension({
    name: "threads",
    tasks: [task],
  });
