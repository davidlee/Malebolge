import { describe, expect, it } from "vitest";
import { parse } from "smol-toml";
import { isRecord, type JsonRecord } from "../../src/json.ts";
import { parseRunnerConfig } from "../../src/runner/config.ts";
import { HOME, ROOM_TOML } from "./config-fixture.ts";
import {
  answered,
  deployedPaths,
  followJob,
  hostKeyVerdict,
  requireLive,
  scratchConfig,
  smokeSubmit,
  tamperKnownHosts,
  type JobEvent,
} from "./live-fixture.ts";

const KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIE5705byMzy5A03IAHzkr6XyCikG2O6nxUJexJNIFCiM";
const KNOWN_HOSTS = `other-host ssh-ed25519 ${KEY}\nroom-assistant ssh-ed25519 ${KEY}\n`;

describe("requireLive", () => {
  it("refuses unless SATAN_RUNNER_LIVE is 1", () => {
    expect(() => {
      requireLive({});
    }).toThrow(/SATAN_RUNNER_LIVE=1/);
    expect(() => {
      requireLive({ SATAN_RUNNER_LIVE: "yes" });
    }).toThrow(/SATAN_RUNNER_LIVE=1/);
    expect(() => {
      requireLive({ SATAN_RUNNER_LIVE: "1" });
    }).not.toThrow();
  });
});

describe("answered", () => {
  it("returns an ok response and refuses a refusal, naming the op and code", () => {
    const ok = { requestId: "r1", ok: true, jobId: "pj-1" };
    expect(answered(ok, "submit")).toBe(ok);
    expect(() =>
      answered({ ok: false, error: { code: "runner_disabled", message: "off" } }, "submit"),
    ).toThrow(/submit refused: .*runner_disabled/);
  });
});

describe("deployedPaths", () => {
  const env = { HOME: "/home/u", XDG_RUNTIME_DIR: "/run/user/9" };

  it("finds the deployed runner by the runner's own path rules", () => {
    expect(deployedPaths(env)).toMatchObject({
      config: "/home/u/.config/satan-runner/config.toml",
      socket: "/run/user/9/satan-runner/control.sock",
      store: "/home/u/.local/state/satan/runner/runner.sqlite",
    });
  });

  it("takes SATAN_RUNNER_CONFIG and XDG_STATE_HOME when set", () => {
    const paths = deployedPaths({ ...env, SATAN_RUNNER_CONFIG: "/c.toml", XDG_STATE_HOME: "/s" });
    expect(paths).toMatchObject({ config: "/c.toml", store: "/s/satan/runner/runner.sqlite" });
  });
});

describe("smokeSubmit", () => {
  it("asks, as interactive, for one exact file on goad-walk, never a prefix", () => {
    const request = smokeSubmit({ submissionId: "s-1", date: "2026-10-19", slow: false });
    expect(request).toMatchObject({
      submissionId: "s-1",
      mode: "interactive",
      repo: "goad-walk",
      allowedPaths: ["SMOKE.md"],
    });
    expect(request.directive).toContain("runner smoke 2026-10-19");
    expect(request.directive).not.toContain("sleep");
  });

  it("asks the slow job to sleep first, so the room can be stopped mid-run", () => {
    const { directive } = smokeSubmit({ submissionId: "s-2", date: "d", slow: true });
    expect(directive).toMatch(/^First run `sleep 120`/);
  });
});

describe("tamperKnownHosts", () => {
  it("changes one character of the alias's key and nothing else", () => {
    const tampered = tamperKnownHosts(KNOWN_HOSTS, "room-assistant");
    const [other, room, rest] = tampered.split("\n");
    expect(other).toBe(`other-host ssh-ed25519 ${KEY}`);
    expect(rest).toBe("");
    const body = room?.split(" ")[2] ?? "";
    expect(body).toHaveLength(KEY.length);
    expect(body).not.toBe(KEY);
    const changed = Array.from(KEY, (_, index) => index).filter((i) => body[i] !== KEY[i]);
    expect(changed).toHaveLength(1);
    expect(body.slice(0, 20)).toBe(KEY.slice(0, 20));
  });

  it("refuses a file without the alias", () => {
    expect(() => tamperKnownHosts(KNOWN_HOSTS, "room-other")).toThrow(/room-other/);
  });
});

