// PHASE-01 live spike (EX-3, RV-025 F-2): what pi-env raises when an oubliette
// slot is stopped mid-exec, at both seams the runner could own. Run by a human:
// `just spike-room-stop`, then `capsule <slot> stop` at the IN FLIGHT marker.
// Writes spike-results/room-stop-<timestamp>.json. Not part of `just check`.
//
// Env: MALEBOLGE_LIVE_SLOT (required, e.g. f), SPIKE_HOST (guest address,
// default 10.99.0.2), SPIKE_WAIT_MS (how long to wait for the failure, default
// 10 min; on expiry the spike aborts its own call), SPIKE_IDENTITY (ssh key).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import {
  acceptHostKey,
  connectSsh,
  isConnectionLost,
  RemoteExecutionEnv,
  type SshConnectOptions,
  scanHostKey,
} from "@earendil-works/pi-env";
import { isRecord } from "../../src/json.ts";
import { JobConnection, type LostFailure } from "../../src/runner/env.ts";
import { markPause, PAUSE_SCHEMA, pauseRequested } from "./env-fixture.ts";
import { openSharedStore, within } from "./runner-fixture.ts";

/** The non-empty value of environment variable `name`, or undefined. */
const envVar = (name: string): string | undefined => {
  const value = process.env[name];
  return value === "" ? undefined : value;
};

const slot = envVar("MALEBOLGE_LIVE_SLOT");
if (slot === undefined) {
  throw new Error("MALEBOLGE_LIVE_SLOT is not set (e.g. f)");
}
const host = envVar("SPIKE_HOST") ?? "10.99.0.2";
const waitMs = Number(envVar("SPIKE_WAIT_MS") ?? 600_000);
const identity = envVar("SPIKE_IDENTITY");
const dir = join(process.cwd(), "spike-results");
const started = Date.now();
const since = (): number => Date.now() - started;
const log = (text: string): void => {
  console.log(`[${(since() / 1000).toFixed(1)} s] ${text}`);
};

interface ErrorShape {
  constructor: string | undefined;
  name: unknown;
  code: unknown;
  fields: unknown;
  message: unknown;
  isConnectionLost: boolean;
}

/** Constructor, name, code, fields and recognition of whatever was thrown or returned. */
const shape = (error: unknown): ErrorShape => {
  const e = isRecord(error) ? error : {};
  return {
    constructor: error instanceof Object ? error.constructor.name : undefined,
    name: e["name"],
    code: e["code"],
    fields: e["fields"],
    message: e["message"],
    isConnectionLost: isConnectionLost(error),
  };
};

const version = async (name: string): Promise<string> => {
  const manifest: unknown = JSON.parse(
    await readFile(join("node_modules", name, "package.json"), "utf8"),
  );
  const found = isRecord(manifest) ? manifest["version"] : undefined;
  return typeof found === "string" ? found : "unknown";
};

async function main(slot: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const configFile = join(dir, `ssh_config_${slot}`);
  await writeFile(
    configFile,
    `Host *\n  ProxyCommand socat - UNIX-CONNECT:/run/capsule/${slot}/ssh.sock\n`,
  );
  const target: SshConnectOptions = {
    host,
    user: "agent",
    configFile,
    knownHostsFile: join(dir, "known_hosts"),
    hostKeyAlias: `pi-env-oubliette-${slot}`,
    ...(identity === undefined ? {} : { identityFile: identity }),
    onLog: (text): void => {
      process.stderr.write(`pi-env: ${text}`);
    },
  };
  // Trust on first use: the route is the slot's own local relay socket.
  const scanned = await scanHostKey(target);
  await acceptHostKey(target, scanned.lines).catch((error: unknown) => {
    log(`host key: ${String(error)}`);
  });
  const { connection: inner, remote } = await connectSsh(target);
  log(`connected: ${remote.platform}/${remote.arch}, home ${remote.home}`);

  const store = await openSharedStore(dir, PAUSE_SCHEMA);
  const job = `room-stop-${String(started)}`;
  const seam: { failure: LostFailure; at: number; markSettledMs: number }[] = [];
  const otherFailures: { op: string; at: number; error: unknown }[] = [];
  const connection = new JobConnection(inner, {
    lost: async (failure): Promise<void> => {
      const at = since();
      await within(5000, "pause mark", markPause(store.db, job, failure));
      seam.push({ failure, at, markSettledMs: since() - at });
    },
    untrusted: (failure, trust): void => {
      otherFailures.push({ op: failure.op, at: since(), error: shape(trust) });
    },
    failed: (op, error): void => {
      otherFailures.push({ op, at: since(), error: shape(error) });
    },
  });
  const env = new RemoteExecutionEnv({ connection, id: `pi-env:${slot}`, cwd: remote.home });

  let lastOutputAt: number | undefined;
  let inFlightAt: number | undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, waitMs);
  const execResult = await env.exec(
    "while true; do date +%s; sleep 1; done",
    {
      onOutput: (): void => {
        lastOutputAt = since();
        if (inFlightAt === undefined) {
          inFlightAt = lastOutputAt;
          log(
            `=== IN FLIGHT: run 'capsule ${slot} stop' now (waiting up to ${String(waitMs / 1000)} s) ===`,
          );
        }
      },
    },
    withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
  );
  clearTimeout(timer);
  const failedAt = since();
  const aborted = controller.signal.aborted;
  log(aborted ? "wait expired; aborted the call ourselves (no stop seen)" : "exec settled");

  // While the slot is down, the next request.
  const followUpStart = since();
  const followUp = await env.exec("true", undefined, BACKGROUND_CONTEXT);
  const followUpMs = since() - followUpStart;

  const result = {
    slot,
    host,
    versions: {
      "pi-env": await version("@earendil-works/pi-env"),
      "pi-durable": await version("@earendil-works/pi-durable"),
    },
    hostKeyFingerprints: scanned.fingerprints,
    outcome: aborted ? "aborted-by-spike (dry run: no stop)" : "failed",
    timingsMs: {
      inFlightAt,
      lastOutputAt,
      failedAt,
      // Roughly: stop → failure. ~30 s means pi-env's silence timeout; ~0 an immediate ssh exit.
      lastOutputToFailure: lastOutputAt === undefined ? undefined : failedAt - lastOutputAt,
    },
    executionEnvSeam: execResult.ok
      ? { ok: true, value: execResult.value }
      : { ok: false, error: shape(execResult.error), cause: shape(execResult.error.cause) },
    connectionSeam: seam,
    otherFailures,
    pauseRequestedOnAdapter: await pauseRequested(store.db, job),
    followUp: {
      ms: followUpMs,
      result: followUp.ok ? { ok: true } : { ok: false, error: shape(followUp.error) },
    },
    negative: {
      sameMessageOrdinaryError: isConnectionLost(new Error("pi-env connection lost")),
    },
  };
  const file = join(dir, `room-stop-${new Date(started).toISOString().replaceAll(":", "-")}.json`);
  await writeFile(file, `${JSON.stringify(result, null, 2)}\n`);
  log(`results: ${file}`);
  connection.close();
  await store.storage.close(BACKGROUND_CONTEXT);
}

await main(slot);
