// The guard (design §5.2, DEC-060): an early check that blocks `write` and
// `edit` outside the job's allowlist before they run, audited `blocked_tool`.
// It is a courtesy to the model, not the boundary: `bash` and `read` pass,
// and collection's classification stays the authority over what a job changed.
// `beforeTool` runs outside pi's storage transactions (pi-durable's tool task
// calls it before its intent commit), so the audit write may use the shared
// database handle (EVD-008).

import { posix } from "node:path";
import {
  defineExtension,
  type Extension,
  type HookApi,
  hook,
  type ToolHookCall,
  ToolTask,
} from "@earendil-works/pi-durable";
import { pathAllowed } from "./classify.ts";
import { conversationText } from "./durable-ids.ts";
import type { Job, JobStore } from "./store.ts";

/** What the guard needs of the job a conversation runs. */
export interface GuardedJob extends Pick<Job, "id" | "allowedPaths"> {
  /** The repo's clone in the room: the conversation's cwd. */
  root: string;
}

export interface GuardDeps {
  /** The job whose conversation's id text is `conversationId`; undefined for any other. */
  currentJob: (conversationId: string) => GuardedJob | undefined | Promise<GuardedJob | undefined>;
  jobs: Pick<JobStore, "appendEvent">;
  now: () => number;
}

/** The tools whose `path` argument names the one file they change. */
const GUARDED: ReadonlySet<string> = new Set(["write", "edit"]);

// pi-durable's tools rewrite a path argument before resolving it
// (tools/path-utils.js `normalizeToolPath`): unicode spaces become spaces and
// one leading `@` goes.
const UNICODE_SPACES = /[  -   　]/g;

const asToolResolves = (argument: string): string => {
  const spaced = argument.replace(UNICODE_SPACES, " ");
  return spaced.startsWith("@") ? spaced.slice(1) : spaced;
};

/**
 * The repo-relative path a tool's `path` argument names, resolved against
 * `root` as the environment would; `../…` when it lands outside the repo.
 * `undefined` for a home-relative or `file:` path, whose target the guard
 * cannot know.
 */
export function repoPath(argument: string, root: string): string | undefined {
  const path = asToolResolves(argument);
  if (path === "~" || path.startsWith("~/") || path.startsWith("file:")) {
    return undefined;
  }
  return posix.relative(root, posix.resolve(root, path));
}

interface Refusal {
  block: string;
}

const refuse = (block: string): Refusal => ({ block });

/** The guard as an extension; select it with the job's tools. */
export function jobGuard(deps: GuardDeps): Extension {
  async function beforeTool(call: ToolHookCall, api: HookApi): Promise<Refusal | undefined> {
    if (!GUARDED.has(call.name)) {
      return undefined;
    }
    const job = await deps.currentJob(conversationText(api.conversationId));
    if (job === undefined) {
      return refuse(`${call.name} is refused: no job owns this conversation`);
    }
    const argument = call.arguments["path"];
    const path = typeof argument === "string" ? repoPath(argument, job.root) : undefined;
    if (path !== undefined && pathAllowed(path, job.allowedPaths)) {
      return undefined;
    }
    const payload = {
      tool: call.name,
      path: argument,
      ...(path === undefined ? {} : { repoPath: path }),
    };
    await deps.jobs.appendEvent(job.id, deps.now(), "blocked_tool", payload);
    return refuse(
      `${call.name} to ${JSON.stringify(argument)} is outside this job's allowed paths ` +
        `(${job.allowedPaths.join(", ")}); change only files under them`,
    );
  }

  return defineExtension({ name: "job-guard", hooks: [hook(ToolTask, { beforeTool })] });
}
