// The thread_post tool (SL-006 design § The thread tools): one call admits the
// target and creates the post's satan.post task in a single commit, so a crash
// before it leaves nothing. It is sequential (DEC-041) so a round's earlier thread
// call's task is counted by the next, and replay `unsafe`: pi-durable never reruns
// an interrupted call (DEC-043). The caps are stated, not enforced, until PHASE-06.

import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type Task,
  type TaskId,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { isConversationKey } from "../conversations.ts";
import { answer, refusal } from "../tool-results.ts";
import { admitPost, FAMILY_CAP, GLOBAL_CAP, type Origin, originKey, Refusal } from "./admission.ts";
import type { ThreadDeps } from "./extension.ts";
import { createPostTask, type PostInput, type PostResult, type PostState } from "./task.ts";

type PostTask = Task<PostInput, PostState, PostResult, object>;

/** What one admitted call's commit returns: the post, and the origin it carries. */
interface Created {
  post: TaskId<PostResult>;
  origin: Origin;
}

const postParameters = Type.Object({
  to: Type.Number({ description: "The conversation to post to" }),
  intent: Type.String({ description: "Why you post, about a sentence" }),
  context: Type.Optional(
    Type.String({ description: "Optional material that helps the recipient" }),
  ),
});

export const threadPost = (
  deps: () => ThreadDeps,
  task: PostTask,
): ToolRegistration<typeof postParameters> =>
  defineTool({
    name: "thread_post",
    description:
      "Post to another conversation by id; it starts or queues a turn there. " +
      "Reply to a post by posting to its from. " +
      `At most ${String(FAMILY_CAP)} active posts per activity and ${String(GLOBAL_CAP)} in all; ` +
      "crossing a cap stops the activity. Returns the post id.",
    parameters: postParameters,
    executionMode: "sequential",
    replay: "unsafe",
    execute: async (args, api, ctx) => {
      const { profile } = deps();
      const caller = api.conversationId;
      if (!isConversationKey(args.to)) {
        return refusal(`no conversation ${String(args.to)}`);
      }
      const to = args.to;
      let created: Created;
      try {
        created = await api.commit(async (tx) => {
          const admitted = await admitPost(tx, profile, caller, to);
          const post = await createPostTask(tx, task, {
            letter: "post",
            to,
            from: caller,
            topic: admitted.topic,
            origin: admitted.origin,
            intent: args.intent,
            ...(args.context === undefined ? {} : { context: args.context }),
          });
          return { post, origin: admitted.origin };
        }, ctx);
      } catch (error) {
        if (error instanceof Refusal) {
          return refusal(error.message);
        }
        throw error;
      }
      const { post, origin } = created;
      deps().log(
        `post ${String(post)} ${String(caller)}->${String(to)} origin ${originKey(origin)}`,
      );
      return answer({ post, to });
    },
  });
