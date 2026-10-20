// One daemon per profile (design §4.4, DEC-087): an exclusive SQLite lock on a
// file beside the store, held for the process's life. The kernel drops the
// underlying POSIX lock when the holder dies, so a crash never leaves it stuck.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Another holder has the lock at `path`. */
export class InstanceLocked extends Error {
  constructor(path: string, options?: ErrorOptions) {
    super(`another daemon holds ${path}`, options);
    this.name = "InstanceLocked";
  }
}

const SQLITE_BUSY = 5;

const isBusy = (error: unknown): boolean =>
  error instanceof Error && "errcode" in error && error.errcode === SQLITE_BUSY;

/** Held for the process's life; the kernel releases it if the process dies. */
export function acquireInstanceLock(path: string): { release: () => void } {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;");
  } catch (error) {
    db.close();
    throw isBusy(error) ? new InstanceLocked(path, { cause: error }) : error;
  }
  return {
    release: (): void => {
      db.close();
    },
  };
}
