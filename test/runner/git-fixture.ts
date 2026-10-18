// Throwaway git repos for tests: real git, isolated from the user's git
// config (signing, hooks, default branch), removed when the test finishes.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { onTestFinished } from "vitest";

/** The environment every fixture git runs in. */
export const ISOLATED_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_AUTHOR_DATE: "2026-10-18T00:00:00Z",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_COMMITTER_DATE: "2026-10-18T00:00:00Z",
};

/** An empty directory, removed when the test finishes. */
export function tempDir(prefix = "mb-tmp-"): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => {
    rmSync(path, { recursive: true, force: true });
  });
  return path;
}

/** Runs git in `path` with the isolated config; its trimmed stdout. */
export function gitIn(path: string): (...args: string[]) => string {
  return (...args) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], {
      cwd: path,
      env: ISOLATED_ENV,
      encoding: "utf8",
    }).trim();
}

export interface BareRepo {
  path: string;
  /** Runs git in the repo; its trimmed stdout. */
  git: (...args: string[]) => string;
}

export interface TestRepo extends BareRepo {
  /** A commit on the current branch adding `file` (parent directories made); its oid. */
  commit: (file: string) => string;
  /** Every ref and its oid, HEAD, and the worktree status: unchanged means nothing wrote. */
  snapshot: () => string;
}

/** An empty bare repo. */
export function tempBareRepo(): BareRepo {
  const path = tempDir("mb-bare-");
  const git = gitIn(path);
  git("init", "--quiet", "--bare");
  return { path, git };
}

/** The test surface over the working repo at `path`. */
function workingRepo(path: string): TestRepo {
  const git = gitIn(path);
  const commit = (file: string): string => {
    const target = join(path, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${file}\n`);
    git("add", "--", file);
    git("commit", "--quiet", "--no-verify", "-m", `add ${file}`);
    return git("rev-parse", "HEAD");
  };
  const snapshot = (): string =>
    [
      git("for-each-ref", "--format=%(refname) %(objectname)"),
      git("symbolic-ref", "HEAD"),
      git("status", "--porcelain", "--untracked-files=all"),
    ].join("\n");
  return { path, git, commit, snapshot };
}

/** A repo on branch `main` holding one commit. */
export function tempRepo(): TestRepo {
  const path = tempDir("mb-repo-");
  gitIn(path)("init", "--quiet", "-b", "main");
  const repo = workingRepo(path);
  repo.commit("README");
  return repo;
}

/** A working clone of `source`, on its default branch. */
export function tempClone(source: string): TestRepo {
  const path = tempDir("mb-clone-");
  gitIn(path)("clone", "--quiet", source, ".");
  return workingRepo(path);
}
