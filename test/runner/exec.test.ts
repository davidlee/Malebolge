import { describe, expect, it } from "vitest";
import { runProgram } from "../../src/runner/exec.ts";
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

  it("rejects when the program is killed by a signal", async () => {
    await expect(runProgram("sh", ["-c", "kill -9 $$"])).rejects.toThrow(/killed by SIGKILL/);
  });
});
