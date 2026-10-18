// Git, run as a subprocess (argument array, never a shell). `runGit` is the one
// exec path; the real-repo surface built on it, `RepoReader`, only reads (I3).

import { execFile } from "node:child_process";
import { RunnerError } from "./errors.ts";

export interface GitOutput {
  code: number;
  stdout: string;
}

/** Reads never take optional locks and never prompt. */
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };

/**
 * Runs `git args` in `cwd`. Resolves for exit 0 and for the exit codes in
 * `allow` (git's way of saying no); throws a plain Error when git could not
 * run or failed otherwise.
 */
export function runGit(
  cwd: string,
  args: readonly string[],
  allow: readonly number[] = [],
): Promise<GitOutput> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }, (error, stdout, stderr) => {
      const code = error === null ? 0 : error.code;
      if (code === 0 || (typeof code === "number" && allow.includes(code))) {
        resolve({ code, stdout });
        return;
      }
      const why =
        typeof code === "number" ? `exited ${String(code)}: ${stderr.trim()}` : error?.message;
      reject(new Error(`git ${args.join(" ")} in ${cwd}: ${String(why)}`, { cause: error }));
    });
  });
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

async function resolveBranch(repoPath: string, name: string): Promise<string | undefined> {
  const { code, stdout } = await runGit(
    repoPath,
    ["rev-parse", "--verify", "--quiet", `refs/heads/${name}^{commit}`],
    [1],
  );
  return code === 0 ? stdout.trim() : undefined;
}

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
