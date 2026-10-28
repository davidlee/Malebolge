// Design VT-12 (SL-005 PHASE-08 VT-3): the real screwtape's read verbs, through
// the adapter, against a temporary copy of the store. Opt-in only
// (MALEBOLGE_MAIL_SMOKE=1; vitest.config.ts leaves this file out otherwise), and
// run by the operator on the host, never by a delegate.
//
// Bounds, all of them load-bearing:
// - The real store is only ever copied, byte for byte. Nothing opens it.
// - The copy's config points the network at a closed local port and names no
//   credential, so a verb that reached for the network would fail, not sync.
// - Only read verbs run: mailboxes, list, read, thread, read --after.
// - Nothing prints message content: assertions are on counts, shapes, failure
//   classes (fixed vocabulary) and the copy's digest.

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isRecord } from "../../src/json.ts";
import { screwtapeSource } from "../../src/mail/screwtape.ts";
import { isUtcDate, type MailSource, MailSourceError } from "../../src/mail/source.ts";

const ENABLED = process.env["MALEBOLGE_MAIL_SMOKE"] === "1";

/** The Home Manager wrapper: a script that execs the binary with a baked-in --config. */
const WRAPPER =
  process.env["MALEBOLGE_MAIL_SMOKE_WRAPPER"] ??
  join(homedir(), ".nix-profile", "bin", "screwtape");

/** The binary and config the wrapper execs: `exec <binary> --config <config> "$@"`. */
function located(wrapper: string): { binary: string; config: string } {
  const match = /^exec (\/\S+) --config (\/\S+) "\$@"$/m.exec(readFileSync(wrapper, "utf8"));
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`no exec line in ${wrapper}`);
  }
  return { binary: match[1], config: match[2] };
}

const digest = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

/** SQLite's sidecar files, which hold committed pages until a checkpoint. */
const SIDECARS = ["-wal", "-shm"] as const;

/**
 * A self-contained copy of the store at `store` in `dir`: the database and any
 * sidecars copied, then the copy (never the original) checkpointed so its one
 * file holds everything and its digest means something.
 */
function copyStore(store: string, dir: string): string {
  const copy = join(dir, "mail.sqlite3");
  copyFileSync(store, copy);
  for (const suffix of SIDECARS) {
    if (existsSync(store + suffix)) {
      copyFileSync(store + suffix, copy + suffix);
    }
  }
  const db = new DatabaseSync(copy);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  for (const suffix of SIDECARS) {
    rmSync(copy + suffix, { force: true });
  }
  return copy;
}

interface Smoke {
  dir: string;
  copy: string;
  before: string;
  source: MailSource;
}

/** The failure class of a rejected call; anything but a MailSourceError rethrows. */
async function failureOf(call: Promise<unknown>): Promise<MailSourceError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof MailSourceError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the call to fail");
}

describe.skipIf(!ENABLED)("mail smoke: the real screwtape on a copy of the store (VT-12)", () => {
  let smoke: Smoke;

  beforeAll(() => {
    const { binary, config } = located(WRAPPER);
    const real: unknown = JSON.parse(readFileSync(config, "utf8"));
    const store = isRecord(real) ? real["store_path"] : undefined;
    if (!isRecord(real) || typeof store !== "string") {
      throw new Error("the screwtape config names no store_path");
    }
    const dir = mkdtempSync(join(tmpdir(), "malebolge-mail-smoke-"));
    const copy = copyStore(store, dir);
    const smokeConfig = join(dir, "screwtape.json");
    writeFileSync(
      smokeConfig,
      JSON.stringify({
        ...real,
        store_path: copy,
        session_url: "https://127.0.0.1:9/jmap/session",
        credential_name: "malebolge-mail-smoke-none",
      }),
      { mode: 0o600 },
    );
    const source = screwtapeSource({
      binary,
      config: smokeConfig,
      home: dir,
      env: new NodeExecutionEnv({ cwd: dir }),
    });
    smoke = { dir, copy, before: digest(copy), source };
  });

  afterAll(() => {
    rmSync(smoke.dir, { recursive: true, force: true });
  });

  it("mailboxes, list, read, thread and read --after return contract-valid data", async () => {
    const { source } = smoke;
    expect((await source.mailboxes()).items.length).toBeGreaterThan(0);

    const page = await source.list({ limit: 5, offset: 0, filters: {} });
    expect(page.items.length).toBeLessThanOrEqual(5);
    const first = page.items[0];
    expect(first).toBeDefined();
    if (first === undefined) {
      return;
    }

    const read = await source.read({ id: first.id, maxBytes: 1024 });
    expect(read.id === first.id).toBe(true);

    const thread = await source.thread({ id: read.thread_id, limit: 5 });
    expect(thread.id === read.thread_id).toBe(true);
    expect(thread.items.length).toBeLessThanOrEqual(5);
    expect(thread.total).toBeGreaterThanOrEqual(thread.items.length);

    const arrivals = await source.readAfter({ after: "", limit: 3, maxBytes: 1024, filters: {} });
    expect(arrivals.length).toBeLessThanOrEqual(3);
    const last = arrivals.at(-1);
    if (last !== undefined) {
      const next = await source.readAfter({
        after: last.cursor,
        limit: 3,
        maxBytes: 1024,
        filters: {},
      });
      expect(next.length).toBeLessThanOrEqual(3);
    }
  });

  it("accepts a since in the form mail_new checks (VH-1 found the two disagreeing)", async () => {
    const since = "2026-10-01";
    expect(isUtcDate(since)).toBe(true);
    const arrivals = await smoke.source.readAfter({
      after: "",
      since,
      limit: 1,
      maxBytes: 512,
      filters: {},
    });
    expect(arrivals.length).toBeLessThanOrEqual(1);
  });

  it("a usage error carries screwtape's reason code (the PHASE-06 diagnostic)", async () => {
    // --limit is 1 to 500 (screwtape README § Contract): 0 is a usage error, exit 2.
    const failure = await failureOf(smoke.source.list({ limit: 0, offset: 0, filters: {} }));
    expect(failure.failure).toBe("usage");
    expect(failure.message).toMatch(/^screwtape usage error: [a-z_]{1,64}$/);
  });

  it("an unknown message id is a usage error naming its reason", async () => {
    // Observed on the host 2026-10-28: exit 2 with reason `unknown_message`.
    const failure = await failureOf(
      smoke.source.read({ id: "malebolgeSmokeNoSuchId", maxBytes: 1024 }),
    );
    expect(failure.failure).toBe("usage");
    expect(failure.message).toBe("screwtape usage error: unknown_message");
  });

  it("leaves the copy's database unchanged", () => {
    expect(digest(smoke.copy) === smoke.before).toBe(true);
  });
});
