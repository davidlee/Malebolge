import { chmod } from "node:fs/promises";
import type { Socket } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import {
  attach,
  type AttachOptions,
  attachInvocationOf,
  attachTargetOf,
  commandOf,
  listConversations,
  NotListedError,
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

/** What a listing client wrote to each of its two streams, and its completion. */
interface Listing {
  done: Promise<void>;
  printed: () => string;
  errors: () => string;
}

/** A listing client of `path`: ids on stdout, prose on stderr. */
const listing = (path: string, wait: ConnectWait): Listing => {
  const [output, errors] = [new PassThrough(), new PassThrough()];
  const [printed, errorText] = [collect(output), collect(errors)];
  return { done: listConversations(path, output, errors, wait), printed, errors: errorText };
};

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
    conversations: Promise.resolve(
      conversations(test, { model: FAUX_MODEL, cwd: process.cwd() }, "host"),
    ),
    beforeInput: () => Promise.resolve(),
  });

/** A stream's text as it arrives; the reader answers with what has arrived so far. */
const collect = (stream: PassThrough): (() => string) => {
  stream.setEncoding("utf8");
  let text = "";
  stream.on("data", (chunk: string) => {
    text += chunk;
  });
  return () => text;
};

/** An attach client of `path`, collecting what it prints. */
const session = (path: string, options: AttachOptions = {}): Session => {
  const [input, output] = [new PassThrough(), new PassThrough()];
  const printed = collect(output);
  const done = attach(path, input, output, options);
  const until = (text: string): Promise<void> =>
    new Promise<void>((resolve) => {
      const check = (): void => {
        if (printed().includes(text)) {
          resolve();
        }
      };
      output.on("data", check);
      check();
    });
  return { input, done, until, printed };
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

/** The message a daemon that predates `frame` answers a `frame` first line with. */
const skewOf = (frame = "attach"): string => {
  try {
    parseClientMessage(JSON.stringify({ type: frame }));
  } catch (error) {
    return messageOf(error);
  }
  throw new Error(`parseClientMessage accepted ${frame}`);
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

// ---------------------------------------------------------------------------
// PHASE-02 (SL-001): frame input mode and Emacs presentation.
//
// Assumed API (not yet implemented in src/attach.ts):
//   attachInvocationOf(argv) -> {
//     target: AttachTarget,
//     inputMode: "lines" | "frames",
//     presentation: "terminal" | "emacs",
//   }
//     Strict: the parse errors of `parseAttachArgs` still throw `UsageError`.
//     `--emacs` selects frames + emacs; it composes with `--conversation N`
//     and `--new --cwd D`. `attachTargetOf` keeps working (may delegate).
//   attach(socketPath, input, output, { target, wait, inputMode, presentation })
//     A frame-mode stdin line is one JSON frame, forwarded unchanged as exactly
//     one socket message; `{"type":"quit"}` is local and never sent.
//   Client-local notices all go through the renderer: one shared client path.
//   In emacs presentation a client notice is one line starting "[status] ".
// ---------------------------------------------------------------------------

/** A frame-mode attach session: typed lines become JSON frames. */
const frameSession = (path: string, options: AttachOptions = {}): Session =>
  session(path, { ...options, inputMode: "frames", presentation: "emacs" });

/**
 * An attach session bound to `path` with a fake daemon already listening.
 * The emacs presentation frames notices as status lines, so the waits match it.
 */
const attachedSession = async (
  options: AttachOptions = {},
): Promise<{ path: string; fake: FakeDaemon; s: Session }> => {
  const path = await socketPath();
  const fake = await fakeDaemon(path);
  const s = session(path, options);
  await s.until("[status] connected\n");
  await fake.lines.next((line) => line.includes('"attach"'));
  fake.send({ type: "attached", conversation: 7 });
  await s.until("[status] attached to conversation 7\n");
  return { path, fake, s };
};

describe("attachInvocationOf", () => {
  it.each<[string[], unknown]>([
    [[], { target: { kind: "root" }, inputMode: "lines", presentation: "terminal" }],
    [["--emacs"], { target: { kind: "root" }, inputMode: "frames", presentation: "emacs" }],
    [
      ["--emacs", "--conversation", "3"],
      { target: { kind: "existing", id: 3 }, inputMode: "frames", presentation: "emacs" },
    ],
    [
      ["--emacs", "--new", "--cwd", "/x"],
      { target: { kind: "new", cwd: "/x" }, inputMode: "frames", presentation: "emacs" },
    ],
  ])("%j → %j", (args, invocation) => {
    expect(attachInvocationOf(args)).toEqual(invocation);
  });

  it("still refuses an unknown flag", () => {
    expect(() => attachInvocationOf(["--emacs", "--wat"])).toThrow(UsageError);
  });
});

describe("--list", () => {
  it("refuses --list combined with an attach flag as a UsageError", () => {
    for (const args of [
      ["--list", "--conversation", "3"],
      ["--list", "--new"],
      ["--list", "--new", "--cwd", "/x"],
      ["--list", "--cwd", "/x"],
      ["--list", "--emacs"],
      ["--emacs", "--list"],
    ]) {
      expect(() => attachInvocationOf(args)).toThrow(UsageError);
    }
    // It names no attach target either, so that parse refuses it too.
    expect(() => attachTargetOf(["--list"])).toThrow(UsageError);
  });

  it("is a list invocation on its own LIST_WAIT, not the attach wait", () => {
    expect(attachInvocationOf(["--list"])).toEqual({
      mode: "list",
      wait: { intervalMs: 200, timeoutMs: 1_000 },
    });
  });
});

describe("attach: frame input mode", () => {
  it("sends a draft with newlines and a slash line as one input message", async () => {
    const { fake, s } = await attachedSession({ inputMode: "frames", presentation: "emacs" });
    const content = "  lead\n\n/slash line\ntrail  ";
    s.input.write(`${JSON.stringify({ type: "input", content })}\n`);
    await fake.lines.next((line) => line.includes('"input"'));
    expect(fake.lines.items.slice(1)).toEqual([JSON.stringify({ type: "input", content })]);
    s.input.write('{"type":"quit"}\n');
    await s.done;
  });

  it("forwards abort and compact unchanged", async () => {
    const { fake, s } = await attachedSession({ inputMode: "frames", presentation: "emacs" });
    s.input.write('{"type":"abort"}\n');
    s.input.write('{"type":"compact"}\n');
    s.input.write('{"type":"compact","instructions":"keep names"}\n');
    await fake.lines.next((line) => line.includes("keep names"));
    expect(fake.lines.items.slice(1)).toEqual([
      JSON.stringify({ type: "abort" }),
      JSON.stringify({ type: "compact" }),
      JSON.stringify({ type: "compact", instructions: "keep names" }),
    ]);
    s.input.write('{"type":"quit"}\n');
    await s.done;
  });

  it("detaches on quit without sending it", async () => {
    const { fake, s } = await attachedSession({ inputMode: "frames", presentation: "emacs" });
    s.input.write('{"type":"quit"}\n');
    await s.done;
    expect(fake.lines.items).toHaveLength(1);
    expect(s.printed()).not.toContain("quit");
    expect(s.printed()).toContain("[status] detached");
  });

  it("holds frames until attached, then sends them in order", async () => {
    const path = await socketPath();
    const fake = await fakeDaemon(path);
    const s = frameSession(path);
    await s.until("[status] connected");
    await fake.lines.next((line) => line.includes('"attach"'));
    s.input.write('{"type":"input","content":"one"}\n');
    s.input.write('{"type":"input","content":"two"}\n');
    fake.send({ type: "attached", conversation: 7 });
    await s.until("[status] attached to conversation 7");
    await fake.lines.next((line) => line.includes('"two"'));
    expect(fake.lines.items.slice(1)).toEqual([
      JSON.stringify({ type: "input", content: "one" }),
      JSON.stringify({ type: "input", content: "two" }),
    ]);
    s.input.write('{"type":"quit"}\n');
    await s.done;
  });

  it.each<[string, string]>([
    ["malformed JSON", "{not json"],
    ["an unknown type", '{"type":"wat"}'],
    ["a wrong field type", '{"type":"input","content":3}'],
    ["an extra field", '{"type":"abort","extra":1}'],
    ["an extra field on quit", '{"type":"quit","extra":1}'],
    ["a prototype key as type", '{"type":"constructor"}'],
    ["__proto__ as type", '{"type":"__proto__"}'],
  ])("sends nothing and notices on %s", async (_name, line) => {
    const { fake, s } = await attachedSession({ inputMode: "frames", presentation: "emacs" });
    s.input.write(`${line}\n`);
    await s.until("[status] ");
    expect(fake.lines.items).toHaveLength(1);
    const statusLines = s
      .printed()
      .split("\n")
      .filter((l) => l.startsWith("[status] "));
    expect(statusLines.length).toBeGreaterThanOrEqual(2);
    s.input.write('{"type":"quit"}\n');
    await s.done;
    expect(fake.lines.items).toHaveLength(1);
  });
});

describe("attach: emacs presentation of client notices", () => {
  it("labels the version-skew hint `[status]`", async () => {
    const path = await socketPath();
    const skew = skewOf();
    await fakeDaemon(path, (socket) => {
      socket.write(encodeLine({ type: "error", message: skew }));
    });
    const s = frameSession(path);
    expect(await rejection(s.done)).toMatchObject({ code: "NOT_ATTACHED" });
    expect(s.printed()).toContain(
      "[status] the daemon predates attach: restart it (malebolge-stop, then malebolge-start)\n",
    );
  });

  it("prints the connected banner as a status line", async () => {
    const path = await socketPath();
    await fakeDaemon(path);
    const s = session(path, { inputMode: "frames", presentation: "emacs" });
    await s.until("[status] ");
    expect(s.printed()).toContain("[status] connected");
    expect(s.printed()).not.toContain("[connected]");
    s.input.write('{"type":"quit"}\n');
    await s.done;
  });

  it("keeps today's exact text in the default presentation", async () => {
    const path = await socketPath();
    await fakeDaemon(path);
    const s = session(path);
    await s.until("[connected]\n");
    expect(s.printed().startsWith("[connected]\n")).toBe(true);
    s.input.end();
    await s.done;
    expect(s.printed()).toContain("[detached]\n");
  });
});

// ---------------------------------------------------------------------------
// `malebolge-attach --list`: one frame, ids on stdout, its own wait (DEC-008).
// ---------------------------------------------------------------------------

describe("attach --list", () => {
  const wait: ConnectWait = { intervalMs: 20, timeoutMs: 200 };

  it("prints the ids one per line, prints no notice, and sends exactly one list frame", async () => {
    const path = await socketPath();
    const test = await openTestHarness([]);
    onTestFinished(() => test.harness.close(context));
    const daemon = await serveTest(test, path);
    onTestFinished(daemon.close);
    const api = conversations(test, { model: FAUX_MODEL, cwd: process.cwd() }, "host");
    const first = await api.open({ kind: "new" });
    const second = await api.open({ kind: "new" });
    const l = listing(path, wait);
    await l.done;
    // Newest first, the shared reply type either side of the wire.
    expect(l.printed()).toBe(
      `${String(second.id)}\n${String(first.id)}\n${String(test.root.id)}\n`,
    );
    expect(l.errors()).toBe("");
  });

  it("writes one truncated line to stderr for --list, leaving stdout ids only", async () => {
    const path = await socketPath();
    await fakeDaemon(path, (socket) => {
      socket.end(encodeLine({ type: "conversations", conversations: [9, 7], truncated: true }));
    });
    const l = listing(path, wait);
    await l.done;
    expect(l.printed()).toBe("9\n7\n");
    expect(
      l
        .errors()
        .split("\n")
        .filter((line) => line !== ""),
    ).toHaveLength(1);
  });

  it("ignores the snapshot a pre-list daemon sends first, names `unknown message type` and exits 1 through NOT_LISTED", async () => {
    const path = await socketPath();
    const skew = skewOf("list");
    const fake = await fakeDaemon(path, (socket) => {
      socket.write(
        encodeLine({
          type: "snapshot",
          entries: [{ kind: "pi.user", model: [{ role: "user", content: "earlier" }] }],
        }),
      );
      socket.write(encodeLine({ type: "error", message: skew }));
    });
    const l = listing(path, wait);
    expect(await rejection(l.done)).toMatchObject({ code: "NOT_LISTED" });
    // The old daemon bound root and sent its whole transcript first: none of it prints.
    expect(l.printed()).toBe("");
    expect(l.errors()).not.toContain("» earlier");
    expect(l.errors()).toContain(`[error: ${skew}]\n`);
    expect(l.errors()).toContain(
      "[the daemon predates list: restart it (malebolge-stop, then malebolge-start)]\n",
    );
    await fake.closed;
  });

  it("answers an error frame with one line on stderr, ends its own socket, and exits 1", async () => {
    const path = await socketPath();
    const fake = await fakeDaemon(path, (socket) => {
      socket.write(encodeLine({ type: "error", message: "listing failed" }));
    });
    const l = listing(path, wait);
    expect(await rejection(l.done)).toBeInstanceOf(NotListedError);
    expect(l.printed()).toBe("");
    expect(l.errors()).toBe("[error: listing failed]\n");
    // The old daemon leaves the connection open: waiting for its close would hang.
    await fake.closed;
  });

  it("reports a close before any reply through NOT_LISTED", async () => {
    const path = await socketPath();
    const fake = await fakeDaemon(path);
    const l = listing(path, wait);
    await fake.lines.next((line) => line.includes('"list"'));
    fake.destroy();
    expect(await rejection(l.done)).toMatchObject({ code: "NOT_LISTED" });
    expect(l.printed()).toBe("");
    expect(l.errors()).not.toBe("");
  });

  it("gives up on its own short LIST_WAIT, not the attach wait", async () => {
    const path = await socketPath();
    const invocation = attachInvocationOf(["--list"]);
    const listingWait = invocation.mode === "list" ? invocation.wait : undefined;
    expect(listingWait).toEqual({ intervalMs: 200, timeoutMs: 1_000 });
    const started = Date.now();
    if (listingWait === undefined) {
      throw new Error("--list is not a list invocation");
    }
    const l = listing(path, listingWait);
    expect(await rejection(l.done)).toMatchObject({ code: "ENOENT" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(l.printed()).toBe("");
    expect(l.errors()).toContain(`cannot connect to ${path}`);
  });
});
