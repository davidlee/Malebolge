// The room session's connection (design §4.1): the observed seam over a
// daemon connection, which tells a lost room from an untrusted one by the
// daemon connection's own trust record; the ssh route to the room, checked by
// its arguments only (no real ssh in tests); and the direct launch.

import {
  Connection,
  HostKeyChangedError,
  HostKeyUnknownError,
  sshArguments,
} from "@earendil-works/pi-env";
import { describe, expect, it } from "vitest";
import {
  DaemonConnection,
  daemonCommand,
  directLaunch,
  ObservedConnection,
  observedEnv,
  type RoomConnection,
  sshTarget,
} from "../../src/room/connection.ts";
import { context } from "../../src/context.ts";
import { tempDir } from "../fixtures.ts";
import {
  DAEMON,
  fakeHelpers,
  ignoreLost,
  localConnection,
  recordingObserver,
} from "./connection-fixture.ts";

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

describe("the observed connection stops its inner connection", () => {
  it("passes close and kill through", () => {
    const inner = new StopRecorder();
    const connection = new ObservedConnection(inner, ignoreLost);

    connection.kill(7, 2);
    connection.close();

    expect(inner.stops).toEqual(["kill 7/2", "close"]);
  });
});

describe("an observed env", () => {
  it("is pi-env's remote env over the connection, observed", async () => {
    const tmp = await tempDir();
    const inner = localConnection();
    try {
      const started: string[] = [];
      const env = observedEnv(
        inner,
        { ...ignoreLost, started: (op) => started.push(op) },
        { id: "pi-env:test", cwd: tmp.dir },
      );

      const result = await env.exec("true", undefined, context);

      expect(env.connection).toBeInstanceOf(ObservedConnection);
      expect([env.id, env.cwd]).toEqual(["pi-env:test", tmp.dir]);
      expect(result.ok && result.value.exitCode).toBe(0);
      expect(started).toContain("exec");
    } finally {
      inner.close();
      await tmp.cleanup();
    }
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

describe("the direct launch", () => {
  it("runs the daemon itself: no session program, no wrapper", async () => {
    const room: RoomConnection = {
      host: "assistant",
      user: "satan",
      hostKeyAlias: "room-assistant",
      knownHosts: "/var/lib/capsule/room/assistant/known_hosts",
    };

    const command = await daemonCommand(room, directLaunch, fakeHelpers())();

    expect(directLaunch(DAEMON)).toEqual([DAEMON]);
    expect(command.at(-1)).toBe(`'${DAEMON}'`);
    expect(command.some((word) => word.includes("session"))).toBe(false);
  });
});

describe("the daemon connection under an ObservedConnection (VT-5, EX-5)", () => {
  it.each([
    ["HostKeyChangedError", (): Error => new HostKeyChangedError("changed")],
    ["HostKeyUnknownError", (): Error => new HostKeyUnknownError("unknown")],
  ])("a start failing %s is untrusted, never lost", async (name, failure) => {
    const observer = recordingObserver();
    const inner = new DaemonConnection(() => Promise.reject(failure()));
    const connection = new ObservedConnection(inner, observer);

    await expect(connection.info()).rejects.toThrow();
    await expect(connection.session()).rejects.toThrow();
    connection.close();

    expect(inner).toBeInstanceOf(Connection);
    expect(observer.seen).toEqual([
      `untrusted spawn_error ${name}`,
      `untrusted spawn_error ${name}`,
    ]);
  });

  it("a later start failing otherwise keeps the record: still untrusted (fail closed)", async () => {
    const observer = recordingObserver();
    let starts = 0;
    const inner = new DaemonConnection(() =>
      Promise.reject(starts++ === 0 ? new HostKeyChangedError("changed") : new Error("no route")),
    );
    const connection = new ObservedConnection(inner, observer);

    await expect(connection.info()).rejects.toThrow();
    await expect(connection.info()).rejects.toThrow();
    connection.close();

    expect(observer.seen).toEqual([
      "untrusted spawn_error HostKeyChangedError",
      "untrusted spawn_error HostKeyChangedError",
    ]);
  });

  it("a later start past the key check clears the record: its loss is lost", async () => {
    const observer = recordingObserver();
    let starts = 0;
    // The second start's command is built; its daemon (`false`) exits before it is ready.
    const inner = new DaemonConnection(() =>
      starts++ === 0
        ? Promise.reject(new HostKeyChangedError("changed"))
        : Promise.resolve(["false"]),
    );
    const connection = new ObservedConnection(inner, observer);

    await expect(connection.info()).rejects.toThrow();
    await expect(connection.info()).rejects.toThrow();
    connection.close();

    expect(observer.seen).toEqual(["untrusted spawn_error HostKeyChangedError", "lost unknown"]);
  });

  it("a connection that is not a daemon's has no trust record: its losses are lost", async () => {
    const observer = recordingObserver();
    const connection = new ObservedConnection(new Connection({ command: ["false"] }), observer);

    await expect(connection.info()).rejects.toThrow();
    connection.close();

    expect(observer.seen).toEqual(["lost unknown"]);
  });
});
