import { chmod } from "node:fs/promises";
import type { Socket } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import {
  attach,
  type AttachOptions,
  attachTargetOf,
  commandOf,
  UsageError,
} from "../src/attach.ts";
import { context } from "../src/context.ts";
import { conversations } from "../src/conversations.ts";
import { type Daemon, serve } from "../src/daemon.ts";
import { type AttachTarget, parseClientMessage } from "../src/protocol.ts";
import { type ConnectWait, serveUnix } from "../src/unix-socket.ts";
import { encodeLine, lineSplitter } from "../src/ndjson.ts";
import { messageOf } from "../src/message-of.ts";
import {
  type Recorder,
  recorder,
  rejection,
  socketPath,
  staleSocket,
  tempDir,
} from "./fixtures.ts";
import { FAUX_MODEL, openTestHarness, type TestHarness } from "./harness-fixture.ts";

describe("attachTargetOf", () => {
  it.each<[string[], AttachTarget]>([
    [[], { kind: "root" }],
    [["--conversation", "3"], { kind: "existing", id: 3 }],
    [["--conversation=3"], { kind: "existing", id: 3 }],
    [["--new"], { kind: "new" }],
    [["--new", "--cwd", "/tmp/a b"], { kind: "new", cwd: "/tmp/a b" }],
    [["--new", "--cwd", ""], { kind: "new", cwd: "" }],
  ])("%j → %j", (args, target) => {
    expect(attachTargetOf(args)).toEqual(target);
  });

  it.each<string[][]>([
    [["--conversation", "3", "--new"]],
    [["--cwd", "/x"]],
    [["--conversation", "0"]],
    [["--conversation=-1"]],
    [["--conversation", "1.5"]],
    [["--conversation", "1e3"]],
    [["--conversation", "9007199254740992"]],
    [["--wat"]],
    [["x"]],
    [["--conversation"]],
    [["--new", "--cwd"]],
  ])("%j is a usage error", (args) => {
    expect(() => attachTargetOf(args)).toThrow(UsageError);
  });
});

describe("commandOf", () => {
  it.each([
    ["hello", { type: "input", content: "hello" }],
    ["  /abort ", { type: "abort" }],
    ["/compact", { type: "compact" }],
    ["/compact keep names", { type: "compact", instructions: "keep names" }],
    ["/quit", "quit"],
    ["   ", undefined],
  ])("%j → %j", (line, command) => {
    expect(commandOf(line)).toEqual(command);
  });
});

interface Session {
  input: PassThrough;
  done: Promise<void>;
  /** Resolves once the client has printed `text`. */
  until: (text: string) => Promise<void>;
  printed: () => string;
}

/** The daemon over `test`, on `path`, with the tests' creation defaults. */
const serveTest = (test: TestHarness, path: string): Promise<Daemon> =>
  serve({
    socketPath: path,
    conversations: Promise.resolve(conversations(test, { model: FAUX_MODEL, cwd: process.cwd() })),
    beforeInput: () => Promise.resolve(),
  });

/** An attach client of `path`, collecting what it prints. */
const session = (path: string, options: AttachOptions = {}): Session => {
  const [input, output] = [new PassThrough(), new PassThrough()];
  output.setEncoding("utf8");
  let printed = "";
  output.on("data", (chunk: string) => {
    printed += chunk;
  });
  const done = attach(path, input, output, options);
  const until = (text: string): Promise<void> =>
    new Promise<void>((resolve) => {
      const check = (): void => {
        if (printed.includes(text)) {
          resolve();
        }
      };
      output.on("data", check);
      check();
    });
  return { input, done, until, printed: () => printed };
};

describe("attach: frame and connected banner", () => {
  it.each<[AttachTarget, unknown]>([
    [{ kind: "root" }, { type: "attach" }],
    [
      { kind: "existing", id: 3 },
      { type: "attach", conversation: 3 },
    ],
    [{ kind: "new" }, { type: "attach", new: true }],
    [
      { kind: "new", cwd: "/tmp/a b" },
      { type: "attach", new: true, cwd: "/tmp/a b" },
    ],
  ])("sends %j", async (target, frame) => {
    const path = await socketPath();
    const fake = await fakeDaemon(path);
    const s = session(path, { target });
    await s.until("[connected]\n");
    const line = await fake.lines.next(() => true);
    expect(JSON.parse(line)).toEqual(frame);
    expect(s.printed().startsWith("[connected]\n")).toBe(true);
    s.input.end();
    await s.done;
  });
});

