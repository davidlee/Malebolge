// Git, run as a subprocess (argument array, never a shell). `runGit` is the one
// exec path; the real-repo surface built on it, `RepoReader`, only reads (I3),
// and so does `QuarantineReader`, over the repo collected work lands in.

import { messageOf, RunnerError } from "./errors.ts";
import { runProgram } from "./exec.ts";

export interface GitOutput {
  code: number;
  stdout: string;
}

/** Reads never take optional locks and never prompt. */
const GIT_ENV = { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };

/**
 * Runs `git args` in `cwd`. Resolves for exit 0 and for the exit codes in
 * `allow` (git's way of saying no); throws a plain Error when git could not
 * run or failed otherwise.
 */
export async function runGit(
  cwd: string,
  args: readonly string[],
  allow: readonly number[] = [],
): Promise<GitOutput> {
  const where = `git ${args.join(" ")} in ${cwd}`;
  let output;
  try {
    output = await runProgram("git", args, { cwd, env: GIT_ENV });
  } catch (error) {
    throw new Error(`${where}: ${messageOf(error)}`, {
      cause: error,
    });
  }
  const { code, stdout, stderr } = output;
  if (code !== 0 && !allow.includes(code)) {
    throw new Error(`${where}: exited ${String(code)}: ${stderr.trim()}`);
  }
  return { code, stdout };
}

/** The commit `ref` names in `repoPath`; `undefined` when there is none. */
export async function resolveCommit(repoPath: string, ref: string): Promise<string | undefined> {
  const { code, stdout } = await runGit(
    repoPath,
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    [1],
  );
  return code === 0 ? stdout.trim() : undefined;
}

/** Read-only questions about a real repo. */
export interface RepoReader {
  /** `name` as git normalises a branch name; `base_ref_invalid` if it is not one. */
  checkBranchName: (repoPath: string, name: string) => Promise<string>;
  /** The commit `refs/heads/<name>` points at; `undefined` when there is no such branch. */
  resolveBranch: (repoPath: string, name: string) => Promise<string | undefined>;
}

async function checkBranchName(repoPath: string, name: string): Promise<string> {
  const { code, stdout } = await runGit(repoPath, ["check-ref-format", "--branch", name], [128]);
  if (code !== 0) {
    throw new RunnerError("base_ref_invalid", `${JSON.stringify(name)} is not a valid branch name`);
  }
  return stdout.trim();
}

const resolveBranch = (repoPath: string, name: string): Promise<string | undefined> =>
  resolveCommit(repoPath, `refs/heads/${name}`);

export const gitRepoReader: RepoReader = { checkBranchName, resolveBranch };

/** A config repo entry, by name and real path. */
export interface RepoRef {
  name: string;
  path: string;
}

/**
 * `ref` as a branch that exists in `repo`: `HEAD`, tags and oids are refused
 * (`base_ref_invalid`). Returns the normalised name.
 */
export async function checkBaseRef(
  reader: RepoReader,
  repo: RepoRef,
  ref: string,
): Promise<string> {
  const branch = await reader.checkBranchName(repo.path, ref);
  if ((await reader.resolveBranch(repo.path, branch)) === undefined) {
    throw new RunnerError(
      "base_ref_invalid",
      `baseRef ${JSON.stringify(ref)} is not a branch of repo ${repo.name}`,
    );
  }
  return branch;
}

// --- the quarantine ------------------------------------------------------------
// Not the real repo: the bare repo collected work is fetched into, which the
// agent's history reaches only through the channel. Read here, never written.

export interface CommitInfo {
  oid: string;
  subject: string;
}

export interface Diffstat {
  files: number;
  insertions: number;
  deletions: number;
}

/** What collection needs to know of `base..reviewed` (design §5.4 steps 3-4). */
export interface QuarantineFacts {
  /** `reviewed` descends from `base`. */
  ancestryOk: boolean;
  /** Every path any commit in the range touched, merges included, first seen first. */
  changedPaths: string[];
  /** Oldest first. */
  commits: CommitInfo[];
  /** `base` against `reviewed`. */
  diffstat: Diffstat;
}

/** Read-only questions about the quarantine. */
export interface QuarantineReader {
  inspect: (quarantine: string, baseOid: string, reviewedOid: string) => Promise<QuarantineFacts>;
}

const NO_DIFF: Diffstat = { files: 0, insertions: 0, deletions: 0 };

const nulFields = (stdout: string): string[] => stdout.split("\0").filter((field) => field !== "");

/**
 * Whether `reviewed` descends from `base`. A `base` absent from the
 * quarantine fails: had `reviewed` descended from it, the fetch would have
 * brought it.
 */
async function descends(quarantine: string, base: string, reviewed: string): Promise<boolean> {
  if ((await resolveCommit(quarantine, base)) === undefined) {
    return false;
  }
  const { code } = await runGit(quarantine, ["merge-base", "--is-ancestor", base, reviewed], [1]);
  return code === 0;
}

/**
 * Each path touched in `range`, oldest commit first, deduplicated. `-m` gives a merge its paths
 * against each parent (without it a merge lists none); `--no-renames` lists
 * both sides of a rename; `-z` keeps paths raw (never quoted).
 */
async function changedPaths(quarantine: string, range: string): Promise<string[]> {
  const { stdout } = await runGit(quarantine, [
    "log",
    "-z",
    "--reverse",
    "--name-only",
    "--format=",
    "-m",
    "--no-renames",
    range,
  ]);
  return [...new Set(nulFields(stdout))];
}

async function commitsIn(quarantine: string, range: string): Promise<CommitInfo[]> {
  const { stdout } = await runGit(quarantine, ["log", "-z", "--reverse", "--format=%H %s", range]);
  return nulFields(stdout).map((line) => {
    const space = line.indexOf(" ");
    return { oid: line.slice(0, space), subject: line.slice(space + 1) };
  });
}

/** A `--shortstat` count, 0 when git leaves that part out. */
const countOf = (stat: string, noun: RegExp): number => Number(noun.exec(stat)?.[1] ?? 0);

async function diffstat(quarantine: string, base: string, reviewed: string): Promise<Diffstat> {
  const { stdout } = await runGit(quarantine, ["diff", "--shortstat", base, reviewed]);
  return {
    files: countOf(stdout, /(\d+) files? changed/),
    insertions: countOf(stdout, /(\d+) insertions?\(\+\)/),
    deletions: countOf(stdout, /(\d+) deletions?\(-\)/),
  };
}

async function inspect(
  quarantine: string,
  baseOid: string,
  reviewedOid: string,
): Promise<QuarantineFacts> {
  if (!(await descends(quarantine, baseOid, reviewedOid))) {
    return { ancestryOk: false, changedPaths: [], commits: [], diffstat: NO_DIFF };
  }
  const range = `${baseOid}..${reviewedOid}`;
  return {
    ancestryOk: true,
    changedPaths: await changedPaths(quarantine, range),
    commits: await commitsIn(quarantine, range),
    diffstat: await diffstat(quarantine, baseOid, reviewedOid),
  };
}

export const gitQuarantineReader: QuarantineReader = { inspect };
