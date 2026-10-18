// The runner's one way to run another program: an argument array, never a
// shell. Git and the room's command line are both run through it. A run may be
// bounded: the program then leads its own process group, and past the bound
// the whole group is killed (design §5.2 "Killing a verb").

import { type ChildProcess, spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

export interface ProgramOutput {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ProgramOptions {
  cwd?: string;
  /** Laid over the runner's own environment. */
  env?: Readonly<Record<string, string>>;
  /** Past this the program's process group is killed and the run rejects `TimedOut`. */
  timeoutMs?: number;
  /** How long the group has after TERM before KILL. */
  killGraceMs?: number;
}

/** A bounded program did not exit in time; its whole process group is gone. */
export class TimedOut extends Error {
  constructor(program: string, timeoutMs: number) {
    super(`${program}: timed out after ${String(timeoutMs)} ms`);
    this.name = "TimedOut";
  }
}

/** Generous, so a long `git log` is not cut short. */
const MAX_BUFFER = 64 * 1024 * 1024;

const DEFAULT_KILL_GRACE_MS = 5000;

/** How often a dying group is checked for members. */
const POLL_MS = 20;

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // ESRCH: the group has no members left.
  }
}

/** Whether any process, a zombie included, is still in group `pgid`. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Whether group `pgid` empties within `withinMs`. */
async function groupEmpties(pgid: number, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (groupAlive(pgid)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await sleep(POLL_MS);
  }
  return true;
}

/**
 * Kills group `pgid`, every descendant still in it included: TERM, then KILL
 * once `graceMs` passes with a member left. Settles once the group is empty,
 * or KILL's own grace passes (a process stuck in the kernel).
 */
async function killGroup(pgid: number, graceMs: number): Promise<void> {
  signalGroup(pgid, "SIGTERM");
  if (await groupEmpties(pgid, graceMs)) {
    return;
  }
  signalGroup(pgid, "SIGKILL");
  await groupEmpties(pgid, graceMs);
}

/** The child's output, decoded once at the end so no character is split. */
function captureOutput(
  child: ChildProcess,
  overflow: () => void,
): () => { stdout: string; stderr: string } {
  const chunks: Record<"stdout" | "stderr", Buffer[]> = { stdout: [], stderr: [] };
  let size = 0;
  for (const name of ["stdout", "stderr"] as const) {
    child[name]?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BUFFER) {
        overflow();
        return;
      }
      chunks[name].push(chunk);
    });
  }
  return () => ({
    stdout: Buffer.concat(chunks.stdout).toString("utf8"),
    stderr: Buffer.concat(chunks.stderr).toString("utf8"),
  });
}

/**
 * Runs `program args`. Resolves with the exit code and output whatever the
 * code; rejects when the program could not run or did not exit (not found,
 * not executable, killed by a signal, output over the buffer). With
 * `timeoutMs`, the program leads a new process group; past the bound the run
 * rejects `TimedOut`, only once the program has exited and the group is gone.
 */
export function runProgram(
  program: string,
  args: readonly string[],
  options: ProgramOptions = {},
): Promise<ProgramOutput> {
  const { cwd, env = {}, timeoutMs, killGraceMs = DEFAULT_KILL_GRACE_MS } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd,
      env: { ...process.env, ...env },
      detached: timeoutMs !== undefined,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = captureOutput(child, () => {
      child.kill("SIGKILL");
      reject(new Error(`${program}: output over ${String(MAX_BUFFER)} bytes`));
    });
    const exited = new Promise<void>((done) => {
      child.once("exit", () => {
        done();
      });
    });
    let timedOut = false;
    const { pid } = child;
    const timer =
      timeoutMs === undefined || pid === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            void killGroup(pid, killGraceMs)
              .then(() => exited)
              .then(() => {
                reject(new TimedOut(program, timeoutMs));
              });
          }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`${program}: ${error.message}`, { cause: error }));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        return;
      }
      if (code === null) {
        reject(new Error(`${program}: killed by ${String(signal)}`));
      } else {
        resolve({ code, ...output() });
      }
    });
  });
}
