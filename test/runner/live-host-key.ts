// SL-023 PHASE-12 EX-10c, run by a human: a changed room host key fails a job
// `host_key` out of `preparing`, never a pause. `SATAN_RUNNER_LIVE=1 just
// smoke-runner-host-key`, with the deployed runner stopped (I1: one consumer
// per repo; this script checks, it never stops it). Not part of `just check`.
//
// Builds a scratch instance under a temp dir: the deployed config with only
// `known_hosts` (a copy of the room's, one character of the alias's key
// changed) and `enabled = true` rewritten; its own runtime and state dirs. It
// runs as a transient user unit, so the gateway key still arrives by
// `LoadCredential=`, never by environment. Submits one smoke job over the
// scratch socket, follows it, stops the unit, reads the scratch store's audit
// and judges it; deletes the scratch dir. The room's real `known_hosts` is only
// read: its sha256 is compared before and after.
//
// Env: SATAN_RUNNER_LIVE=1 (required); HOSTKEY_TIMEOUT_S (default 900).

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseRunnerConfig } from "../../src/runner/config.ts";
import { requiredEnv } from "../../src/runner/errors.ts";
import { runnerPaths } from "../../src/runner/start.ts";
import { controlClient } from "./control-fixture.ts";
import {
  answered,
  deployedPaths,
  followJob,
  hostKeyVerdict,
  log,
  readJobEvents,
  requireLive,
  scratchConfig,
  sha256File,
  smokeSubmit,
  tamperKnownHosts,
  waitForPath,
} from "./live-fixture.ts";

const run = promisify(execFile);

requireLive(process.env);
const home = requiredEnv(process.env, "HOME");
const timeoutMs = Number(process.env["HOSTKEY_TIMEOUT_S"] ?? 900) * 1000;
// The gateway client key the deployed unit loads (features/satan/runner.nix).
const keyFile = join(home, ".config", "llm-gateway", "keys", "satan-runner");

/** `systemctl --user is-active <unit>`'s answer; it exits non-zero when not active. */
function unitState(unit: string): Promise<string> {
  return new Promise((resolve) => {
    execFile("systemctl", ["--user", "is-active", unit], (_error, stdout) => {
      resolve(stdout.trim());
    });
  });
}

const deployedState = await unitState("satan-runner");
if (deployedState !== "inactive" && deployedState !== "failed") {
  throw new Error(`satan-runner is ${deployedState}: stop it first (I1)`);
}

const deployed = deployedPaths(process.env);
const deployedText = await readFile(deployed.config, "utf8");
const config = parseRunnerConfig(deployedText, home);
if (config.door?.kind !== "room") {
  throw new Error(`${deployed.config}: [door] is not a room`);
}
const realKnownHosts = config.door.knownHosts;
const before = await sha256File(realKnownHosts);
log(`real known_hosts ${realKnownHosts} sha256 ${before}`);

const dir = await mkdtemp(join(tmpdir(), "satan-runner-hostkey-"));
const unit = `satan-runner-hostkey-${randomUUID().slice(0, 8)}`;
const scratch = {
  knownHosts: join(dir, "known_hosts"),
  config: join(dir, "config.toml"),
  runtime: join(dir, "run"),
  state: join(dir, "state"),
};
const paths = runnerPaths({
  HOME: home,
  SATAN_RUNNER_CONFIG: scratch.config,
  XDG_RUNTIME_DIR: scratch.runtime,
  XDG_STATE_HOME: scratch.state,
});

let passed = false;
try {
  const tampered = tamperKnownHosts(
    await readFile(realKnownHosts, "utf8"),
    config.door.hostKeyAlias,
  );
  await writeFile(scratch.knownHosts, tampered, { mode: 0o600 });
  await writeFile(scratch.config, scratchConfig(deployedText, scratch.knownHosts), { mode: 0o600 });
  await mkdir(scratch.runtime, { mode: 0o700 });
  await mkdir(scratch.state, { mode: 0o700 });
  log(`scratch ${dir}, unit ${unit}`);

  const instance = spawn(
    "systemd-run",
    [
      "--user",
      "--pipe",
      "--wait",
      "--collect",
      "--quiet",
      `--unit=${unit}`,
      `--working-directory=${process.cwd()}`,
      // Absolute: systemd-run expands no specifiers in a property.
      "-p",
      `LoadCredential=${config.gateway.credential}:${keyFile}`,
      "-E",
      `SATAN_RUNNER_CONFIG=${scratch.config}`,
      "-E",
      `XDG_RUNTIME_DIR=${scratch.runtime}`,
      "-E",
      `XDG_STATE_HOME=${scratch.state}`,
      "-E",
      `PATH=${process.env["PATH"] ?? ""}`,
      process.execPath,
      "src/runner-main.ts",
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  const exited = once(instance, "exit");
  await Promise.race([
    waitForPath(paths.socket, 30_000),
    exited.then(() => {
      throw new Error("the scratch instance exited before serving its socket");
    }),
  ]);

  const client = await controlClient(paths.socket);
  let state: unknown;
  let jobId: string;
  try {
    const request = smokeSubmit({
      submissionId: `hostkey-${randomUUID()}`,
      date: new Date().toISOString(),
      slow: false,
    });
    jobId = String(answered(await client.call("submit", request), "submit")["jobId"]);
    log(`job ${jobId}`);
    const final = await followJob(client, jobId, {
      intervalMs: 1000,
      timeoutMs,
      onState: (next) => {
        log(`state ${next}`);
      },
    });
    state = final["state"];
  } finally {
    client.close();
  }

  await run("systemctl", ["--user", "stop", unit]);
  await exited;
  const events = readJobEvents(paths.store, jobId);
  for (const event of events) {
    log(`event ${event.at} ${event.kind} ${JSON.stringify(event.payload)}`);
  }
  const verdict = hostKeyVerdict(events);
  const after = await sha256File(realKnownHosts);
  log(`real known_hosts sha256 ${after}${after === before ? " (unchanged)" : " CHANGED"}`);
  passed = state === "failed" && verdict.ok && after === before;
  log(
    passed
      ? "PASS: failed host_key from preparing"
      : `FAIL: ${verdict.ok ? String(state) : verdict.why}`,
  );
} finally {
  if ((await unitState(unit)) === "active") {
    await run("systemctl", ["--user", "stop", unit]);
  }
  await rm(dir, { recursive: true, force: true });
}
process.exit(passed ? 0 : 1);
