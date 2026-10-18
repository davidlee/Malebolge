import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { checkBaseRef, gitRepoReader, runGit } from "../../src/runner/git.ts";
import { tempRepo } from "./git-fixture.ts";
import { rejectionCode } from "./refusal-fixture.ts";

const { checkBranchName, resolveBranch } = gitRepoReader;

function emptyDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mb-empty-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

describe("runGit", () => {
  it("returns stdout and the exit code for success and allowed refusals", async () => {
    const repo = tempRepo();
    expect(await runGit(repo.path, ["symbolic-ref", "HEAD"])).toEqual({
      code: 0,
      stdout: "refs/heads/main\n",
    });
    const missing = await runGit(
      repo.path,
      ["show-ref", "--verify", "--quiet", "refs/heads/x"],
      [1],
    );
    expect(missing.code).toBe(1);
  });

  it("throws a plain Error, not a refusal, when git cannot do the work", async () => {
    const notARepo = emptyDir();
    await expect(runGit(notARepo, ["rev-parse", "HEAD"])).rejects.toThrow(/exited 128/);
    await expect(runGit(join(notARepo, "gone"), ["status"])).rejects.toThrow(/ENOENT/);
    expect(await rejectionCode(runGit(notARepo, ["rev-parse", "HEAD"]))).toMatch(
      /^not a RunnerError/,
    );
  });
});

describe("the read-only repo reader", () => {
  it("normalises a valid branch name and refuses others with base_ref_invalid", async () => {
    const repo = tempRepo();
    expect(await checkBranchName(repo.path, "feature/x")).toBe("feature/x");
    for (const name of ["HEAD", "a..b", "-x", "@{-1}"]) {
      expect(await rejectionCode(checkBranchName(repo.path, name))).toBe("base_ref_invalid");
    }
  });

  it("resolves a branch to its commit, and an absent branch to undefined", async () => {
    const repo = tempRepo();
    const main = repo.git("rev-parse", "HEAD");
    expect(await resolveBranch(repo.path, "main")).toBe(main);
    expect(await resolveBranch(repo.path, "satan/patch/pj-1")).toBeUndefined();
    repo.git("branch", "satan/patch/pj-1");
    expect(await resolveBranch(repo.path, "satan/patch/pj-1")).toBe(main);
    repo.git("checkout", "--quiet", "-b", "moved");
    const moved = repo.commit("NEW");
    repo.git("branch", "--force", "satan/patch/pj-1", "moved");
    expect(await resolveBranch(repo.path, "satan/patch/pj-1")).toBe(moved);
  });

  it("writes nothing to the repo", async () => {
    const repo = tempRepo();
    const before = repo.snapshot();
    await checkBranchName(repo.path, "main");
    await resolveBranch(repo.path, "main");
    await resolveBranch(repo.path, "absent");
    expect(repo.snapshot()).toBe(before);
  });
});

describe("checkBaseRef: a branch of the real repo", () => {
  it("accepts an existing branch", async () => {
    const repo = tempRepo();
    expect(await checkBaseRef(gitRepoReader, { name: "satan", path: repo.path }, "main")).toBe(
      "main",
    );
  });

  it.each([
    ["a missing branch", "nope"],
    ["a tag", "v1"],
    ["an oid", "oid"],
  ])("refuses %s with base_ref_invalid naming repo and ref", async (_label, ref) => {
    const repo = tempRepo();
    repo.git("tag", "v1");
    const name = ref === "oid" ? repo.git("rev-parse", "HEAD") : ref;
    const check = checkBaseRef(gitRepoReader, { name: "satan", path: repo.path }, name);
    await expect(check).rejects.toThrow(`baseRef "${name}" is not a branch of repo satan`);
    expect(await rejectionCode(check)).toBe("base_ref_invalid");
  });
});
