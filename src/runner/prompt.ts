// Prompt composition (design §5.2, DEC-056): a pure function of (corpus
// prompt text, resolved policy, job). The job block is ported from the elisp
// `satan-patch-prompt-build-directive`, minus `## Checks` (the runner runs
// none, DEC-059) and `Branch:` (now the base and job branches).

import type { JsonRecord } from "../json.ts";
import type { ResolvedPolicy } from "./policy.ts";

/** The job fields the prompt shows. */
export interface PromptJob {
  id: string;
  mode: string;
  directive: string;
  allowedPaths: readonly string[];
  baseRef: string;
  context: JsonRecord;
  source: JsonRecord;
}

const scalar = (value: unknown): string | undefined =>
  typeof value === "string" || typeof value === "number" ? String(value) : undefined;

function prefixed(prefix: string, text: string | undefined): string | undefined {
  return text === undefined ? undefined : prefix + text;
}

type ContextRenderer = (value: unknown) => string | undefined;

/** Known context keys, in render order; any other key is dropped. */
const CONTEXT_RENDERERS: readonly (readonly [string, ContextRenderer])[] = [
  ["note_context", (value): string | undefined => prefixed("note context:\n", scalar(value))],
  [
    "memory_matches",
    (value): string | undefined =>
      Array.isArray(value) ? `memory matches: ${String(value.length)}` : undefined,
  ],
  ["proposal_id", (value): string | undefined => prefixed("proposal: ", scalar(value))],
  ["mode_run_id", (value): string | undefined => prefixed("mode run: ", scalar(value))],
  [
    "source",
    (value): string | undefined =>
      value === undefined ? undefined : `source: ${JSON.stringify(value)}`,
  ],
];

function renderContext(context: JsonRecord): string[] {
  const parts = CONTEXT_RENDERERS.map(([key, render]) => render(context[key])).filter(
    (part) => part !== undefined,
  );
  return parts.length === 0 ? [] : ["", "## Context", "", parts.join("\n\n")];
}

/** The commit footer's `Source:` value. */
function renderSource(source: JsonRecord): string {
  const kind = scalar(source["kind"]);
  if (kind === undefined) {
    return Object.keys(source).length === 0 ? "none" : JSON.stringify(source);
  }
  const file = scalar(source["file"]);
  const line = scalar(source["line"]);
  if (file !== undefined && line !== undefined) {
    return `${kind} ${file}:${line}`;
  }
  return file ?? kind;
}

function jobBlock(job: PromptJob): string {
  const branch = `job/${job.id}`;
  return [
    `# patch-agent job ${job.id}`,
    `Mode: ${job.mode}`,
    `Base branch: ${job.baseRef}`,
    `Job branch: ${branch}`,
    "",
    "## Directive",
    "",
    job.directive,
    "",
    "## Allowed paths",
    "",
    ...job.allowedPaths.map((path) => `- ${path}`),
    ...renderContext(job.context),
    "",
    "## Conventions",
    "",
    `- Commit your work on \`${branch}\` as you go. Uncommitted work never leaves the room.`,
    "- Write notes on what you did and what remains, and commit them with the work,",
    "  so a job stopped early still explains itself.",
    "",
    "## Commit footer",
    "",
    "When you commit, use this exact footer (after a blank line):",
    "",
    `    Patch-agent job: ${job.id}`,
    `    Source: ${renderSource(job.source)}`,
    "",
    `Subject line format: \`<mode>: <short imperative summary>\`, with mode=${job.mode}.`,
  ].join("\n");
}

/** The job's prompt: corpus text, then the policy's fragments, then the job block. */
export function composePrompt(promptText: string, policy: ResolvedPolicy, job: PromptJob): string {
  return [promptText.trimEnd(), ...policy.promptFragments, jobBlock(job)].join("\n\n");
}
