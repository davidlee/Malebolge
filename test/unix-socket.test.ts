import { chmod, stat, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  connectUnix,
  PrivateDirectoryRefused,
  servePrivateUnix,
  serveUnix,
  SocketInUse,
  type UnixServer,
} from "../src/unix-socket.ts";
import { rejection, socketPath, staleSocket, tempDir } from "./fixtures.ts";

/** Serves `path`, writing "hi" to each connection; closed when the test ends. */
async function serve(path: string): Promise<UnixServer> {
  const server = await serveUnix(path, (socket) => socket.end("hi"));
  onTestFinished(server.close);
  return server;
}

/** Serves `path` privately (0700 directory, 0600 socket); closed when the test ends. */
async function servePrivate(path: string): Promise<UnixServer> {
  const server = await servePrivateUnix(path, (socket: Socket) => socket.end("hi"));
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

describe("servePrivateUnix: the directory is closed before the socket exists (VT-1)", () => {
  it("creates an absent directory 0o700 and leaves the socket 0o600", async () => {
    const { dir, cleanup } = await tempDir();
    onTestFinished(cleanup);
    const directory = join(dir, "private");
    const path = join(directory, "s.sock");
    await servePrivate(path);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await greeting(path)).toBe("hi");
  });

  it("refuses a directory open to group and other, creating no socket", async () => {
    const { dir, cleanup } = await tempDir();
    onTestFinished(cleanup);
    await chmod(dir, 0o750);
    const path = join(dir, "s.sock");
    const { uid, mode } = await stat(dir);
    const refused = await rejection(servePrivateUnix(path, () => undefined));
    expect(refused).toBeInstanceOf(PrivateDirectoryRefused);
    expect(refused).toMatchObject({
      message: `${dir} must be owned by this user and closed to group and other (mode ${(mode & 0o777).toString(8)}, uid ${String(uid)})`,
    });
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a directory owned by another uid, creating no socket", async () => {
    const { dir, cleanup } = await tempDir();
    onTestFinished(cleanup);
    const realUid = process.getuid?.() ?? 0;
    const spy = vi.spyOn(process, "getuid").mockReturnValue(realUid + 1);
    onTestFinished(() => {
      spy.mockRestore();
    });
    const path = join(dir, "s.sock");
    const { uid, mode } = await stat(dir);
    const refused = await rejection(servePrivateUnix(path, () => undefined));
    expect(refused).toBeInstanceOf(PrivateDirectoryRefused);
    expect(refused).toMatchObject({
      message: `${dir} must be owned by this user and closed to group and other (mode ${(mode & 0o777).toString(8)}, uid ${String(uid)})`,
    });
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
