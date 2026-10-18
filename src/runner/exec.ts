// The runner's one way to run another program: an argument array, never a
// shell. Git and the room's command line are both run through it.

import { execFile } from "node:child_process";

export interface ProgramOutput {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ProgramOptions {
  cwd?: string;
  /** Laid over the runner's own environment. */
  env?: Readonly<Record<string, string>>;
}

/** Generous, so a long `git log` is not cut short (Node's default is 1 MiB). */
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Runs `program args`. Resolves with the exit code and output whatever the
 * code; rejects when the program could not run or did not exit (not found,
 * not executable, killed by a signal, output over the buffer).
 */
export function runProgram(
  program: string,
  args: readonly string[],
  options: ProgramOptions = {},
): Promise<ProgramOutput> {
  const { cwd, env = {} } = options;
  return new Promise((resolve, reject) => {
    execFile(
      program,
      args,
      { cwd, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: MAX_BUFFER },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
        } else if (typeof error.code === "number") {
          resolve({ code: error.code, stdout, stderr });
        } else {
          const why =
            typeof error.signal === "string" ? `killed by ${error.signal}` : error.message;
          reject(new Error(`${program}: ${why}`, { cause: error }));
        }
      },
    );
  });
}
