import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readRoomBehind } from "../src/room-behind.ts";

async function response(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "room-behind-"));
  const path = join(dir, "socket");
  const server = createServer((socket) => socket.end(body));
  await new Promise<void>((resolve) => server.listen(path, resolve));
  try {
    return await readRoomBehind(path);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
        } else {
          resolve();
        }
      }),
    );
    await rm(dir, { recursive: true, force: true });
  }
}

describe("room-behind host bridge", () => {
  it("returns the host result", async () => {
    await expect(
      response(JSON.stringify({ ok: true, text: "repo\tbehind\nfoo\t1\n" })),
    ).resolves.toBe("repo\tbehind\nfoo\t1\n");
  });
  it("reports command failures and malformed responses", async () => {
    await expect(response(JSON.stringify({ ok: false, text: "command failed" }))).rejects.toThrow(
      "command failed",
    );
    await expect(response("bad")).rejects.toThrow();
  });
  it("rejects oversized responses", async () => {
    await expect(response("x".repeat(70_000))).rejects.toThrow("exceeds");
  });
});
