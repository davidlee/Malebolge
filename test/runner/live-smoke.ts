// SL-023 PHASE-12 live smoke (EX-6, EX-10a/b), run by a human against the
// deployed runner (`systemctl --user` unit satan-runner, enabled) and the live
// `assistant` room: `SATAN_RUNNER_LIVE=1 just smoke-runner [--slow]`. Not part
// of `just check` (not a `*.test.ts`).
//
// Submits one `interactive` job on goad-walk over the control socket (it writes and
// commits SMOKE.md, the only allowed path), follows it by `status` every 2 s,
// and prints each state, then the result and the job's audit, read from the
// store without writing to it. Exits 0 only on `needs_review`.
//
// It NEVER sends `report-disposition`: no promote, no reject. The result
// stays in quarantine for the human to inspect (EX-6).
//
// `--slow`: the agent sleeps 120 s first; at `IN FLIGHT`, stop the room
// (`capsule assistant stop`), wait for `waiting_room`, start it again
// (`capsule assistant start`); the job resumes through a fresh daemon (EX-10a).
//
// Env: SATAN_RUNNER_LIVE=1 (required); SMOKE_TIMEOUT_S (default 1800).

import { randomUUID } from "node:crypto";
import type { JsonRecord } from "../../src/json.ts";
import { controlClient } from "./control-fixture.ts";
import {
  answered,
  deployedPaths,
  followJob,
  log,
  readJobEvents,
  requireLive,
  smokeSubmit,
} from "./live-fixture.ts";

requireLive(process.env);
const slow = process.argv.includes("--slow");
const timeoutMs = Number(process.env["SMOKE_TIMEOUT_S"] ?? 1800) * 1000;
const paths = deployedPaths(process.env);

let inFlight = false;

/** One state as the smoke reports it, with the operator's cue in a slow run. */
function reportState(state: string, job: JsonRecord): void {
  const outcome = [job["endReason"], job["class"]].filter(
    (value): value is string => typeof value === "string",
  );
  log(`state ${state}${outcome.length > 0 ? ` (${outcome.join(", ")})` : ""}`);
  if (slow && state === "running" && !inFlight) {
    inFlight = true;
    log("IN FLIGHT: run `capsule assistant stop` now");
  }
  if (slow && state === "waiting_room") {
    log("ROOM DOWN: run `capsule assistant start` now");
  }
}

const client = await controlClient(paths.socket);
let final: JsonRecord;
try {
  log(`control ${paths.socket}`);
  const request = smokeSubmit({
    submissionId: `smoke-${randomUUID()}`,
    date: new Date().toISOString(),
    slow,
  });
  log(`submit ${JSON.stringify(request)}`);
  const jobId = String(answered(await client.call("submit", request), "submit")["jobId"]);
  log(`job ${jobId}`);
  final = await followJob(client, jobId, { intervalMs: 2000, timeoutMs, onState: reportState });
  const result = answered(await client.call("result", { jobId }), "result");
  log(`result ${JSON.stringify(result, undefined, 2)}`);
  for (const event of readJobEvents(paths.store, jobId)) {
    log(`event ${event.at} ${event.kind} ${JSON.stringify(event.payload)}`);
  }
} finally {
  client.close();
}
const passed = final["state"] === "needs_review";
log(passed ? "PASS: needs_review; left in quarantine" : `FAIL: ended ${String(final["state"])}`);
process.exit(passed ? 0 : 1);
