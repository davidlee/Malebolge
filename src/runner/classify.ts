// The authoritative allowlist and outcome classification (design §5.4, DEC-060).
// Pure: the git layer collects the facts, this decides what they mean.

import type { EndReason, JobClass, JobState } from "./vocab.ts";

const stripDotSlash = (path: string): string => (path.startsWith("./") ? path.slice(2) : path);

const segments = (path: string): string[] => path.split("/");

/** A path that cannot name a file inside the repo. */
const escapesRepo = (path: string): boolean =>
  path.startsWith("/") || segments(path).includes("..");

/**
 * A submitted allowlist entry in canonical form: one leading `./` stripped.
 * Throws on an entry that is empty, absolute, climbs with `..`, or carries
 * surrounding whitespace (never trimmed: a git path may contain it).
 */
export function normaliseAllowedEntry(entry: string): string {
  if (entry !== entry.trim()) {
    throw new Error(`allowed path ${JSON.stringify(entry)} has surrounding whitespace`);
  }
  const normal = stripDotSlash(entry);
  if (normal === "") {
    throw new Error("allowed path is empty");
  }
  if (escapesRepo(normal)) {
    throw new Error(`allowed path ${JSON.stringify(entry)} is absolute or contains ..`);
  }
  return normal;
}

function entryMatches(path: string, entry: string): boolean {
  const normal = stripDotSlash(entry);
  if (normal === "") {
    return false;
  }
  return normal.endsWith("/") ? path.startsWith(normal) : path === normal;
}

/**
 * Whether `path` is covered by `allowed`: an entry ending `/` is a prefix,
 * any other an exact file; no globs. A path that is empty, absolute or
 * climbs with `..` is never allowed.
 */
export function pathAllowed(path: string, allowed: readonly string[]): boolean {
  const normal = stripDotSlash(path);
  if (normal === "" || escapesRepo(normal)) {
    return false;
  }
  return allowed.some((entry) => entryMatches(normal, entry));
}

/** The members of `changed` that `allowed` does not cover, in input order. */
export const disallowedPaths = (changed: readonly string[], allowed: readonly string[]): string[] =>
  changed.filter((path) => !pathAllowed(path, allowed));

export interface ClassifyInput {
  endReason: EndReason;
  /** What collection found across `base_oid..reviewed_oid`, or that it failed. */
  collection:
    | { ok: true; ancestryOk: boolean; changedPaths: readonly string[]; commitCount: number }
    | { ok: false };
  allowedPaths: readonly string[];
}

export interface Classification {
  class: JobClass;
  state: Extract<JobState, "needs_review" | "failed" | "cancelled">;
  /** Needs review, but the agent did not finish: say so to the reviewer. */
  flagged: boolean;
  /** Changed paths outside the allowlist. */
  offending: string[];
}

/**
 * Class of a collected, in-bounds job by how execution ended. A cancelled job
 * is `partial` here: its state is `cancelled` regardless, and the class only
 * records what it left behind.
 */
const END_REASON_CLASS: Record<EndReason, JobClass> = {
  completed: "complete",
  ceiling_exceeded: "partial",
  usage_unavailable: "partial",
  room_unavailable: "partial",
  cancelled: "partial",
  error: "error",
};

function classOf(input: ClassifyInput): { class: JobClass; offending: string[] } {
  const { collection } = input;
  if (!collection.ok) {
    return { class: "error", offending: [] };
  }
  const offending = disallowedPaths(collection.changedPaths, input.allowedPaths);
  if (!collection.ancestryOk || offending.length > 0) {
    return { class: "path_violation", offending };
  }
  if (collection.commitCount === 0) {
    return { class: "no_changes", offending };
  }
  return { class: END_REASON_CLASS[input.endReason], offending };
}

/** The class and next state of a job whose execution has ended and been collected. */
export function classify(input: ClassifyInput): Classification {
  const { class: jobClass, offending } = classOf(input);
  const reviewable = jobClass === "complete" || jobClass === "partial";
  if (input.endReason === "cancelled") {
    return { class: jobClass, state: "cancelled", flagged: false, offending };
  }
  return {
    class: jobClass,
    state: reviewable ? "needs_review" : "failed",
    flagged: jobClass === "partial",
    offending,
  };
}
