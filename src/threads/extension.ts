// The threads module's dependencies (SL-006 design § Components and boundaries),
// bound late in two steps as the wake's are: the extension is built before the
// session exists. PHASE-04 registered the satan.post task; PHASE-05 added the
// thread_post tool and the `threads` section its prompt carries; PHASE-07 adds
// thread_start and thread_fork.

import {
  defineExtension,
  type Extension,
  type Harness,
  section,
  type Task,
} from "@earendil-works/pi-durable";
import type { Profile } from "../config.ts";
import type { ConversationDefaults } from "../conversations.ts";
import { type LateBinding, lateBinding } from "../late-binding.ts";
import type { ModelCatalog } from "../models.ts";
import type { Log, SatanTools } from "../satan-tools.ts";
import { type PostInput, type PostResult, type PostState, postTask } from "./task.ts";
import { threadFork, threadPost, threadStart } from "./tools.ts";

export interface ThreadDeps {
  profile: Profile;
  /** Model and cwd a started thread takes; cwd and model yield to its topic's. */
  defaults: ConversationDefaults;
  /** The catalog a topic's stored model is judged against (design sec-4). */
  catalog: ModelCatalog;
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

/**
 * What the `threads` section tells the model (design § The `threads` section): the
 * post, post-failed and family-reaped envelopes' facts only, one line per paragraph.
 * Pinned by test; SATAN's conduct about peers is persona prose, not this.
 */
export const THREADS_SECTION =
  "A <post> comes from another of your own conversations, a peer thread, not from the operator. " +
  "Its from is the conversation that sent it; reply with thread_post to that id. " +
  "A fork's thread_fork result names the conversation it was forked from; its purpose arrives as its first post. " +
  "A thread answers you only by posting to you: what it says in its own turn stays in its own transcript. " +
  "When you want an answer, ask for a reply with thread_post, and do not forbid it tools.\n\n" +
  'A <post-failed> says a post of yours failed, and why. outcome="withdrawn": the recipient never read it. ' +
  'outcome="delivered-incomplete": the recipient read it but its turn did not complete; it may have acted on it.\n\n' +
  "A <family-reaped> says an activity was stopped for fan-out: too many posts at once from one starting input. " +
  "Its posts not yet read are withdrawn, and posts and thread starts from that activity are refused.";

/** The room's `threads` extension: the satan.post task, the thread tools and their section. */
export const threadsExtension = (
  deps: () => ThreadDeps,
  task: Task<PostInput, PostState, PostResult, object> = postTask(deps),
): Extension =>
  defineExtension({
    name: "threads",
    tasks: [task],
    tools: [threadPost(deps, task), threadStart(deps, task), threadFork(deps, task)],
    sections: [section("threads", () => THREADS_SECTION, { tag: true })],
  });
