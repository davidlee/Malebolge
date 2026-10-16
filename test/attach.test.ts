import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attach, commandOf } from "../src/attach.ts";
import { context } from "../src/context.ts";
import { type Daemon, serve } from "../src/daemon.ts";
import { tempDir } from "./fixtures.ts";
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

describe("attach", () => {
  let cleanup: () => Promise<void>;
  let test: TestHarness;
  let daemon: Daemon;
  let socketPath: string;

  beforeEach(async () => {
    const tmp = await tempDir();
    cleanup = tmp.cleanup;
    socketPath = join(tmp.dir, "durable.sock");
    test = await openTestHarness([]);
    daemon = await serve(test.harness, test.root, socketPath);
  });

  afterEach(async () => {
    await daemon.close();
    await test.harness.close(context);
    await cleanup();
  });

  const session = async () => {
    const [input, output] = [new PassThrough(), new PassThrough()];
    let printed = "";
    output.on("data", (chunk) => {
      printed += chunk;
    });
    const done = attach(socketPath, input, output);
    const until = (text: string) =>
      new Promise<void>((resolve) => {
        const check = () => printed.includes(text) && resolve();
        output.on("data", check);
        check();
      });
    return { input, done, until, printed: () => printed };
  };

  it("sends typed lines as input and prints the answer", async () => {
    test.faux.setResponses([fauxAssistantMessage([fauxText("hello back")])]);
    const s = await session();
    s.input.write("hello\n");
    await s.until("hello back\n");
    s.input.write("/quit\n");
    await s.done;
  });

  it("shows the transcript so far on attach", async () => {
    test.faux.setResponses([fauxAssistantMessage([fauxText("earlier answer")])]);
    await (await test.root.submit({ type: "input", content: "earlier" }, context)).wait(context);
    const s = await session();
    await s.until("» earlier\nearlier answer\n");
    s.input.end();
    await s.done;
  });

  it("ends when the daemon goes away", async () => {
    const s = await session();
    await s.until("[attached]\n");
    await daemon.close();
    await s.done;
    expect(s.printed()).toContain("[detached]");
  });

  describe("with an answer streamed in many commits", () => {
    // Slow enough to span several 100 ms progress commits, so the client sees
    // what a real provider produces: message_start carrying a partial, deltas,
    // and a tail that only the final entry at message_end holds.
    const answer = Array.from({ length: 12 }, (_, i) => `w${i}`).join(" ");

    beforeEach(async () => {
      await daemon.close();
      await test.harness.close(context);
      test = await openTestHarness([], { tokensPerSecond: 40, tokenSize: { min: 1, max: 1 } });
      test.faux.setResponses([fauxAssistantMessage([fauxText(answer)])]);
      daemon = await serve(test.harness, test.root, socketPath);
    });

    it("prints the answer once, with nothing else", async () => {
      const s = await session();
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
      const s = await session();
      await s.until(`${answer}\n`);
      expect(s.printed()).toBe(`[attached]\n» go\n${answer}\n`);
      s.input.end();
      await s.done;
    });
  });
});
