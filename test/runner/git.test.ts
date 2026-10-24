import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkBaseRef,
  gitQuarantineReader,
  gitRepoReader,
  resolveCommit,
  runGit,
} from "../../src/runner/git.ts";
import { tempDir, tempRepo } from "./git-fixture.ts";
import { rejectionCode } from "./refusal-fixture.ts";

const { checkBranchName, resolveBranch } = gitRepoReader;
const { inspect } = gitQuarantineReader;

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
    const notARepo = tempDir();
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

describe("resolveCommit", () => {
  it("resolves any ref to its commit, and an absent one to undefined", async () => {
    const repo = tempRepo();
    const main = repo.git("rev-parse", "HEAD");
    repo.git("update-ref", "refs/capsule/f/heads/job/pj-1", main);
    expect(await resolveCommit(repo.path, "refs/capsule/f/heads/job/pj-1")).toBe(main);
    expect(await resolveCommit(repo.path, "refs/capsule/f/heads/job/pj-2")).toBeUndefined();
  });
});

describe("the quarantine reader: facts over base..reviewed", () => {
  it("lists every path touched by any commit, the commits and the tip diffstat", async () => {
    const repo = tempRepo();
    const base = repo.git("rev-parse", "HEAD");
    repo.commit("src/a.ts");
    repo.commit("out/x");
    repo.git("rm", "--quiet", "out/x");
    repo.git("commit", "--quiet", "-m", "drop out/x");
    const tip = repo.git("rev-parse", "HEAD");
    const facts = await inspect(repo.path, base, tip);
    expect(facts.ancestryOk).toBe(true);
    expect(facts.changedPaths).toEqual(["src/a.ts", "out/x"]);
    expect(facts.commits.map((commit) => commit.subject)).toEqual([
      "add src/a.ts",
      "add out/x",
      "drop out/x",
    ]);
    expect(facts.commits.at(-1)?.oid).toBe(tip);
    expect(facts.diffstat).toEqual({ files: 1, insertions: 1, deletions: 0 });
  });

  it("gives each commit its full message, body included, an empty one too", async () => {
    const repo = tempRepo();
    const base = repo.git("rev-parse", "HEAD");
    repo.commit("src/a.ts");
    repo.git("commit", "--quiet", "--allow-empty", "--allow-empty-message", "-m", "");
    repo.git("commit", "--quiet", "--allow-empty", "-m", "fix the walk", "-m", "Why:\n- it looped");
    const tip = repo.git("rev-parse", "HEAD");
    const facts = await inspect(repo.path, base, tip);
    expect(facts.commits.map(({ subject, message }) => [subject, message])).toEqual([
      ["add src/a.ts", "add src/a.ts\n"],
      ["", ""],
      ["fix the walk", "fix the walk\n\nWhy:\n- it looped\n"],
    ]);
    expect(facts.commits.at(-1)?.oid).toBe(tip);
  });

  it("lists the paths a merge commit brings in", async () => {
    const repo = tempRepo();
    const base = repo.git("rev-parse", "HEAD");
    repo.git("switch", "--quiet", "-c", "side");
    repo.commit("out/side");
    repo.git("switch", "--quiet", "-c", "job", base);
    repo.commit("src/a.ts");
    repo.git("merge", "--quiet", "--no-ff", "-m", "merge side", "side");
    const facts = await inspect(repo.path, base, repo.git("rev-parse", "HEAD"));
    expect(facts.changedPaths).toEqual(expect.arrayContaining(["out/side", "src/a.ts"]));
    expect(facts.commits).toHaveLength(3);
  });

  it("returns raw paths: spaces and non-ASCII names are not quoted", async () => {
    const repo = tempRepo();
    const base = repo.git("rev-parse", "HEAD");
    repo.commit("src/with space.ts");
    repo.commit("src/naïve.ts");
    const facts = await inspect(repo.path, base, repo.git("rev-parse", "HEAD"));
    expect(facts.changedPaths).toEqual(["src/with space.ts", "src/naïve.ts"]);
  });

  it("counts lines in the diffstat", async () => {
    const repo = tempRepo();
    const base = repo.git("rev-parse", "HEAD");
    repo.commit("src/a.ts");
    repo.git("rm", "--quiet", "README");
    repo.git("commit", "--quiet", "-m", "drop README");
    const facts = await inspect(repo.path, base, repo.git("rev-parse", "HEAD"));
    expect(facts.diffstat).toEqual({ files: 2, insertions: 1, deletions: 1 });
  });

  it("finds nothing when reviewed is base", async () => {
    const repo = tempRepo();
    const base = repo.git("rev-parse", "HEAD");
    expect(await inspect(repo.path, base, base)).toEqual({
      ancestryOk: true,
      changedPaths: [],
      commits: [],
      diffstat: { files: 0, insertions: 0, deletions: 0 },
    });
  });

  it.each([
    ["is not an ancestor", "orphan"],
    ["is absent from the repo", "absent"],
  ])("fails ancestry, and reports nothing else, when base %s", async (_label, how) => {
    const repo = tempRepo();
    let base = repo.git("rev-parse", "HEAD");
    if (how === "absent") {
      base = "0123456789abcdef0123456789abcdef01234567";
    }
    repo.git("switch", "--quiet", "--orphan", "rewrite");
    repo.commit("src/a.ts");
    expect(await inspect(repo.path, base, repo.git("rev-parse", "HEAD"))).toEqual({
      ancestryOk: false,
      changedPaths: [],
      commits: [],
      diffstat: { files: 0, insertions: 0, deletions: 0 },
    });
  });

  it("writes nothing to the repo", async () => {
    const repo = tempRepo();
    const base = repo.git("rev-parse", "HEAD");
    const tip = repo.commit("src/a.ts");
    const before = repo.snapshot();
    await inspect(repo.path, base, tip);
    expect(repo.snapshot()).toBe(before);
  });

  it("throws when the quarantine is not a repo", async () => {
    await expect(inspect(join(tempDir(), "gone"), "a", "b")).rejects.toThrow(/ENOENT/);
  });
});