describe("attach: leaves before attached", () => {
  it("resolves when the user quits before attached", async () => {
    const path = await socketPath();
    await fakeDaemon(path);
    const s = session(path);
    await s.until("[connected]\n");
    s.input.write("/quit\n");
    await s.done;
    expect(s.printed()).toContain("[detached]");
  });

  it("resolves when input ends before attached", async () => {
    const path = await socketPath();
    await fakeDaemon(path);
    const s = session(path);
    await s.until("[connected]\n");
    s.input.end();
    await s.done;
    expect(s.printed()).toContain("[detached]");
  });
});

describe("attach: failures before attached", () => {
  it("rejects when the daemon reports an error before attached", async () => {
    const path = await socketPath();
    const fake = await fakeDaemon(path);
    const s = session(path);
    await s.until("[connected]\n");
    await fake.lines.next((line) => line.includes('"attach"'));
    s.input.write("held\n");
    fake.send({ type: "error", message: "attach: conversation and new are exclusive" });
    await s.until("[error: attach: conversation and new are exclusive]\n");
    // A late attached must not flush the discarded line.
    fake.send({ type: "attached", conversation: 7 });
    s.input.end();
    expect(await rejection(s.done)).toMatchObject({ code: "NOT_ATTACHED" });
    await fake.closed;
    expect(s.printed()).not.toContain("[detached]");
    expect(fake.lines.items).toHaveLength(1);
  });

  it("rejects when the daemon closes before attached", async () => {
    const path = await socketPath();
    const fake = await fakeDaemon(path);
    const s = session(path);
    await s.until("[connected]\n");
    await fake.lines.next((line) => line.includes('"attach"'));
    fake.destroy();
    expect(await rejection(s.done)).toMatchObject({ code: "NOT_ATTACHED" });
    expect(s.printed()).toContain("[the daemon closed before attach completed]\n");
    expect(s.printed()).not.toContain("[detached]");
  });
});

describe("attach: version skew", () => {
  it("prints the restart hint when the daemon predates attach", async () => {
    const path = await socketPath();
    const skew = skewOf();
    const fake = await fakeDaemon(path, (socket) => {
      socket.write(
        encodeLine({
          type: "snapshot",
          entries: [{ kind: "pi.user", model: [{ role: "user", content: "earlier" }] }],
        }),
      );
      socket.write(encodeLine({ type: "error", message: skew }));
    });
    const s = session(path);
    expect(await rejection(s.done)).toMatchObject({ code: "NOT_ATTACHED" });
    const text = s.printed();
    const order = [
      "[connected]\n",
      "» earlier\n",
      `[error: ${skew}]\n`,
      "[the daemon predates attach: restart it (malebolge-stop, then malebolge-start)]\n",
    ];
    let at = -1;
    for (const piece of order) {
      const found = text.indexOf(piece, at + 1);
      expect(found).toBeGreaterThan(at);
      at = found;
    }
    expect(text).not.toContain("[detached]");
    expect(fake.lines.items).toHaveLength(1);
  });
});

describe("attach: holds typed lines until attached", () => {
  it("does not send typed lines before the daemon announces the conversation", async () => {
    const path = await socketPath();
    const fake = await fakeDaemon(path);
    const s = session(path);
    await s.until("[connected]\n");
    await fake.lines.next((line) => line.includes('"attach"'));
    s.input.write("one\n");
    s.input.write("two\n");
    s.input.write("/quit\n");
    await s.done;
    expect(fake.lines.items).toHaveLength(1);
    expect(s.printed()).toContain("[detached]");
  });

  it("renders events before attached as they arrive", async () => {
    const path = await socketPath();
    const fake = await fakeDaemon(path, (socket) => {
      socket.write(
        encodeLine({
          type: "snapshot",
          entries: [{ kind: "pi.user", model: [{ role: "user", content: "earlier" }] }],
        }),
      );
    });
    const s = session(path);
    await s.until("» earlier\n");
    expect(s.printed()).not.toContain("[attached to conversation");
    fake.send({ type: "attached", conversation: 7 });
    await s.until("[attached to conversation 7]\n");
    expect(s.printed().indexOf("» earlier\n")).toBeLessThan(
      s.printed().indexOf("[attached to conversation 7]\n"),
    );
    s.input.end();
    await s.done;
  });

  it("sends held lines in order once the daemon announces the conversation", async () => {
    const path = await socketPath();
    const fake = await fakeDaemon(path);
    const s = session(path);
    await s.until("[connected]\n");
    await fake.lines.next((line) => line.includes('"attach"'));
    s.input.write("one\n");
    s.input.write("two\n");
    fake.send({ type: "attached", conversation: 7 });
    fake.send({ type: "snapshot", entries: [] });
    await s.until("[attached to conversation 7]\n");
    await fake.lines.next((line) => line.includes('"two"'));
    expect(fake.lines.items.slice(1)).toEqual([
      JSON.stringify({ type: "input", content: "one" }),
      JSON.stringify({ type: "input", content: "two" }),
    ]);
    s.input.end();
    await s.done;
  });
});

