// Throwaway git repos for tests: real git, isolated from the user's git
// config (signing, hooks, default branch), removed when the test finishes.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";

const ISOLATED_ENV = {
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

export interface TestRepo {
  path: string;
  /** Runs git in the repo; its trimmed stdout. */
  git: (...args: string[]) => string;
  /** A commit on the current branch adding `file`; its oid. */
  commit: (file: string) => string;
  /** Every ref and its oid, HEAD, and the worktree status: unchanged means nothing wrote. */
  snapshot: () => string;
}

/** A repo on branch `main` holding one commit. */
export function tempRepo(): TestRepo {
  const path = mkdtempSync(join(tmpdir(), "mb-repo-"));
  onTestFinished(() => {
    rmSync(path, { recursive: true, force: true });
  });
  const git = (...args: string[]): string =>
    execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], {
      cwd: path,
      env: ISOLATED_ENV,
      encoding: "utf8",
    }).trim();
  const commit = (file: string): string => {
    writeFileSync(join(path, file), `${file}\n`);
    git("add", file);
    git("commit", "--quiet", "--no-verify", "-m", `add ${file}`);
    return git("rev-parse", "HEAD");
  };
  git("init", "--quiet", "-b", "main");
  commit("README");
  const snapshot = (): string =>
    [
      git("for-each-ref", "--format=%(refname) %(objectname)"),
      git("symbolic-ref", "HEAD"),
      git("status", "--porcelain", "--untracked-files=all"),
    ].join("\n");
  return { path, git, commit, snapshot };
}
