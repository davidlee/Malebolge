import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { runProgram, TimedOut } from "../../src/runner/exec.ts";
import { tempDir } from "./git-fixture.ts";

describe("runProgram", () => {
  it("resolves with the exit code and both streams, whatever the code", async () => {
    expect(await runProgram("sh", ["-c", "echo out; echo err >&2; exit 3"])).toEqual({
      code: 3,
      stdout: "out\n",
      stderr: "err\n",
    });
  });

  it("runs in cwd with env laid over the process environment", async () => {
    const dir = tempDir();
    const output = await runProgram("sh", ["-c", 'pwd; echo "$MB_X"'], {
      cwd: dir,
      env: { MB_X: "set" },
    });
    expect(output.stdout).toBe(`${dir}\nset\n`);
  });

  it("rejects when the program cannot run", async () => {
    await expect(runProgram("mb-no-such-program", [])).rejects.toThrow(/ENOENT/);
  });

  it("rejects, killing the program, when its output overflows the buffer", async () => {
    const tooMuch = String(65 * 1024 * 1024);
    await expect(runProgram("head", ["-c", tooMuch, "/dev/zero"])).rejects.toThrow(/output over/);
  });

  it("rejects when the program is killed by a signal", async () => {
    await expect(runProgram("sh", ["-c", "kill -9 $$"])).rejects.toThrow(/killed by SIGKILL/);
  });
});

/** Whether a process `pid` exists (a zombie included): signal 0 checks without sending. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A verb that never exits: its shell (the group leader) starts a grandchild
 * that keeps running on its own (stdio detached, so it holds no pipe), writes
 * both pids, then waits forever. `ignore` names signals each of them ignores.
 */
function hangingVerb(ignore: { leader?: string; grandchild?: string } = {}): {
  args: string[];
  pids: () => number[];
} {
  const file = join(tempDir(), "pids");
  const trap = (signal: string | undefined): string =>
    signal === undefined ? "" : `trap '' ${signal}; `;
  const script = [
    trap(ignore.leader),
    `(${trap(ignore.grandchild)}exec sleep 1000) </dev/null >/dev/null 2>&1 &`,
    `echo "$$ $!" > ${file}; `,
    "while :; do sleep 1; done",
  ].join("");
  const pids = (): number[] => readFileSync(file, "utf8").trim().split(" ").map(Number);
  // A failing run must not leave its sleepers behind.
  onTestFinished(() => {
    for (const pid of pids()) {
      if (alive(pid)) {
        process.kill(pid, "SIGKILL");
      }
    }
  });
  return { args: ["-c", script], pids };
}

describe("runProgram with a timeout", () => {
  it("resolves as usual when the program exits in time", async () => {
    expect(await runProgram("sh", ["-c", "echo ok"], { timeoutMs: 5000 })).toEqual({
      code: 0,
      stdout: "ok\n",
      stderr: "",
    });
  });

  it("on timeout kills the whole process group, grandchild included, before it rejects", async () => {
    const verb = hangingVerb();
    const started = Date.now();
    await expect(
      runProgram("sh", verb.args, { timeoutMs: 300, killGraceMs: 5000 }),
    ).rejects.toThrow(TimedOut);
    expect(Date.now() - started).toBeLessThan(4000);
    const [leader, grandchild] = verb.pids();
    expect([alive(leader ?? 0), alive(grandchild ?? 0)]).toEqual([false, false]);
  });

  it.each([
    ["the leader", { leader: "TERM" }],
    ["the grandchild", { grandchild: "TERM" }],
  ])("sends KILL after the grace when %s ignores TERM", async (_label, ignore) => {
    const verb = hangingVerb(ignore);
    const started = Date.now();
    await expect(runProgram("sh", verb.args, { timeoutMs: 300, killGraceMs: 300 })).rejects.toThrow(
      /timed out after 300 ms/,
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(600);
    const [leader, grandchild] = verb.pids();
    expect([alive(leader ?? 0), alive(grandchild ?? 0)]).toEqual([false, false]);
  });
});
