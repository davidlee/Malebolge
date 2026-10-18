// The job's execution environment (EX-3, EX-6, EX-7, VT-2): pi-env's remote
// environment behind the runner's own Connection subclass. Held to
// pi-durable's ExecutionEnv conformance over a local pi-env daemon; the ssh
// route to the room is checked by its arguments only (no real ssh in tests).

import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import { Connection, sshArguments } from "@earendil-works/pi-env";
import { afterEach, describe, expect, it } from "vitest";
import { context } from "../../src/context.ts";
import {
  type ConnectionObserver,
  JobConnection,
  jobEnv,
  roomDaemon,
  sshTarget,
} from "../../src/runner/env.ts";
import type { RoomConnection } from "../../src/runner/room.ts";
import { tempDir } from "../fixtures.ts";
import { localConnection } from "./env-fixture.ts";

const ignoreLost: ConnectionObserver = { lost: () => Promise.resolve() };

registerEnvConformance(
  { describe, expect, it },
  "runner job env",
  async (use) => {
    const tmp = await tempDir();
    const connection = localConnection();
    try {
      await use(jobEnv({ jobId: "pj-1", cwd: tmp.dir, connection, observer: ignoreLost }));
    } finally {
      connection.close();
      await tmp.cleanup();
    }
  },
  { listFiles: true },
);

describe("the job's connection (EX-7)", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it("is the runner's Connection subclass, delegating to the daemon connection", async () => {
    const tmp = await tempDir();
    const inner = localConnection();
    cleanup = async (): Promise<void> => {
      inner.close();
      await tmp.cleanup();
    };
    const started: string[] = [];
    const env = jobEnv({
      jobId: "pj-1",
      cwd: tmp.dir,
      connection: inner,
      observer: { ...ignoreLost, started: (op) => started.push(op) },
    });

    const result = await env.exec("true", undefined, context);

    expect(env.connection).toBeInstanceOf(JobConnection);
    expect(env.id).toBe("pi-env:job-pj-1");
    expect(result.ok && result.value.exitCode).toBe(0);
    expect(started).toContain("exec");
    expect(await env.connection.info()).toEqual(await inner.info());
    expect(await env.connection.session()).toBe(await inner.session());
  });
});

/** A connection that only records what it is told to stop. */
class StopRecorder extends Connection {
  readonly stops: string[] = [];
  constructor() {
    super({ command: [] });
  }
  override close(): void {
    this.stops.push("close");
  }
  override kill(id: number, session: number): void {
    this.stops.push(`kill ${String(id)}/${String(session)}`);
  }
}

describe("the job's connection stops its daemon connection", () => {
  it("passes close and kill through", () => {
    const inner = new StopRecorder();
    const connection = new JobConnection(inner, ignoreLost);

    connection.kill(7, 2);
    connection.close();

    expect(inner.stops).toEqual(["kill 7/2", "close"]);
  });
});

describe("the ssh route to the room", () => {
  const room: RoomConnection = {
    host: "10.99.0.2",
    user: "agent",
    hostKeyAlias: "pi-env-room",
    knownHosts: "/home/test/.ssh/known_hosts",
    sshConfig: "/home/test/.ssh/config",
    identity: "/home/test/.ssh/id",
  };

  it("passes every connection fact to ssh, host keys checked under the fixed alias", () => {
    const args = sshArguments(sshTarget(room));

    expect(args).toEqual(
      expect.arrayContaining([
        "-F",
        "/home/test/.ssh/config",
        "-l",
        "agent",
        'IdentityFile="/home/test/.ssh/id"',
        "HostKeyAlias=pi-env-room",
        'UserKnownHostsFile="/home/test/.ssh/known_hosts"',
        "StrictHostKeyChecking=yes",
      ]),
    );
    expect(args.slice(-2)).toEqual(["--", "10.99.0.2"]);
  });

  it("is a lazy daemon connection: building it starts nothing", () => {
    const connection = roomDaemon(room);

    expect(connection).toBeInstanceOf(Connection);
    connection.close();
  });

  it("leaves ssh's defaults when the optional facts are absent", () => {
    const args = sshArguments(
      sshTarget({
        host: room.host,
        user: room.user,
        hostKeyAlias: room.hostKeyAlias,
        knownHosts: room.knownHosts,
      }),
    );

    expect(args).not.toContain("-F");
    expect(args.some((arg) => arg.startsWith("IdentityFile="))).toBe(false);
  });
});