/** The `[door]` table of a parsed config. */
function doorOf(doc: JsonRecord): JsonRecord {
  const door = doc["door"];
  if (!isRecord(door)) {
    throw new Error("no [door] table");
  }
  return door;
}

describe("scratchConfig", () => {
  it("rewrites only known_hosts and enabled, and stays a valid config", () => {
    const parked = ROOM_TOML.replace("enabled = true", "enabled = false");
    const text = scratchConfig(parked, "/tmp/x/known_hosts");
    const config = parseRunnerConfig(text, HOME);
    expect(config.enabled).toBe(true);
    expect(config.door).toMatchObject({ knownHosts: "/tmp/x/known_hosts" });
    const before = parse(parked);
    const after = parse(text);
    expect({ ...after, enabled: false, door: before["door"] }).toEqual(before);
    expect({ ...doorOf(after), known_hosts: "same" }).toEqual({
      ...doorOf(before),
      known_hosts: "same",
    });
  });

  it("refuses a config with no door", () => {
    expect(() => scratchConfig("enabled = false\n", "/k")).toThrow(/door/);
  });
});

const transition = (from: string, to: string, extra: Record<string, unknown> = {}): JobEvent => ({
  kind: "transition",
  payload: { from, to, ...extra },
});

describe("hostKeyVerdict", () => {
  it("passes a failure with reason host_key out of preparing", () => {
    const events = [
      { kind: "submitted", payload: {} },
      transition("queued", "preparing"),
      transition("preparing", "failed", { reason: "host_key" }),
    ];
    expect(hostKeyVerdict(events)).toEqual({ ok: true });
  });

  it("fails a pause, even one that later fails host_key", () => {
    const events = [
      transition("queued", "preparing"),
      transition("preparing", "waiting_room"),
      transition("waiting_room", "failed", { reason: "host_key" }),
    ];
    expect(hostKeyVerdict(events)).toMatchObject({ ok: false });
  });

  it("fails another reason, or no failure at all", () => {
    expect(
      hostKeyVerdict([transition("preparing", "failed", { reason: "dirty_clone" })]),
    ).toMatchObject({ ok: false });
    expect(hostKeyVerdict([transition("queued", "preparing")])).toMatchObject({ ok: false });
  });
});

/** A `call` answering each `status` with the next state of `states`, the last repeating. */
function statusCalls(states: readonly string[]): {
  call: (op: string) => Promise<Record<string, unknown>>;
  ops: string[];
} {
  const ops: string[] = [];
  let index = 0;
  return {
    ops,
    call: (op: string): Promise<Record<string, unknown>> => {
      ops.push(op);
      const state = states[Math.min(index++, states.length - 1)];
      return Promise.resolve({ ok: true, job: { jobId: "pj-1", state } });
    },
  };
}

describe("followJob", () => {
  it("reports each state once and stops at needs_review", async () => {
    const client = statusCalls(["queued", "preparing", "preparing", "running", "needs_review"]);
    const seen: string[] = [];
    const final = await followJob(client, "pj-1", {
      intervalMs: 0,
      timeoutMs: 10_000,
      onState: (state): void => {
        seen.push(state);
      },
    });
    expect(final["state"]).toBe("needs_review");
    expect(seen).toEqual(["queued", "preparing", "running", "needs_review"]);
    expect(client.ops.every((op) => op === "status")).toBe(true);
  });

  it("stops at a terminal state", async () => {
    const final = await followJob(statusCalls(["preparing", "failed"]), "pj-1", {
      intervalMs: 0,
      timeoutMs: 10_000,
      onState: () => undefined,
    });
    expect(final["state"]).toBe("failed");
  });

  it("gives up at the timeout", async () => {
    await expect(
      followJob(statusCalls(["running"]), "pj-1", {
        intervalMs: 1,
        timeoutMs: 5,
        onState: () => undefined,
      }),
    ).rejects.toThrow(/timed out/);
  });

  it("fails on a refused status", async () => {
    const client = {
      call: (): Promise<JsonRecord> =>
        Promise.resolve({ ok: false, error: { code: "unknown_job" } }),
    };
    await expect(
      followJob(client, "pj-1", { intervalMs: 0, timeoutMs: 100, onState: () => undefined }),
    ).rejects.toThrow(/unknown_job/);
  });
});
