// Shared by the PHASE-01 spikes: pi's durable state and the runner's host
// tables on one SQLite adapter, and a bounded wait that turns a hang into a
// failure.

import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  type Extension,
  type Harness,
} from "@earendil-works/pi-durable";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { context } from "../../src/context.ts";

export type SharedStore = { db: SqliteDatabase; storage: SqliteStorage };

/**
 * pi's storage over a SQLite file, and the same adapter for host tables. Host
 * writes go to `db` directly: from inside a pi transaction they would queue
 * behind it and never settle.
 */
export async function openSharedStore(dir: string, hostSchema?: string): Promise<SharedStore> {
  const db = await openNodeSqliteDatabase(join(dir, "store.sqlite"));
  if (hostSchema !== undefined) await db.exec(hostSchema);
  return { db, storage: await SqliteStorage.open(db) };
}

/** Closing the harness closes the storage, and the storage its database. */
export const closeHarness = (harness: Harness) => harness.close(context);

/** `promise`, or a rejection naming `what` once `ms` pass. */
export function within<T>(ms: number, what: string, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export type BlockingTool = {
  extension: Extension;
  /** Resolves when the next call starts. */
  started: () => Promise<void>;
  /** Lets the call in flight return. */
  release: () => void;
  /** Calls started so far. */
  calls: () => number;
};

/**
 * A tool `name` whose call stays in flight until `release()`, or until its call
 * is aborted, so a test can act while a tool round is underway.
 */
export function blockingTool(name: string): BlockingTool {
  let calls = 0;
  let onStart = () => {};
  let release = () => {};
  const tool = defineTool({
    name,
    description: "Waits for the test.",
    parameters: Type.Object({}),
    execute: async (_args, _api, callContext) => {
      calls++;
      await new Promise<void>((resolve, reject) => {
        release = resolve;
        callContext.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")));
        onStart();
      });
      return { output: [{ type: "text", text: "released" }] };
    },
  });
  return {
    extension: defineExtension({ name, tools: [tool] }),
    started: () => new Promise<void>((resolve) => (onStart = resolve)),
    release: () => release(),
    calls: () => calls,
  };
}
