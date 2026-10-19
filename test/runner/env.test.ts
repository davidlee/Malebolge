// The job's execution environment (EX-3, EX-6, EX-7, VT-2): pi-env's remote
// environment behind the runner's own Connection subclass. Held to
// pi-durable's ExecutionEnv conformance over a local pi-env daemon; the ssh
// route to the room is checked by its arguments only (no real ssh in tests).

import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import { sshArguments } from "@earendil-works/pi-env";
import { afterEach, describe, expect, it } from "vitest";
import { context } from "../../src/context.ts";
import {
  type ConnectionObserver,
  daemonCommand,
  daemonConnection,
  ObservedConnection,
  sshTarget,
} from "../../src/room/connection.ts";
import { jobEnv } from "../../src/runner/env.ts";
import { daemonLaunch, roomConnection } from "../../src/runner/room.ts";
import { tempDir } from "../fixtures.ts";
import { DAEMON, fakeHelpers, localConnection } from "../room/connection-fixture.ts";
import { exampleConfig, roomConfig } from "./config-fixture.ts";
import { doorFacts } from "./env-fixture.ts";

const ignoreLost: ConnectionObserver = {
  lost: () => Promise.resolve(),
  untrusted: () => undefined,
};

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

    expect(env.connection).toBeInstanceOf(ObservedConnection);
    expect(env.id).toBe("pi-env:job-pj-1");
    expect(result.ok && result.value.exitCode).toBe(0);
    expect(started).toContain("exec");
    expect(await env.connection.info()).toEqual(await inner.info());
    expect(await env.connection.session()).toBe(await inner.session());
  });
});

// --- the daemon command (VT-5, EX-4, EX-5) ----------------------------------------

describe("the daemon command: one for both door kinds (VT-5, EX-4)", () => {
  it("room: ssh <sshArguments(target, true)> <session_path> <repo> -- <daemon>, the room name as host", async () => {
    const { facts, launch } = doorFacts(roomConfig());
    const helpers = fakeHelpers();

    const command = await daemonCommand(facts, launch, helpers)();

    const target = sshTarget(facts);
    expect(command).toEqual([
      "ssh",
      ...sshArguments(target, true),
      `'/run/current-system/sw/bin/session' 'satan' '--' '${DAEMON}'`,
    ]);
    expect(command).toContain("StrictHostKeyChecking=yes");
    expect(command).toContain("HostKeyAlias=room-assistant");
    expect(command).toContain('UserKnownHostsFile="/var/lib/capsule/room/assistant/known_hosts"');
    expect(command.slice(-3, -1)).toEqual(["--", "assistant"]);
  });

  it("room: session_path verbatim and the job's own repo", async () => {
    const config = roomConfig();
    const repo = config.repos.get("satan");
    if (repo === undefined || config.door?.kind !== "room") {
      throw new Error("fixture is not a room with repo satan");
    }
    const odd = { ...config, door: { ...config.door, sessionPath: "/opt/it's session" } };

    const launch = daemonLaunch(odd, { ...repo, name: "other" });

    expect(launch(DAEMON)).toEqual(["/opt/it's session", "other", "--", DAEMON]);
    const command = await daemonCommand(roomConnection(odd), launch, fakeHelpers())();
    expect(command.at(-1)).toBe(`'/opt/it'\\''s session' 'other' '--' '${DAEMON}'`);
  });

  it("slot: the daemon path alone, the slot's host", async () => {
    const { facts, launch } = doorFacts(exampleConfig());

    const command = await daemonCommand(facts, launch, fakeHelpers())();

    expect(command).toEqual(["ssh", ...sshArguments(sshTarget(facts), true), `'${DAEMON}'`]);
    expect(command).toContain("StrictHostKeyChecking=yes");
    expect(command).toContain("HostKeyAlias=pi-env-f");
  });

  it("detectPlatform once per connection, deployDaemon every start, both on the configured target", async () => {
    const { facts, launch } = doorFacts(roomConfig());
    const helpers = fakeHelpers();
    const command = daemonCommand(facts, launch, helpers);

    await command();
    await command();

    expect(helpers.detected).toHaveLength(1);
    expect(helpers.deployed).toHaveLength(2);
    expect(helpers.deployed[0]).toEqual(sshTarget(facts));
    expect(helpers.detected[0]).toMatchObject({
      host: "assistant",
      hostKeyAlias: "room-assistant",
      knownHostsFile: "/var/lib/capsule/room/assistant/known_hosts",
    });
  });
});

/** What an `ObservedConnection`'s observer was told. */
function observed(): ConnectionObserver & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    lost: (failure): Promise<void> => {
      seen.push(`lost ${failure.code}`);
      return Promise.resolve();
    },
    untrusted: (failure, trust): void => {
      seen.push(`untrusted ${failure.code} ${trust.constructor.name}`);
    },
  };
}

describe("each door kind's daemon connection under an ObservedConnection (VT-5, EX-5)", () => {
  it.each([
    ["slot", exampleConfig],
    ["room", roomConfig],
  ])("%s: a lost failure still reaches the observer as lost", async (_kind, config) => {
    const { facts, launch } = doorFacts(config());
    const observer = observed();
    // `false` as ssh: the daemon exits before it is ready, pi-env's lost failure.
    const inner = daemonConnection(facts, launch, fakeHelpers("false"));
    const connection = new ObservedConnection(inner, observer);

    await expect(connection.info()).rejects.toThrow();
    connection.close();

    expect(observer.seen).toEqual(["lost unknown"]);
  });
});
