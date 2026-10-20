import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { attach, commandOf } from "../src/attach.ts";
import { context } from "../src/context.ts";
import { type Daemon, serve } from "../src/daemon.ts";
import { type ConnectWait, serveUnix } from "../src/unix-socket.ts";
import { rejection, socketPath, staleSocket, tempDir } from "./fixtures.ts";
import { openTestHarness, type TestHarness } from "./harness-fixture.ts";

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

/** An attach client of `path`, collecting what it prints. */
const session = (path: string, wait?: ConnectWait): Session => {
  const [input, output] = [new PassThrough(), new PassThrough()];
  output.setEncoding("utf8");
  let printed = "";
  output.on("data", (chunk: string) => {
    printed += chunk;
  });
  const done = attach(path, input, output, wait);
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
    daemon = await serve(Promise.resolve(test), path, () => Promise.resolve());
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

  it("ends when the daemon goes away", async () => {
    const s = session(path);
    await s.until("[attached]\n");
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
      daemon = await serve(Promise.resolve(test), path, () => Promise.resolve());
    });

    it("prints the answer once, with nothing else", async () => {
      const s = session(path);
      await s.until("[attached]\n");
      s.input.write("go\n");
      await s.until(`${answer}\n`);
      expect(s.printed()).toBe(`[attached]\n${answer}\n`);
      s.input.end();
      await s.done;
    });

    it("prints it exactly once for a client that attaches mid-answer", async () => {
      await test.root.submit({ type: "input", content: "go" }, context);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const s = session(path);
      await s.until(`${answer}\n`);
      expect(s.printed()).toBe(`[attached]\n» go\n${answer}\n`);
      s.input.end();
      await s.done;
    });
  });
});

describe("attach: waits for the daemon (design §4.2)", () => {
  const harnessAt = async (path: string): Promise<void> => {
    const test = await openTestHarness([]);
    onTestFinished(() => test.harness.close(context));
    const daemon = await serve(Promise.resolve(test), path, () => Promise.resolve());
    onTestFinished(daemon.close);
  };

  /** One attach attempt to `path`, with nothing written to its stream. */
  const attempt = (path: string, wait: ConnectWait): Promise<void> =>
    attach(path, new PassThrough(), new PassThrough(), wait);

  it("waits for a daemon that has not started yet (ENOENT)", async () => {
    const path = await socketPath();
    const s = session(path);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await harnessAt(path);
    await s.until("[attached]\n");
    s.input.end();
    await s.done;
  });

  it("waits for a stale socket to be replaced (ECONNREFUSED)", async () => {
    const path = await socketPath();
    await staleSocket(path);
    const s = session(path);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await harnessAt(path);
    await s.until("[attached]\n");
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
    const s = session(path, { intervalMs: 20, timeoutMs: 100 });
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
