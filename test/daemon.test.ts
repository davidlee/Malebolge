import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { context } from "../src/context.ts";
import { type Daemon, serve } from "../src/daemon.ts";
import { type LineClient, lineClient, tempDir } from "./fixtures.ts";
import { openTestHarness, type TestHarness } from "./harness-fixture.ts";

type Entry = { kind: string; model?: unknown };
type Message = { type: string; entries?: Entry[]; entry?: Entry; message?: string };
const isType = (type: string) => (message: Message) => message.type === type;

describe("daemon", () => {
  let cleanup: () => Promise<void>;
  let test: TestHarness;
  let daemon: Daemon;
  let socketPath: string;
  const clients: LineClient[] = [];

  const attach = async () => {
    const client = await lineClient(socketPath);
    clients.push(client);
    await client.next(isType("snapshot"));
    return client;
  };

  beforeEach(async () => {
    const tmp = await tempDir();
    cleanup = tmp.cleanup;
    socketPath = join(tmp.dir, "durable.sock");
    test = await openTestHarness([]);
    daemon = await serve(test.harness, test.root, socketPath);
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await daemon.close();
    await test.harness.close(context);
    await cleanup();
  });

  it("answers input and streams the run to the client", async () => {
    test.faux.setResponses([fauxAssistantMessage([fauxText("hello")])]);
    const client = await attach();
    client.send({ type: "input", content: "hi" });
    const answer = await client.next<Message>(
      (m) => m.type === "message_end" && m.entry?.kind === "pi.assistant",
    );
    expect(JSON.stringify(answer.entry?.model)).toContain("hello");
    await client.next(isType("run_end"));
  });

  it("gives a late client the transcript so far as its snapshot", async () => {
    test.faux.setResponses([fauxAssistantMessage([fauxText("hello")])]);
    const first = await attach();
    first.send({ type: "input", content: "hi" });
    await first.next(isType("run_end"));
    const late = await lineClient(socketPath);
    clients.push(late);
    const snapshot = await late.next<Message>(isType("snapshot"));
    expect(snapshot.entries?.map((e) => e.kind)).toEqual(
      expect.arrayContaining(["pi.user", "pi.assistant"]),
    );
  });

  it("broadcasts one client's run to every attached client", async () => {
    test.faux.setResponses([fauxAssistantMessage([fauxText("hello")])]);
    const [a, b] = [await attach(), await attach()];
    a.send({ type: "input", content: "hi" });
    await b.next(isType("run_end"));
  });

  it("answers a malformed line with an error and keeps the connection", async () => {
    test.faux.setResponses([fauxAssistantMessage([fauxText("hello")])]);
    const client = await attach();
    client.send({ type: "nonsense" });
    const error = await client.next<Message>(isType("error"));
    expect(error.message).toMatch(/nonsense/);
    client.send({ type: "input", content: "hi" });
    await client.next(isType("run_end"));
  });

  it("removes the socket file on close", async () => {
    const { existsSync } = await import("node:fs");
    expect(existsSync(socketPath)).toBe(true);
    await daemon.close();
    expect(existsSync(socketPath)).toBe(false);
  });
});