describe("attach: after attached", () => {
  it("sends typed lines directly once attached", async () => {
    const path = await socketPath();
    const fake = await fakeDaemon(path);
    const s = session(path);
    await s.until("[connected]\n");
    await fake.lines.next((line) => line.includes('"attach"'));
    fake.send({ type: "attached", conversation: 7 });
    await s.until("[attached to conversation 7]\n");
    s.input.write("after\n");
    await fake.lines.next((line) => line.includes('"after"'));
    expect(fake.lines.items.slice(1)).toEqual([
      JSON.stringify({ type: "input", content: "after" }),
    ]);
    s.input.end();
    await s.done;
  });

  it("prints an error after attached and stays attached", async () => {
    const path = await socketPath();
    const fake = await fakeDaemon(path);
    const s = session(path);
    await s.until("[connected]\n");
    await fake.lines.next((line) => line.includes('"attach"'));
    fake.send({ type: "attached", conversation: 7 });
    await s.until("[attached to conversation 7]\n");
    fake.send({ type: "error", message: "boom" });
    await s.until("[error: boom]\n");
    s.input.write("still here\n");
    await fake.lines.next((line) => line.includes("still here"));
    s.input.write("/quit\n");
    await s.done;
    expect(s.printed()).toContain("[detached]");
  });
});

describe("attach", () => {
  let cleanup: () => Promise<void>;
  let test: TestHarness;
  let daemon: Daemon;
  let path: string;

  beforeEach(async () => {
    const tmp = await tempDir();
    cleanup = tmp.cleanup;
    path = join(tmp.dir, "durable.sock");
    test = await openTestHarness([]);
    daemon = await serveTest(test, path);
  });

  afterEach(async () => {
    await daemon.close();
    await test.harness.close(context);
    await cleanup();
  });

  it("sends typed lines as input and prints the answer", async () => {
    test.faux.setResponses([fauxAssistantMessage([fauxText("hello back")])]);
    const s = session(path);
    s.input.write("hello\n");
    await s.until("hello back\n");
    s.input.write("/quit\n");
    await s.done;
  });

  it("shows the transcript so far on attach", async () => {
    test.faux.setResponses([fauxAssistantMessage([fauxText("earlier answer")])]);
    await (await test.root.submit({ type: "input", content: "earlier" }, context)).wait(context);
    const s = session(path);
    await s.until("» earlier\nearlier answer\n");
    s.input.end();
    await s.done;
  });

  it("rejects a refused attach from the real daemon and submits nothing", async () => {
    const s = session(path, { target: { kind: "existing", id: 999_999 } });
    await s.until("[connected]\n");
    s.input.write("held\n");
    await s.until("[error: no conversation 999999]\n");
    s.input.end();
    expect(await rejection(s.done)).toMatchObject({ code: "NOT_ATTACHED" });
    expect(s.printed()).not.toContain("[detached]");
    expect(test.faux.state.callCount).toBe(0);
  });

  it("ends when the daemon goes away", async () => {
    const s = session(path);
    await s.until(`[attached to conversation ${String(test.root.id)}]\n`);
    await daemon.close();
    await s.done;
    expect(s.printed()).toContain("[detached]");
  });

  describe("with an answer streamed in many commits", () => {
    // Slow enough to span several 100 ms progress commits, so the client sees
    // what a real provider produces: message_start carrying a partial, deltas,
    // and a tail that only the final entry at message_end holds.
    const answer = Array.from({ length: 12 }, (_, i) => `w${String(i)}`).join(" ");

    beforeEach(async () => {
      await daemon.close();
      await test.harness.close(context);
      test = await openTestHarness([], { tokensPerSecond: 40, tokenSize: { min: 1, max: 1 } });
      test.faux.setResponses([fauxAssistantMessage([fauxText(answer)])]);
      daemon = await serveTest(test, path);
    });

    it("prints the answer once, with nothing else", async () => {
      const s = session(path);
      await s.until("[connected]\n");
      s.input.write("go\n");
      await s.until(`${answer}\n`);
      expect(s.printed()).toBe(
        `[connected]\n[attached to conversation ${String(test.root.id)}]\n${answer}\n`,
      );
      s.input.end();
      await s.done;
    });

    it("prints it exactly once for a client that attaches mid-answer", async () => {
      await test.root.submit({ type: "input", content: "go" }, context);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const s = session(path);
      await s.until(`${answer}\n`);
      expect(s.printed()).toBe(
        `[connected]\n[attached to conversation ${String(test.root.id)}]\n» go\n${answer}\n`,
      );
      s.input.end();
      await s.done;
    });
  });
});

