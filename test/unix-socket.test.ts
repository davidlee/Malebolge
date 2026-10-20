import { chmod, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { connectUnix, SocketInUse, serveUnix, type UnixServer } from "../src/unix-socket.ts";
import { rejection, socketPath, staleSocket } from "./fixtures.ts";

/** Serves `path`, writing "hi" to each connection; closed when the test ends. */
async function serve(path: string): Promise<UnixServer> {
  const server = await serveUnix(path, (socket) => socket.end("hi"));
  onTestFinished(server.close);
  return server;
}

/** What one connection to `path` reads. */
async function greeting(path: string): Promise<string> {
  const socket = await connectUnix(path);
  let text = "";
  for await (const chunk of socket) {
    text += String(chunk);
  }
  return text;
}

describe("serveUnix: listening is the claim (design §4.4)", () => {
  it("listens on a free path", async () => {
    const path = await socketPath();
    await serve(path);
    expect(await greeting(path)).toBe("hi");
  });

  it("refuses a live listener with SocketInUse and leaves its socket alone", async () => {
    const path = await socketPath();
    await serve(path);
    const { ino } = await stat(path);
    expect(await rejection(serveUnix(path, () => undefined))).toBeInstanceOf(SocketInUse);
    expect((await stat(path)).ino).toBe(ino);
    expect(await greeting(path)).toBe("hi");
  });

  it.each([
    ["a socket whose listener died", staleSocket],
    ["a regular file", (path: string): Promise<void> => writeFile(path, "stale")],
  ])("replaces %s (connect is refused)", async (_, leave) => {
    const path = await socketPath();
    await leave(path);
    await serve(path);
    expect(await greeting(path)).toBe("hi");
  });

  it("propagates a listen error other than EADDRINUSE, without probing", async () => {
    const path = join(await socketPath(), "..", "missing", "s.sock");
    expect(await rejection(serveUnix(path, () => undefined))).toMatchObject({ syscall: "listen" });
  });

  it("propagates a probe error other than refusal, unlinking nothing (RV-040 F-5)", async () => {
    const path = await socketPath();
    await serve(path);
    await chmod(path, 0o000);
    const { ino } = await stat(path);
    expect(await rejection(serveUnix(path, () => undefined))).toMatchObject({
      code: "EACCES",
      syscall: "connect",
    });
    expect((await stat(path)).ino).toBe(ino);
  });
});
