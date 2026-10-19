// Helpers for tests that run a room shell over real pi-env connections:
// connections and temp dirs released after each test, and a rejection probe.

import type { Connection } from "@earendil-works/pi-env";
import { afterEach } from "vitest";
import { tempDir } from "../fixtures.ts";

/** A signal that never aborts. */
export const never = (): AbortSignal => new AbortController().signal;

/** Rejection of `promise`, or a failure if it resolves. */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

export interface ShellKit {
  /** `connection`, closed after the test. */
  open: (connection: Connection) => Connection;
  /** A temp dir, removed after the test (even when it fails). */
  scratch: () => Promise<string>;
}

/** Call at a test file's top level: what `open` and `scratch` hand out is released after each test. */
export function shellKit(): ShellKit {
  const opened: Connection[] = [];
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const connection of opened.splice(0)) {
      connection.close();
    }
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
  });
  return {
    open: (connection): Connection => {
      opened.push(connection);
      return connection;
    },
    scratch: async (): Promise<string> => {
      const tmp = await tempDir();
      cleanups.push(tmp.cleanup);
      return tmp.dir;
    },
  };
}