describe("attach: waits for the daemon (design §4.2)", () => {
  const harnessAt = async (path: string): Promise<void> => {
    const test = await openTestHarness([]);
    onTestFinished(() => test.harness.close(context));
    const daemon = await serveTest(test, path);
    onTestFinished(daemon.close);
  };

  /** One attach attempt to `path`, with nothing written to its stream. */
  const attempt = (path: string, wait: ConnectWait): Promise<void> =>
    attach(path, new PassThrough(), new PassThrough(), { wait });

  it("waits for a daemon that has not started yet (ENOENT)", async () => {
    const path = await socketPath();
    const s = session(path);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await harnessAt(path);
    await s.until("[connected]\n");
    s.input.end();
    await s.done;
  });

  it("waits for a stale socket to be replaced (ECONNREFUSED)", async () => {
    const path = await socketPath();
    await staleSocket(path);
    const s = session(path);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await harnessAt(path);
    await s.until("[connected]\n");
    s.input.end();
    await s.done;
  });

  it("gives up with the last error once the bound is spent", async () => {
    const path = await socketPath();
    const wait = { intervalMs: 20, timeoutMs: 100 };
    expect(await rejection(attempt(path, wait))).toMatchObject({ code: "ENOENT" });
    await staleSocket(path);
    expect(await rejection(attempt(path, wait))).toMatchObject({ code: "ECONNREFUSED" });
  });

  it("says why when it gives up, naming the socket and the error", async () => {
    const path = await socketPath();
    const s = session(path, { wait: { intervalMs: 20, timeoutMs: 100 } });
    expect(await rejection(s.done)).toMatchObject({ code: "ENOENT" });
    expect(s.printed()).toBe(`[cannot connect to ${path}: ENOENT]\n`);
  });

  it("fails at once on an error other than ENOENT/ECONNREFUSED", async () => {
    const path = await socketPath();
    const server = await serveUnix(path, () => undefined);
    onTestFinished(server.close);
    await chmod(path, 0o000);
    const started = Date.now();
    expect(await rejection(attempt(path, { intervalMs: 20, timeoutMs: 5_000 }))).toMatchObject({
      code: "EACCES",
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

interface FakeDaemon {
  lines: Recorder<string>;
  send: (value: unknown) => void;
  destroy: () => void;
  closed: Promise<void>;
}

const skewOf = (): string => {
  try {
    parseClientMessage('{"type":"attach"}');
  } catch (error) {
    return messageOf(error);
  }
  throw new Error("parseClientMessage accepted attach");
};

/** A raw NDJSON daemon at `path`, recording what the client sends. */
const fakeDaemon = async (
  path: string,
  onConnect?: (socket: Socket) => void,
): Promise<FakeDaemon> => {
  const lines = recorder<string>();
  let accepted: Socket | undefined;
  let markClosed = (): void => undefined;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  const server = await serveUnix(path, (socket) => {
    accepted = socket;
    socket.on("close", () => {
      markClosed();
    });
    socket.on(
      "data",
      lineSplitter((line) => {
        lines.push(line);
      }),
    );
    onConnect?.(socket);
  });
  onTestFinished(server.close);
  return {
    lines,
    send: (value): void => {
      accepted?.write(encodeLine(value));
    },
    destroy: (): void => {
      accepted?.destroy();
    },
    closed,
  };
};
