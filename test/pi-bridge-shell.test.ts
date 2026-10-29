// SL-009 PHASE-09: the extension shell against a fake pi and the wire's own
// daemon frames. Written red first against
// .doctrine/state/slice/009/briefs/phase-09-contract.md: `bridgeExtension` and
// `bridgeEnv` are stubs, so loading the extension fails every case but the pure
// `bridgeEnv` ones.
//
// Cases: VT-1 RV-021 F-3 (reply deadlines), EX-2 (bridge_post outcomes),
// VT-2 (the loud failure and recovery), VT-4 RV-021 F-6 (the bash spawn hook),
// EX-6 (posture in the system prompt), the delivery rules (DEC-090), and VT-5
// end to end over the real bridge listener.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { EXIT, runCommand } from "../pi-bridge/command.ts";
import { PI_POSTURE_TEXT } from "../pi-bridge/posture.ts";
import { BRIDGE_CUSTOM_TYPE, bridgeEnv, bridgeExtension } from "../pi-bridge/shell.ts";
import type { BridgeEntry, Pairing } from "../pi-bridge/state.ts";
import { BRIDGE_POST_WAIT_MS } from "../pi-bridge/wire.ts";
import { BRIDGE_ENTRY_KIND } from "../src/bridge/inbound.ts";
import { appendOutbox } from "../src/bridge/pairing.ts";
import { context } from "../src/context.ts";
import { type BridgeWorld, bridgeWorld } from "./bridge-fixture.ts";
import { tempDir } from "./fixtures.ts";
import {
  type FakeConn,
  type FakeDaemon,
  fakeDaemon,
  fakeDaemonAt,
} from "./pi-bridge-fake-daemon.ts";
import {
  branchEntry,
  branchMessage,
  type FakePi,
  fakePi,
  isRecord,
  type Notified,
  resultOutcome,
  resultText,
} from "./pi-bridge-fake-pi.ts";
import { only, recordedTurn, userText, WAIT } from "./wake-fixture.ts";

/** The mounted extension directory: what the spawn hook prepends to PATH. */
const BRIDGE_DIR = join(import.meta.dirname, "..", "pi-bridge");
const SESSION = "pi-session-7";
const CONVERSATION = "7";
const TOKEN = "tok-7-secret";
const PROJECT = "proj";

/** The shell's retry backoff (contract): `min(1000 * 2 ** (attempt - 1), 30_000)`. */
const retryDelayMs = (attempt: number): number => Math.min(1_000 * 2 ** (attempt - 1), 30_000);

/** Tests that drive a deadline: only the clock's timers are faked, so sockets keep working. */
const fakeClocks = (): void => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
};

/**
 * Waits for work a socket will deliver, without moving a fake clock:
 * `setImmediate` is left real, so the loop yields to I/O and never sleeps.
 */
async function waitUntil(condition: () => boolean, what: string): Promise<void> {
  for (let tick = 0; tick < 20_000; tick += 1) {
    if (condition()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setImmediate(() => {
        resolve();
      });
    });
  }
  throw new Error(`waited too long for ${what}`);
}

/** A cwd whose basename is the project the shell reports. */
async function projectCwd(): Promise<string> {
  const { dir, cleanup } = await tempDir();
  onTestFinished(cleanup);
  const cwd = join(dir, PROJECT);
  await mkdir(cwd, { recursive: true });
  return cwd;
}

/** The extension under test: the real `bridgeExtension`, wired to one socket. */
function extensionFor(fake: FakePi, socket: string): (pi: ExtensionAPI) => void {
  return bridgeExtension({
    env: { MALEBOLGE_BRIDGE_SOCKET: socket },
    extensionDir: BRIDGE_DIR,
    notifyDesktop: fake.notifyDesktop,
  });
}

/** A fake pi with the extension loaded and its session started. */
async function piWith(
  socket: string,
  options: { sessionId?: string; cwd?: string; entries?: readonly SessionEntry[] } = {},
): Promise<FakePi> {
  const fake = fakePi({
    sessionId: options.sessionId ?? SESSION,
    cwd: options.cwd ?? (await projectCwd()),
    ...(options.entries === undefined ? {} : { entries: options.entries }),
  });
  fake.load(extensionFor(fake, socket));
  await fake.startSession();
  return fake;
}

