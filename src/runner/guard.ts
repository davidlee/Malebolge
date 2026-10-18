// The guard (design §5.2, DEC-060): an early check that blocks `write` and
// `edit` outside the job's allowlist before they run, audited `blocked_tool`.
// It is a courtesy to the model, not the boundary: `bash` and `read` pass,
// and collection's classification stays the authority over what a job changed.
// `beforeTool` runs outside pi's storage transactions (pi-durable's tool task
// calls it before its intent commit), so the audit write may use the shared
// database handle (EVD-008).
//
// It is also the room-down pause's trigger (design §5.4, DEC-055). Both hooks
// read the job's durable `pause_requested`, never a result's text, outside
// any pi transaction. `afterTool` (after execution, before the result is
// committed) replaces the result; `afterTools` (the round's results
// committed, before the next model request is handed over) signals the run,
// which aborts the conversation. Signalled from `afterTool`, the run's abort
// would land before the replaced result commits and discard it (PHASE-09
// STOP-1); a request racing the abort is the model gate's to refuse.

import { posix } from "node:path";
import {
  defineExtension,
  type EntryId,
  type Extension,
  GenerationTask,
  type HookApi,
  hook,
  type ToolExecutionResult,
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
  /** Told that a tool round ended with the job's pause marked: wakes the run, which aborts. */
  paused: () => void;
}

export interface GuardDeps {
  /** The job whose conversation's id text is `conversationId`; undefined for any other. */
  currentJob: (conversationId: string) => GuardedJob | undefined | Promise<GuardedJob | undefined>;
  jobs: Pick<JobStore, "appendEvent" | "get">;
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

/** What the model sees of a call made as the room went down: fixed text, nothing of the failure. */
export const PAUSED_RESULT_TEXT = "environment unavailable; paused";

const PAUSED_RESULT: ToolExecutionResult = {
  isError: true,
  output: [{ type: "text", text: PAUSED_RESULT_TEXT }],
};

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

  /** The conversation's job, if its pause is marked: read from its row, never from a result. */
  async function pausedJob(api: HookApi): Promise<GuardedJob | undefined> {
    const job = await deps.currentJob(conversationText(api.conversationId));
    const marked = job !== undefined && (await deps.jobs.get(job.id))?.pauseRequested === true;
    return marked ? job : undefined;
  }

  async function afterTool(
    _call: ToolHookCall,
    _result: ToolExecutionResult,
    api: HookApi,
  ): Promise<ToolExecutionResult | undefined> {
    return (await pausedJob(api)) === undefined ? undefined : PAUSED_RESULT;
  }

  async function afterTools(
    _assistant: EntryId,
    _results: readonly EntryId[],
    api: HookApi,
  ): Promise<void> {
    (await pausedJob(api))?.paused();
  }

  return defineExtension({
    name: "job-guard",
    hooks: [hook(ToolTask, { beforeTool, afterTool }), hook(GenerationTask, { afterTools })],
  });
}
