// The one stdin-capable spawner (design § A stdin-capable spawner, DEC-051):
// screwtape classify reads only stdin, and pi-durable's ExecutionEnv cannot
// feed it, so this exec has the same signature and boundedExec's caps apply
// unchanged. argv only — a shell is forbidden (DEC-028). The child gets its
// own process group, so a kill reaches whatever it started.

import { type ChildProcess, spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { StringDecoder } from "node:string_decoder";
import type { Context } from "@earendil-works/chord/context";
import {
  type ExecutionEnv,
  ExecutionError,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  err,
  ok,
  toError,
} from "@earendil-works/pi-durable/env";

type Outcome = Result<ShellExecResult, ExecutionError>;
type Stream = "stdout" | "stderr";

/** What one call needs once its refusals are answered: one argv, its input, its env. */
interface ExecRequest {
  readonly program: string;
  readonly args: readonly string[];
  readonly input: string;
  readonly options: ShellExecOptions;
  readonly context: Context;
  readonly signal: AbortSignal | undefined;
}

/** The live state of one child: per-stream decoders, the interruption flags, and one settle. */
interface Run {
  readonly request: ExecRequest;
  readonly child: ChildProcess;
  readonly stdout: StringDecoder;
  readonly stderr: StringDecoder;
  timer: NodeJS.Timeout | undefined;
  settled: boolean;
  timedOut: boolean;
  callbackError: ExecutionError | undefined;
}

/** Everything that can decide one child's ending, named so the decision is pure. */
interface EndedChild {
  readonly callbackError: ExecutionError | undefined;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** An exec that writes `input` to the child's stdin, then closes it. */
export function stdinEnv(input: string): Pick<ExecutionEnv, "exec"> {
  return {
    async exec(command, options, context): Promise<Outcome> {
      return execute(input, command, options, context);
    },
  };
}

/** One exec: refuse what would not be argv, then run the child. Never throws. */
function execute(
  input: string,
  command: string | readonly string[],
  options: ShellExecOptions | undefined,
  context: Context,
): Promise<Outcome> {
  const ready = request(input, command, options, context);
  if (!ready.ok) {
    return Promise.resolve(err(ready.error));
  }
  return new Promise<Outcome>((resolve) => {
    watch(ready.value, resolve);
  });
}

/** The refusals, in pi-durable's order: each names something other than argv reaching a child. */
function request(
  input: string,
  command: string | readonly string[],
  options: ShellExecOptions | undefined,
  context: Context,
): Result<ExecRequest, ExecutionError> {
  if (typeof command === "string") {
    return err(
      new ExecutionError(
        "spawn_error",
        "A string command would run through a shell (DEC-028): pass argv",
      ),
    );
  }
  const [program, ...args] = command;
  if (program === undefined) {
    return err(new ExecutionError("spawn_error", "Empty argv: no program to run"));
  }
  if (!replacesEnvironment(options)) {
    return err(
      new ExecutionError("spawn_error", "inheritEnv must be false: env replaces the environment"),
    );
  }
  const signal = context.abortSignal;
  if (signal?.aborted === true) {
    return err(new ExecutionError("aborted", "aborted"));
  }
  return ok({ program, args, input, options, context, signal });
}

/** pi-durable inherits when inheritEnv is absent, so only the explicit false replaces the environment. */
function replacesEnvironment(options: ShellExecOptions | undefined): options is ShellExecOptions {
  return options?.inheritEnv === false;
}

/** Spawn one argv: its own process group, its environment replaced, stdin piped (DEC-028). */
function spawnArgv(request: ExecRequest): ChildProcess {
  const cwd = request.options.cwd;
  return spawn(request.program, request.args, {
    ...(cwd === undefined ? {} : { cwd }),
    detached: true,
    env: request.options.env ?? {},
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** Spawn, mapping a synchronous failure to the value the caller gets, never a throw. */
function spawnChild(request: ExecRequest): Result<ChildProcess, ExecutionError> {
  try {
    return ok(spawnArgv(request));
  } catch (error) {
    const cause = toError(error);
    return err(new ExecutionError("spawn_error", cause.message, cause));
  }
}

/** Feed the child its input and settle its ending, once, from whichever event ends it. */
function watch(request: ExecRequest, resolve: (outcome: Outcome) => void): void {
  const spawned = spawnChild(request);
  if (!spawned.ok) {
    resolve(err(spawned.error));
    return;
  }
  const run: Run = {
    request,
    child: spawned.value,
    stdout: new StringDecoder("utf8"),
    stderr: new StringDecoder("utf8"),
    timer: undefined,
    settled: false,
    timedOut: false,
    callbackError: undefined,
  };
  const stop = (): void => {
    killChild(run.child);
  };
  const finish = (outcome: Outcome): void => {
    if (run.settled) {
      return;
    }
    run.settled = true;
    if (run.timer !== undefined) {
      clearTimeout(run.timer);
    }
    request.signal?.removeEventListener("abort", stop);
    resolve(outcome);
  };
  run.child.on("error", (error) => {
    finish(err(new ExecutionError("spawn_error", error.message, error)));
  });
  // A child that exits without reading its input fails this write with EPIPE; that is its business.
  run.child.stdin?.on("error", () => undefined);
  run.child.stdin?.end(request.input);
  run.child.stdout?.on("data", (chunk: Buffer) => {
    emitText(run, run.stdout.write(chunk), "stdout");
  });
  run.child.stderr?.on("data", (chunk: Buffer) => {
    emitText(run, run.stderr.write(chunk), "stderr");
  });
  run.child.on("close", (code, signal) => {
    emitText(run, run.stdout.end(), "stdout");
    emitText(run, run.stderr.end(), "stderr");
    finish(
      ending({
        callbackError: run.callbackError,
        timedOut: run.timedOut,
        aborted: request.signal?.aborted === true,
        code,
        signal,
      }),
    );
  });
  arm(run, stop);
}

/** Arm the two interruptions that kill the child: the deadline (seconds) and the caller's abort. */
function arm(run: Run, stop: () => void): void {
  const timeout = run.request.options.timeout;
  if (timeout !== undefined) {
    run.timer = setTimeout(() => {
      run.timedOut = true;
      stop();
    }, timeout * 1000);
  }
  run.request.signal?.addEventListener("abort", stop, { once: true });
}

/** Deliver one decoded chunk, unless the exec is over; a throw from onOutput kills the child. */
function emitText(run: Run, text: string, stream: Stream): void {
  const onOutput = run.request.options.onOutput;
  if (text === "" || onOutput === undefined || run.settled) {
    return;
  }
  if (run.callbackError !== undefined) {
    return;
  }
  try {
    onOutput(text, run.request.context, { stream });
  } catch (error) {
    const cause = toError(error);
    run.callbackError = new ExecutionError("callback_error", cause.message, cause);
    killChild(run.child);
  }
}

/** What one ended child settles to: a callback error, the interruption that killed it, or its exit. */
function ending(ended: EndedChild): Outcome {
  if (ended.callbackError !== undefined) {
    return err(ended.callbackError);
  }
  if (ended.timedOut) {
    return err(new ExecutionError("timeout", "timeout: the child ran past its deadline"));
  }
  if (ended.aborted) {
    return err(new ExecutionError("aborted", "aborted"));
  }
  return ok({ exitCode: exitCodeOf(ended) });
}

/** A child's exit code; one killed by a signal has none, so the conventional 128 + signal number. */
function exitCodeOf(ended: EndedChild): number {
  if (ended.code !== null) {
    return ended.code;
  }
  if (ended.signal === null) {
    return 1;
  }
  return 128 + osConstants.signals[ended.signal];
}

/** SIGKILL the child's process group: the child and everything it started. Never throws. */
function killChild(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}