/** Whether `value` is a bridge entry state.ts would accept on a branch. */
function isBridgeEntry(value: unknown): value is BridgeEntry {
  if (!isRecord(value)) {
    return false;
  }
  if (value["kind"] === "unpaired") {
    return true;
  }
  return (
    value["kind"] === "pairing" &&
    typeof value["session"] === "string" &&
    typeof value["conversation"] === "string" &&
    typeof value["token"] === "string" &&
    (value["posture"] === "delegate" || value["posture"] === "consult")
  );
}

/** The last bridge entry the session's branch holds, if it holds one. */
function latestBridge(fake: FakePi): BridgeEntry | undefined {
  for (const entry of [...fake.entries()].reverse()) {
    if (
      entry.type === "custom" &&
      entry.customType === BRIDGE_CUSTOM_TYPE &&
      isBridgeEntry(entry.data)
    ) {
      return entry.data;
    }
  }
  return undefined;
}

/** The pairing the session holds; a failure when it holds none. */
function pairingOf(fake: FakePi): Pairing {
  const entry = latestBridge(fake);
  if (entry?.kind !== "pairing") {
    throw new Error("the session holds no pairing");
  }
  return entry;
}

/** A pairing entry a branch can be seeded with. */
function pairingData(session: string, posture: "delegate" | "consult" = "delegate"): unknown {
  return { kind: "pairing", session, conversation: CONVERSATION, token: TOKEN, posture };
}

/** Bind a fake pi to `daemon` with `/bridge pair delegate`; the connection it rode. */
async function pairWith(fake: FakePi, daemon: FakeDaemon): Promise<FakeConn> {
  await fake.command("bridge", "pair delegate");
  const conn = await daemon.nextConnection();
  expect(await conn.nextLine()).toEqual({ type: "pair", posture: "delegate", project: PROJECT });
  conn.reply({ type: "paired", conversation: CONVERSATION, token: TOKEN });
  await waitUntil(() => latestBridge(fake)?.kind === "pairing", "the pairing entry");
  return conn;
}

/** Every error notice the shell raised, in order. */
const errorNotices = (fake: FakePi): readonly Notified[] =>
  fake.notices.filter((notice) => notice.level === "error");

/** The status text the shell last set (`""` when it cleared the status). */
const lastStatus = (fake: FakePi): string => fake.statuses.at(-1)?.text ?? "";

/** Waits until the status shows outage attempt `attempt`: retries are visible only there. */
async function waitForAttempt(fake: FakePi, attempt: number): Promise<void> {
  const shown = String(attempt);
  await waitUntil(() => lastStatus(fake).includes(shown), `outage attempt ${shown} in the status`);
}

/** A writable that keeps what is written, readable as soon as the write returns. */
function sink(): { readonly stream: Writable; readonly text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(
      chunk: Buffer | string,
      _encoding: BufferEncoding,
      done: (error?: Error | null) => void,
    ): void {
      chunks.push(chunk.toString());
      done();
    },
  });
  return { stream, text: (): string => chunks.join("") };
}

/** The bridge entries the conversation holds, oldest first. */
async function bridgeEntriesOf(world: BridgeWorld, conversation: string): Promise<EntryRecord[]> {
  const of = await world.openDurable(conversation);
  const page = await of.entries({}, 100, undefined, context);
  return [...page.items].reverse().filter((entry) => entry.kind === BRIDGE_ENTRY_KIND);
}

/** The system prompt a `before_agent_start` handler returned, or a failure saying what it is. */
function systemPromptOf(value: unknown): string {
  if (!isRecord(value) || typeof value["systemPrompt"] !== "string") {
    throw new Error(`no systemPrompt in the handler's result: ${JSON.stringify(value)}`);
  }
  return value["systemPrompt"];
}

/** What the model was told as user input, in order. */
const inputsOf = (messages: readonly Message[]): string[] =>
  messages.map(userText).filter((text) => text !== "");

/** `work`, or a failure naming what the command printed when it finished first. */
async function unlessFinished<T>(work: Promise<T>, run: Promise<string>): Promise<T> {
  return Promise.race([
    work,
    run.then((text) => {
      throw new Error(`the command finished before this happened: ${text}`);
    }),
  ]);
}

afterEach(() => {
  vi.useRealTimers();
});

// --- VT-1 RV-021 F-3: every request frame has a reply deadline ----------------

