import { createConnection } from "node:net";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

const LIMIT = 64 * 1024;
const DEADLINE_MS = 35_000;
const SOCKET = "/run/user/1000/room-behind/room-behind.sock";
const SYNC_SOCKET = "/run/user/1000/room-behind/sync-room.sock";
const SYNC_DEADLINE_MS = 310_000;

function parseResponse(body: string): string {
  const result: unknown = JSON.parse(body);
  if (typeof result !== "object" || result === null || !("ok" in result) || !("text" in result)) {
    throw new Error("invalid room-behind response");
  }
  if (typeof result.text !== "string" || typeof result.ok !== "boolean") {
    throw new Error("invalid room-behind response");
  }
  if (!result.ok) {
    throw new Error(result.text);
  }
  return result.text;
}

/** Read one bounded response from the host's socket-activated helper. */
export function readRoomBehind(path = SOCKET, deadlineMs = DEADLINE_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const chunks: Buffer[] = [];
    let size = 0;
    socket.setTimeout(deadlineMs, () => socket.destroy(new Error("host request timed out")));
    socket.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > LIMIT) {
        socket.destroy(new Error("room-behind response exceeds 64 KiB"));
      } else {
        chunks.push(chunk);
      }
    });
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        resolve(parseResponse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

export const roomBehindExtension = defineExtension({
  name: "room-behind",
  tools: [
    defineTool({
      name: "room_behind",
      description:
        "Compare room checkout commits to configured host branches. Returns TSV: repo, behind, ahead, branch, room and host; ? means unavailable.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async () => {
        try {
          return { output: [{ type: "text", text: await readRoomBehind() }], isError: false };
        } catch (error) {
          return {
            output: [
              {
                type: "text",
                text: `room_behind: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      },
    }),
    defineTool({
      name: "sync_room",
      description:
        "Push configured host branches and fast-forward clean room checkouts. Dirty or divergent checkouts are skipped. A failure or interruption may leave a partial sync; inspect the result before retrying.",
      parameters: Type.Object({}),
      replay: "unsafe",
      execute: async () => {
        try {
          return {
            output: [{ type: "text", text: await readRoomBehind(SYNC_SOCKET, SYNC_DEADLINE_MS) }],
            isError: false,
          };
        } catch (error) {
          return {
            output: [
              {
                type: "text",
                text: `sync_room may have partially completed: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      },
    }),
  ],
});
