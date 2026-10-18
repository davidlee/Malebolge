// PHASE-01 spike (DEC-055, RV-025 F-2/F-17), offline half: pi-env's
// lost-connection failure on a real local daemon killed mid-exec, recognised by
// type at the Connection seam, marked durably on the shared SQLite adapter
// outside any pi transaction, and visible to `afterTool`; the same text without
// the type is not recognised. The live half (a VM stop) is room-stop.live.test.ts.

import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import {
  Connection,
  isConnectionLost,
  localDaemon,
  RemoteError,
  RemoteExecutionEnv,
  type RemoteInfo,
} from "@earendil-works/pi-env";
import { afterEach, describe, expect, it } from "vitest";
import { context } from "../../src/context.ts";
import { tempDir } from "../fixtures.ts";
import { callThenAnswer, openFauxHarness, textOf, toolResults } from "../harness-fixture.ts";
import {
  type LostFailure,
  markPause,
  ObservedConnection,
  PAUSE_SCHEMA,
  pauseRequested,
} from "./env-fixture.ts";
import { closeHarness, openSharedStore, within } from "./runner-fixture.ts";

const JOB = "job-1";
const LOST_TEXT = "pi-env connection lost";

/** A connection whose every request fails with `error`; it never starts a daemon. */
class FailingConnection extends Connection {
  readonly #error: Error;
  constructor(error: Error) {
    super({ command: [] });
    this.#error = error;
  }
  override info(): Promise<RemoteInfo> {
    const home = "/tmp";
    return Promise.resolve({
      protocol: 1,
      version: "0",
      os: "linux",
      arch: "x86_64",
      home,
      tmpdir: home,
      separator: "/",
      cwd: home,
      driveCwds: {},
      pid: 0,
    });
  }
  override request(): Promise<never> {
    return Promise.reject(this.#error);
  }
}

/** A real local pi-env daemon (the binary pi-env ships for this machine). */
const localConnection = (): Connection => new Connection({ command: [localDaemon()] });

interface Observed {
  connection: ObservedConnection;
  marks: LostFailure[];
  env: (cwd: string) => ExecutionEnv;
}

/** `inner` behind the Connection seam, marking pauses on `db`. */
function observe(inner: Connection, db: SqliteDatabase, killOnExec: boolean): Observed {
  const marks: LostFailure[] = [];
  const connection = new ObservedConnection(inner, {
    lost: async (failure): Promise<void> => {
      marks.push(failure);
      await within(2000, "pause mark", markPause(db, JOB, failure));
    },
    started: (op): void => {
      if (killOnExec && op === "exec") {
        void inner.info().then((info) => process.kill(info.pid, "SIGTERM"));
      }
    },
  });
  return {
    connection,
    marks,
    env: (cwd) => new RemoteExecutionEnv({ connection, id: "pi-env:spike", cwd }),
  };
}

interface BashRun extends Observed {
  /** Whether the pause mark was durable at each afterTool. */
  markedAtAfterTool: boolean[];
  db: SqliteDatabase;
  resultText: string;
}

describe("room-down seam, offline", () => {
  let cleanup: (() => Promise<void>) | undefined;
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
    await cleanup?.();
  });

  /** A harness running `bash` in `inner`, with an afterTool hook reading the pause mark. */
  async function runBashThrough(inner: Connection, killOnExec: boolean): Promise<BashRun> {
    const tmp = await tempDir();
    cleanup = tmp.cleanup;
    const { db, storage } = await openSharedStore(tmp.dir, PAUSE_SCHEMA);
    const observed = observe(inner, db, killOnExec);
    const markedAtAfterTool: boolean[] = [];
    const guard = defineExtension({
      name: "guard",
      hooks: [
        hook(ToolTask, {
          afterTool: async () => {
            markedAtAfterTool.push(await pauseRequested(db, JOB));
            return undefined;
          },
        }),
      ],
    });
    const { harness, root, faux } = await openFauxHarness(storage, {
      extensions: [CodingTools, guard],
      env: () => observed.env(tmp.dir),
    });
    close = async (): Promise<void> => {
      inner.close();
      await closeHarness(harness);
    };
    faux.setResponses(callThenAnswer("bash", { command: "sleep 30" }, "after"));

    await within(
      15_000,
      "run",
      (async (): Promise<void> => {
        const input = await root.submit({ type: "input", content: "go" }, context);
        await input.wait(context);
      })(),
    );

    const [result] = await toolResults(harness);
    return {
      ...observed,
      markedAtAfterTool,
      db,
      resultText: result === undefined ? "" : textOf(result),
    };
  }

  it("a daemon killed mid-exec is a lost RemoteError at the Connection seam; the mark is durable before afterTool", async () => {
    const run = await runBashThrough(localConnection(), true);

    expect(run.marks).toEqual([{ op: "exec", name: "RemoteError", code: "unknown", lost: true }]);
    expect(run.markedAtAfterTool).toEqual([true]);
    expect(await pauseRequested(run.db, JOB)).toBe(true);
    // All afterTool would have without the mark: pi-durable's text.
    expect(run.resultText).toContain(LOST_TEXT);
  });

  it.each([
    ["an ordinary Error", new Error(LOST_TEXT)],
    ["a RemoteError without lost", new RemoteError({ code: "unknown", message: LOST_TEXT })],
  ])("%s with the same message is not recognised", async (_name, error) => {
    expect(isConnectionLost(error)).toBe(false);

    const run = await runBashThrough(new FailingConnection(error), false);

    expect(run.marks).toEqual([]);
    expect(run.markedAtAfterTool).toEqual([false]);
    expect(run.resultText).toContain(LOST_TEXT);
  });

  it("ExecutionEnv seam: exec returns the lost failure without its type; file ops keep it as cause", async () => {
    const tmp = await tempDir();
    cleanup = tmp.cleanup;
    const { db, storage } = await openSharedStore(tmp.dir, PAUSE_SCHEMA);
    close = (): Promise<void> => storage.close(context);
    // A daemon that exits before it is ready: pi-env's own lost failure, deterministically.
    const inner = new Connection({ command: ["sh", "-c", "exit 3"] });
    const { env, marks } = observe(inner, db, false);

    const exec = await env(tmp.dir).exec("true", undefined, context);
    const read = await env(tmp.dir).readTextFile("absent.txt", context);

    expect(exec.ok).toBe(false);
    if (exec.ok) {
      return;
    }
    expect(exec.error.code).toBe("unknown");
    expect(exec.error.cause).toBeUndefined();
    expect(isConnectionLost(exec.error.cause)).toBe(false);
    expect(read.ok).toBe(false);
    if (read.ok) {
      return;
    }
    expect(read.error.cause).toBeInstanceOf(RemoteError);
    expect(isConnectionLost(read.error.cause)).toBe(true);
    // Both were typed one layer down; the file op lost it resolving its path (`info`), before any request.
    expect(marks.map((mark) => [mark.op, mark.code, mark.lost])).toEqual([
      ["exec", "unknown", true],
      ["info", "unknown", true],
    ]);
  });

  it("control: a raw adapter call inside an adapter transaction never settles", async () => {
    const tmp = await tempDir();
    cleanup = tmp.cleanup;
    const { db, storage } = await openSharedStore(tmp.dir, PAUSE_SCHEMA);
    close = (): Promise<void> => storage.close(context);

    const nested = db.transaction(() =>
      within(300, "nested write", db.run("UPDATE runner_jobs SET pause_requested = 1")),
    );

    await expect(nested).rejects.toThrow("did not settle");
  });
});