describe("reply deadlines (VT-1 RV-021 F-3)", () => {
  beforeEach(fakeClocks);

  it("F-3: bridge_post resolves at BRIDGE_POST_WAIT_MS, not before, with outcome unknown", async () => {
    const daemon = await fakeDaemon();
    const fake = await piWith(daemon.path);
    const conn = await pairWith(fake, daemon);

    const call = fake.callTool("bridge_post", "tool-1", { text: "no answer" });
    expect(await conn.nextLine()).toEqual({
      type: "post",
      id: "tool-1",
      kind: "turn",
      text: "no answer",
    });
    let settled = false;
    void call.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(BRIDGE_POST_WAIT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await call;
    expect(resultOutcome(result)).toBe("unknown");
    expect(resultText(result)).toContain("outcome unknown");
  });

  it("F-3: an unanswered pair names the topic and closes the daemon's connection", async () => {
    const daemon = await fakeDaemon();
    const fake = await piWith(daemon.path);
    await fake.command("bridge", "pair delegate");
    const conn = await daemon.nextConnection();
    expect(await conn.nextLine()).toEqual({
      type: "pair",
      posture: "delegate",
      project: PROJECT,
    });

    await vi.advanceTimersByTimeAsync(BRIDGE_POST_WAIT_MS);
    const notice = only(errorNotices(fake));
    expect(notice.text).toContain("may have been created");
    expect(notice.text).toContain(`${PROJECT}-bridge`);
    await conn.closed;
  });

  it("F-3: an unanswered resume raises the outage notice and closes the connection", async () => {
    const daemon = await fakeDaemon();
    const fake = await piWith(daemon.path, {
      entries: [branchEntry(BRIDGE_CUSTOM_TYPE, pairingData(SESSION))],
    });
    const conn = await daemon.nextConnection();
    expect(await conn.nextLine()).toEqual({
      type: "resume",
      conversation: CONVERSATION,
      token: TOKEN,
    });

    await vi.advanceTimersByTimeAsync(BRIDGE_POST_WAIT_MS);
    const notice = only(errorNotices(fake));
    expect(notice.text).toContain(daemon.path);
    await conn.closed;
  });
});

// --- EX-2: what a bridge_post call resolves with -----------------------------

describe("bridge_post outcomes (EX-2)", () => {
  beforeEach(fakeClocks);

  it("EX-2: while unpaired it resolves at once with the outage text, naming the socket", async () => {
    const daemon = await fakeDaemon();
    const fake = await piWith(daemon.path);

    const result = await fake.callTool("bridge_post", "unbound", { text: "nowhere" });
    expect(resultOutcome(result)).toBe("not bound");
    expect(resultText(result)).toContain(daemon.path);
    expect(daemon.connections()).toHaveLength(0);
  });

  it("EX-2: a refused post resolves 'refused: <reason>' and an accepted one 'sent'", async () => {
    const daemon = await fakeDaemon();
    const fake = await piWith(daemon.path);
    const conn = await pairWith(fake, daemon);

    const refused = fake.callTool("bridge_post", "p-refused", { text: "no budget" });
    expect(await conn.nextLine()).toEqual({
      type: "post",
      id: "p-refused",
      kind: "turn",
      text: "no budget",
    });
    conn.reply({ type: "refused", id: "p-refused", reason: "budget exhausted" });
    expect(resultOutcome(await refused)).toBe("refused");
    expect(resultText(await refused)).toBe("refused: budget exhausted");

    const accepted = fake.callTool("bridge_post", "p-accepted", { text: "yes" });
    expect(await conn.nextLine()).toEqual({
      type: "post",
      id: "p-accepted",
      kind: "turn",
      text: "yes",
    });
    conn.reply({ type: "accepted", id: "p-accepted" });
    expect(resultOutcome(await accepted)).toBe("sent");
    expect(resultText(await accepted)).toBe("sent");
  });

  it("EX-2: a dropped post is resent with the same id after the retry, then resolves sent", async () => {
    const daemon = await fakeDaemon();
    const fake = await piWith(daemon.path);
    const conn = await pairWith(fake, daemon);

    const call = fake.callTool("bridge_post", "p-drop", { text: "resend me" });
    expect(await conn.nextLine()).toEqual({
      type: "post",
      id: "p-drop",
      kind: "turn",
      text: "resend me",
    });
    conn.end();
    await waitUntil(() => errorNotices(fake).length > 0, "the outage notice");
    await vi.advanceTimersByTimeAsync(retryDelayMs(1));

    const conn2 = await daemon.nextConnection();
    expect(await conn2.nextLine()).toEqual({
      type: "resume",
      conversation: CONVERSATION,
      token: TOKEN,
    });
    conn2.reply({ type: "paired", conversation: CONVERSATION });
    expect(await conn2.nextLine()).toEqual({
      type: "post",
      id: "p-drop",
      kind: "turn",
      text: "resend me",
    });
    conn2.reply({ type: "accepted", id: "p-drop" });
    expect(resultText(await call)).toBe("sent");
  });
});

// --- VT-2: failure is loud, retries are quiet, recovery is one notice --------

describe("loud failure and recovery (VT-2)", () => {
  beforeEach(fakeClocks);

  it("VT-2 outageText: the first failure notifies once, retries only show in the status, recovery notifies once", async () => {
    const { dir, cleanup } = await tempDir();
    onTestFinished(cleanup);
    // Nothing listens yet: every resume before the daemon opens is refused.
    const socketPath = join(dir, "bridge.sock");
    const fake = fakePi({
      sessionId: SESSION,
      cwd: await projectCwd(),
      entries: [branchEntry(BRIDGE_CUSTOM_TYPE, pairingData(SESSION))],
    });
    fake.load(extensionFor(fake, socketPath));
    await fake.startSession();

    await waitUntil(() => fake.notices.length > 0, "the first outage notice");
    const notice = only(errorNotices(fake));
    expect(notice.text).toContain(PROJECT);
    expect(notice.text).toContain(SESSION);
    expect(notice.text).toContain(CONVERSATION);
    expect(notice.text).toContain(socketPath);
    const desktop = only(fake.desktop);
    const desktopText = `${desktop.summary}\n${desktop.body}`;
    expect(desktopText).toContain(PROJECT);
    expect(desktopText).toContain(SESSION);
    expect(desktopText).toContain(CONVERSATION);
    expect(desktopText).toContain(socketPath);
    await waitForAttempt(fake, 1);

    // A failed retry: no new notice, no new desktop notification, the status shows the attempt.
    await vi.advanceTimersByTimeAsync(retryDelayMs(1));
    await waitForAttempt(fake, 2);
    expect(errorNotices(fake)).toHaveLength(1);
    expect(fake.desktop).toHaveLength(1);

    // Recovery: the daemon opens the path the resumes have been failing to reach.
    const daemon = await fakeDaemonAt(socketPath);
    await vi.advanceTimersByTimeAsync(retryDelayMs(2));
    const conn = await daemon.nextConnection();
    expect(await conn.nextLine()).toEqual({
      type: "resume",
      conversation: CONVERSATION,
      token: TOKEN,
    });
    conn.reply({ type: "paired", conversation: CONVERSATION });
    await waitUntil(
      () => fake.notices.some((raised) => raised.level === "info"),
      "the recovery notice",
    );
    expect(fake.notices.filter((raised) => raised.level === "info")).toHaveLength(1);
    expect(errorNotices(fake)).toHaveLength(1);
  });

  it("VT-2: a resume refused with a non-terminal reason notifies and never dials again", async () => {
    const daemon = await fakeDaemon();
    const fake = await piWith(daemon.path, {
      entries: [branchEntry(BRIDGE_CUSTOM_TYPE, pairingData(SESSION))],
    });
    const conn = await daemon.nextConnection();
    expect(await conn.nextLine()).toEqual({
      type: "resume",
      conversation: CONVERSATION,
      token: TOKEN,
    });

    conn.reply({ type: "refused", reason: "conversation is busy" });
    await waitUntil(() => errorNotices(fake).length > 0, "the refusal notice");
    expect(only(errorNotices(fake)).text).toContain("conversation is busy");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(daemon.connections()).toHaveLength(1);
    await conn.closed;
  });
});

// --- VT-4 RV-021 F-6: the bash spawn hook ------------------------------------

describe("spawnHook (VT-4 RV-021 F-6)", () => {
  it("bridgeEnv sets both variables, prepends the extension dir and changes nothing else", () => {
    const env = {
      PATH: "/usr/bin",
      HOME: "/home/operator",
      MALEBOLGE_BRIDGE_SOCKET: "/run/bridge.sock",
      MALEBOLGE_BRIDGE_CONVERSATION: "stale",
      MALEBOLGE_BRIDGE_TOKEN: "stale-token",
    };
    const out = bridgeEnv(env, { conversation: CONVERSATION, token: TOKEN }, "/ext");
    expect(out).toEqual({
      PATH: "/ext:/usr/bin",
      HOME: "/home/operator",
      MALEBOLGE_BRIDGE_SOCKET: "/run/bridge.sock",
      MALEBOLGE_BRIDGE_CONVERSATION: CONVERSATION,
      MALEBOLGE_BRIDGE_TOKEN: TOKEN,
    });
    // The caller's env is untouched: the hook hands bash a new one.
    expect(env.MALEBOLGE_BRIDGE_CONVERSATION).toBe("stale");
  });

  it("bridgeEnv removes inherited bridge variables when unpaired", () => {
    const out = bridgeEnv(
      {
        PATH: "/usr/bin",
        MALEBOLGE_BRIDGE_CONVERSATION: CONVERSATION,
        MALEBOLGE_BRIDGE_TOKEN: TOKEN,
      },
      null,
      "/ext",
    );
    expect(out).toEqual({ PATH: "/ext:/usr/bin" });
    expect(out).not.toHaveProperty("MALEBOLGE_BRIDGE_CONVERSATION");
    expect(out).not.toHaveProperty("MALEBOLGE_BRIDGE_TOKEN");
  });

  it("bridgeEnv prepends the extension dir when PATH is unset", () => {
    const out = bridgeEnv({}, { conversation: CONVERSATION, token: TOKEN }, "/ext");
    expect(out["PATH"]).toBe("/ext");
  });

  it("spawnHook PATH: while paired the bash tool sees the conversation and the token", async () => {
    const daemon = await fakeDaemon();
    const fake = await piWith(daemon.path);
    await pairWith(fake, daemon);

    expect((await fake.bash("printenv MALEBOLGE_BRIDGE_CONVERSATION")).trim()).toBe(CONVERSATION);
    // The token is set, but never printed: the test only asks whether it is there.
    expect((await fake.bash('test -n "$MALEBOLGE_BRIDGE_TOKEN" && echo set')).trim()).toBe("set");
  });

  it("spawnHook: after /bridge end the bash tool no longer sees the bridge env", async () => {
    const daemon = await fakeDaemon();
    const fake = await piWith(daemon.path);
    const conn = await pairWith(fake, daemon);

    await fake.command("bridge", "end");
    expect(await conn.nextLine()).toEqual({ type: "end" });
    conn.reply({ type: "refused", reason: "pairing ended" });
    await waitUntil(() => latestBridge(fake)?.kind === "unpaired", "the unpaired marker");

    // printenv finds nothing and exits 1; what matters is that no value is left.
    const output = await fake.bash("printenv MALEBOLGE_BRIDGE_CONVERSATION");
    expect(output).not.toContain(CONVERSATION);
    expect(output).not.toContain(TOKEN);
  });

  // Operator ruling 2026-10-30: /bridge end in an outage unpairs locally; no frame reaches the daemon.
  it("spawnHook: /bridge end during an outage unpairs locally, dials nothing and clears the env", async () => {
    const daemon = await fakeDaemon();
    const fake = await piWith(daemon.path);
    const conn = await pairWith(fake, daemon);
    conn.end();
    await waitUntil(() => errorNotices(fake).length > 0, "the outage notice");

    await fake.command("bridge", "end");
    expect(latestBridge(fake)?.kind).toBe("unpaired");
    expect(fake.notices.at(-1)?.level).toBe("info");
    expect(daemon.connections()).toHaveLength(1);
    expect(conn.lines()).not.toContainEqual({ type: "end" });
    const output = await fake.bash("printenv MALEBOLGE_BRIDGE_TOKEN");
    expect(output).not.toContain(TOKEN);
  });

  it("spawnHook PATH: malebolge-bridge resolves from another cwd and reaches the daemon", async () => {
    const daemon = await fakeDaemon();
    const elsewhere = await tempDir();
    onTestFinished(elsewhere.cleanup);
    const fake = await piWith(daemon.path);
    await pairWith(fake, daemon);

    // The child inherits pi's env: the socket path reaches the bare command from there.
    const previous = process.env["MALEBOLGE_BRIDGE_SOCKET"];
    process.env["MALEBOLGE_BRIDGE_SOCKET"] = daemon.path;
    try {
      const run = fake.bash(`cd ${elsewhere.dir} && echo hi | malebolge-bridge send`);
      const post = await unlessFinished(daemon.nextConnection(), run);
      expect(await post.nextLine()).toEqual({
        type: "post-once",
        conversation: CONVERSATION,
        token: TOKEN,
        kind: "note",
        text: "hi\n",
      });
      post.reply({ type: "accepted" });
      expect((await run).trim()).toBe("accepted");
    } finally {
      if (previous === undefined) {
        delete process.env["MALEBOLGE_BRIDGE_SOCKET"];
      } else {
        process.env["MALEBOLGE_BRIDGE_SOCKET"] = previous;
      }
    }
  });
});

// --- the operator's `!` commands: the same env as the bash tool --------------

describe("user_bash (VH-2 follow-up)", () => {
  it("user_bash: while paired an operator ! command sees the conversation and the token", async () => {
    const daemon = await fakeDaemon();
    const fake = await piWith(daemon.path);
    await pairWith(fake, daemon);

    expect((await fake.userBash("printenv MALEBOLGE_BRIDGE_CONVERSATION")).trim()).toBe(
      CONVERSATION,
    );
    expect((await fake.userBash('test -n "$MALEBOLGE_BRIDGE_TOKEN" && echo set')).trim()).toBe(
      "set",
    );
  });

  it("user_bash PATH: unpaired, an operator ! command still resolves bare malebolge-bridge", async () => {
    const daemon = await fakeDaemon();
    const fake = await piWith(daemon.path);

    expect((await fake.userBash("command -v malebolge-bridge")).trim()).toBe(
      join(BRIDGE_DIR, "malebolge-bridge"),
    );
    expect(await fake.userBash("printenv MALEBOLGE_BRIDGE_TOKEN")).toBe("");
  });
});

// --- the status as a powerbar segment: footer-replacing setups hide setStatus ---

describe("powerbar segment", () => {
  it("powerbar: the shell registers its segment at session start", async () => {
    const daemon = await fakeDaemon();
    const fake = await piWith(daemon.path);

    expect(fake.emitted).toContainEqual({
      channel: "powerbar:register-segment",
      data: { id: "malebolge-bridge", label: "malebolge bridge" },
    });
  });

  it("powerbar: every status, cleared ones too, is also a segment update with the same text", async () => {
    const daemon = await fakeDaemon();
    const fake = await piWith(daemon.path);
    const conn = await pairWith(fake, daemon);
    await fake.command("bridge", "end");
    expect(await conn.nextLine()).toEqual({ type: "end" });
    conn.reply({ type: "refused", reason: "pairing ended" });
    await waitUntil(() => latestBridge(fake)?.kind === "unpaired", "the unpaired marker");

    const updates = fake.emitted
      .filter((event) => event.channel === "powerbar:update")
      .map((event) => event.data);
    expect(updates).toEqual(
      fake.statuses.map((status) => ({ id: "malebolge-bridge", text: status.text })),
    );
    expect(updates.at(-1)).toEqual({ id: "malebolge-bridge", text: undefined });
  });
});

// --- EX-6: the posture in the system prompt ----------------------------------

describe("posture (EX-6)", () => {
  it("EX-6: a paired session's system prompt carries its posture's text and not the other's", async () => {
    const daemon = await fakeDaemon();
    const fake = await piWith(daemon.path);
    await pairWith(fake, daemon);

    const results = await fake.fire("before_agent_start", {
      type: "before_agent_start",
      systemPrompt: "BASE",
      systemPromptOptions: {},
      messageType: "user",
      prompt: "hello",
    });
    const systemPrompt = systemPromptOf(results[0]);
    expect(systemPrompt).toContain(PI_POSTURE_TEXT.delegate);
    expect(systemPrompt).not.toContain(PI_POSTURE_TEXT.consult);
  });

  it("EX-6: a resumed consult pairing carries the consult text", async () => {
    const daemon = await fakeDaemon();
    const fake = await piWith(daemon.path, {
      entries: [branchEntry(BRIDGE_CUSTOM_TYPE, pairingData(SESSION, "consult"))],
    });
    const conn = await daemon.nextConnection();
    expect(await conn.nextLine()).toEqual({
      type: "resume",
      conversation: CONVERSATION,
      token: TOKEN,
    });
    conn.reply({ type: "paired", conversation: CONVERSATION });

    const results = await fake.fire("before_agent_start", {
      type: "before_agent_start",
      systemPrompt: "BASE",
      systemPromptOptions: {},
      messageType: "user",
      prompt: "hello",
    });
    const systemPrompt = systemPromptOf(results[0]);
    expect(systemPrompt).toContain(PI_POSTURE_TEXT.consult);
    expect(systemPrompt).not.toContain(PI_POSTURE_TEXT.delegate);
  });

  it("EX-6: an unpaired session's before_agent_start returns no system prompt", async () => {
    const daemon = await fakeDaemon();
    const fake = await piWith(daemon.path);

    const results = await fake.fire("before_agent_start", {
      type: "before_agent_start",
      systemPrompt: "BASE",
      systemPromptOptions: {},
      messageType: "user",
      prompt: "hello",
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toBeUndefined();
  });
});

// --- the delivery rules (DEC-090) --------------------------------------------

describe("delivery on the fake daemon", () => {
  it("a note while idle is injected at once with triggerTurn false, then acked", async () => {
    const daemon = await fakeDaemon();
    const fake = await piWith(daemon.path);
    const conn = await pairWith(fake, daemon);
    fake.setIdle(true);

    conn.reply({ type: "deliver", seq: 1, kind: "note", text: "a note" });
    await waitUntil(() => fake.messages.length === 1, "the injected note");
    const sent = only(fake.messages);
    expect(sent.message.customType).toBe(BRIDGE_CUSTOM_TYPE);
    expect(sent.message.content).toBe("a note");
    expect(sent.message.display).toBe(true);
    expect(sent.message.details).toEqual({ pairing: CONVERSATION, seq: 1 });
    expect(sent.options.triggerTurn).toBe(false);
    expect(await conn.nextLine()).toEqual({ type: "ack", seq: 1 });
  });

  it("only an interactive input refills the budget", async () => {
    const daemon = await fakeDaemon();
    const fake = await piWith(daemon.path);
    const conn = await pairWith(fake, daemon);

    await fake.fire("input", { type: "input", text: "from rpc", source: "rpc" });
    await fake.fire("input", { type: "input", text: "from code", source: "extension" });
    await fake.fire("input", { type: "input", text: "typed", source: "interactive" });
    expect(await conn.nextLine()).toEqual({ type: "refill" });
    expect(conn.lines().filter((line) => isRecord(line) && line["type"] === "refill")).toHaveLength(
      1,
    );
  });

  it("a turn is injected as a turn and acked only once the turn has run", async () => {
    const daemon = await fakeDaemon();
    const fake = await piWith(daemon.path);
    const conn = await pairWith(fake, daemon);
    fake.setIdle(true);

    conn.reply({ type: "deliver", seq: 2, kind: "turn", text: "a turn" });
    await waitUntil(() => fake.messages.length === 1, "the injected turn");
    const sent = only(fake.messages);
    expect(sent.options.triggerTurn).toBe(true);
    expect(sent.message.details).toEqual({ pairing: CONVERSATION, seq: 2 });
    // The message is held for a turn that has not run: no entry, so no ack.
    expect(conn.lines()).toHaveLength(1);

    await fake.runTurn();
    expect(await conn.nextLine()).toEqual({ type: "ack", seq: 2 });
  });

  it("a delivery while pi is not idle waits for agent_settled", async () => {
    const daemon = await fakeDaemon();
    const fake = await piWith(daemon.path);
    const conn = await pairWith(fake, daemon);
    fake.setIdle(false);

    conn.reply({ type: "deliver", seq: 3, kind: "note", text: "buffered" });
    // A refused frame the shell must report orders the test after the delivery:
    // when the notice lands, the deliver has been handled.
    conn.reply({ type: "refused", reason: "sync marker" });
    await waitUntil(
      () => fake.notices.some((raised) => raised.text.includes("sync marker")),
      "the sync marker notice",
    );
    expect(fake.messages).toHaveLength(0);

    await fake.fire("agent_settled", { type: "agent_settled", aborted: false });
    await waitUntil(() => fake.messages.length === 1, "the flushed note");
    const sent = only(fake.messages);
    expect(sent.message.content).toBe("buffered");
    expect(sent.options.triggerTurn).toBe(false);
    expect(await conn.nextLine()).toEqual({ type: "ack", seq: 3 });
  });
});

// --- VT-5: end to end over the real listener ---------------------------------

/** The world's bridge, with the extension's fake pi loaded and started. */
interface E2e {
  readonly world: BridgeWorld;
  readonly fake: FakePi;
  readonly cwd: string;
}

/** A real listener world plus a fake pi over its socket. */
async function e2eWorld(entries: readonly SessionEntry[] = []): Promise<E2e> {
  const world = await bridgeWorld();
  const cwd = await projectCwd();
  const fake = fakePi({ sessionId: SESSION, cwd, ...(entries.length === 0 ? {} : { entries }) });
  fake.load(extensionFor(fake, world.socketPath));
  await fake.startSession();
  return { world, fake, cwd };
}

/** `/bridge pair delegate` against the world's daemon; the pairing the session stored. */
async function bindWorld(fake: FakePi): Promise<Pairing> {
  await fake.command("bridge", "pair delegate");
  await vi.waitFor(() => {
    expect(latestBridge(fake)?.kind).toBe("pairing");
  }, WAIT);
  return pairingOf(fake);
}

describe("end to end over the real listener (VT-5)", () => {
  it("VT-5 sent: pair binds, bridge_post is sent to SATAN, and the command posts a note", async () => {
    const { world, fake, cwd } = await e2eWorld();
    const turns = recordedTurn();
    world.test.faux.setResponses([turns.step]);
    const pairing = await bindWorld(fake);
    expect(pairing.posture).toBe("delegate");

    const posted = await fake.callTool("bridge_post", "t1", { text: "hello" });
    expect(resultOutcome(posted)).toBe("sent");
    await vi.waitFor(() => {
      expect(world.test.faux.state.callCount).toBe(1);
    }, WAIT);
    expect(inputsOf(only(turns.seen))).toEqual([
      '<bridge from="pi" project="proj" kind="turn">hello</bridge>',
    ]);

    const out = sink();
    const err = sink();
    const exit = await runCommand({
      argv: ["send"],
      stdin: Readable.from(["from the command"]),
      stdout: out.stream,
      stderr: err.stream,
      env: {
        MALEBOLGE_BRIDGE_SOCKET: world.socketPath,
        MALEBOLGE_BRIDGE_CONVERSATION: pairing.conversation,
        MALEBOLGE_BRIDGE_TOKEN: pairing.token,
      },
      cwd,
      notifyDesktop: fake.notifyDesktop,
    });
    expect(exit).toBe(EXIT.accepted);
    expect(out.text()).toBe("accepted\n");
    await vi.waitFor(async () => {
      const data = (await bridgeEntriesOf(world, pairing.conversation)).map((entry) => entry.data);
      expect(data).toContainEqual({ kind: "note", project: PROJECT });
    }, WAIT);
  });

  it("VT-5 deliver: SATAN's outbox reaches pi as a note and a turn, and is acked", async () => {
    const { world, fake } = await e2eWorld();
    const conversation = (await bindWorld(fake)).conversation;
    const before = (await world.pairingOf(conversation)).nextSeq;
    await world.updatePairing(conversation, (doc) => {
      appendOutbox(doc, "note", "satan's note");
      appendOutbox(doc, "turn", "satan's turn");
    });
    const noteSeq = before;
    const turnSeq = before + 1;

    await vi.waitFor(() => {
      expect(fake.messages).toHaveLength(2);
    }, WAIT);
    expect(fake.messages[0]?.options.triggerTurn).toBe(false);
    expect(fake.messages[0]?.message.content).toBe("satan's note");
    expect(fake.messages[0]?.message.details).toEqual({ pairing: conversation, seq: noteSeq });
    expect(fake.messages[1]?.options.triggerTurn).toBe(true);
    expect(fake.messages[1]?.message.content).toBe("satan's turn");

    // The note is acked at once; the turn's ack waits for the turn it starts.
    await vi.waitFor(async () => {
      expect((await world.pairingOf(conversation)).outbox.map((entry) => entry.seq)).toEqual([
        turnSeq,
      ]);
    }, WAIT);
    await fake.runTurn();
    await vi.waitFor(async () => {
      expect((await world.pairingOf(conversation)).outbox).toEqual([]);
    }, WAIT);
  });

  it("VT-5 re-ack: a message the session already holds is re-acked, never injected again", async () => {
    const world = await bridgeWorld();
    const cwd = await projectCwd();
    const first = await world.pair("delegate", PROJECT);
    first.client.close();
    await first.client.closed;
    const conversation = first.conversation;

    // An entry SATAN wrote while pi was away: still in the outbox, unacked.
    const unacked = (await world.pairingOf(conversation)).nextSeq;
    await world.updatePairing(conversation, (doc) => {
      appendOutbox(doc, "note", "already in the session");
    });

    const fake = fakePi({
      sessionId: SESSION,
      cwd,
      entries: [
        branchEntry(BRIDGE_CUSTOM_TYPE, {
          kind: "pairing",
          session: SESSION,
          conversation,
          token: first.token,
          posture: "delegate",
        }),
        branchMessage(BRIDGE_CUSTOM_TYPE, "already in the session", {
          pairing: conversation,
          seq: unacked,
        }),
      ],
    });
    fake.load(extensionFor(fake, world.socketPath));
    await fake.startSession();

    await vi.waitFor(async () => {
      expect((await world.pairingOf(conversation)).outbox).toEqual([]);
    }, WAIT);
    expect(fake.messages).toHaveLength(0);
  });
});
