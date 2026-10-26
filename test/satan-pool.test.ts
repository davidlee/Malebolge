// EX-3 (design V11): the per-(conversation, kind) pool the SATAN tool calls go
// through. Fake timers throughout, and plain fake values that record their own
// closings, so no test waits on a real clock.

import type { ConversationId } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SatanKind } from "../src/conversation-context.ts";
import { isConversationKey } from "../src/conversations.ts";
import { type PoolKey, satanPool } from "../src/satan-pool.ts";

/** How long an entry with no call in flight survives. */
const satanIdleMs = 1000;

/** pi's branded id for `n`, through the guard the wire parser uses, so no case needs a cast. */
const conversationId = (n: number): ConversationId => {
  if (!isConversationKey(n)) {
    throw new Error(`test id ${String(n)} is no conversation id`);
  }
  return n;
};

const kind: SatanKind = "interactive";

/** The key a conversation's calls are pooled under. */
const keyOf = (n: number): PoolKey => ({ conversation: conversationId(n), kind });

/** A pooled value: which `open` made it, and whether its `close` has finished. */
interface Fake {
  readonly key: PoolKey;
  readonly serial: number;
  closed: boolean;
}

/** A fake pool, and the record its `open` and `close` keep of what happened. */
interface FakePool {
  pool: ReturnType<typeof satanPool<Fake>>;
  /** Every value `open` made, in order. */
  opened: Fake[];
  /** The values whose close has finished, in the order they finished. */
  closed: Fake[];
  /** Settle every close `holding` left in flight. */
  finish: () => void;
}

/**
 * A pool over counted fake entries. With `holding`, `close` answers a promise the
 * test settles with `finish`, so a close can be caught after it began and before
 * it landed; `reject` names the serial whose close rejects instead of finishing.
 */
function fakePool(options: { holding?: boolean; reject?: number } = {}): FakePool {
  const opened: Fake[] = [];
  const closed: Fake[] = [];
  const pending: (() => void)[] = [];
  const pool = satanPool<Fake>({
    idleMs: satanIdleMs,
    open: (key) => {
      const value: Fake = { key, serial: opened.length + 1, closed: false };
      opened.push(value);
      return value;
    },
    close: (value) => {
      if (value.serial === options.reject) {
        return Promise.reject(new Error(`close of ${String(value.serial)} rejected`));
      }
      const finish = (): void => {
        value.closed = true;
        closed.push(value);
      };
      if (options.holding !== true) {
        finish();
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        pending.push(() => {
          finish();
          resolve();
        });
      });
    },
  });
  const finish = (): void => {
    for (const settle of pending.splice(0)) {
      settle();
    }
  };
  return { pool, opened, closed, finish };
}

describe("satanPool", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes an entry that idles out, and opens a fresh one for the next acquire", async () => {
    const fake = fakePool();
    const first = fake.pool.acquire(keyOf(1));
    fake.pool.release(keyOf(1));
    await vi.advanceTimersByTimeAsync(satanIdleMs - 1);
    expect(fake.closed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.closed).toEqual([first]);
    const second = fake.pool.acquire(keyOf(1));
    expect(second).not.toBe(first);
    expect(second.closed).toBe(false);
    expect(fake.opened).toHaveLength(2);
  });

  it("keeps an entry alive while another call still holds it", async () => {
    const fake = fakePool();
    const entry = fake.pool.acquire(keyOf(1));
    expect(fake.pool.acquire(keyOf(1))).toBe(entry);
    fake.pool.release(keyOf(1));
    await vi.advanceTimersByTimeAsync(satanIdleMs * 3);
    expect(fake.closed).toEqual([]);
    fake.pool.release(keyOf(1));
    await vi.advanceTimersByTimeAsync(satanIdleMs);
    expect(fake.closed).toEqual([entry]);
  });

  it("cancels the countdown when a call arrives during it", async () => {
    const fake = fakePool();
    const entry = fake.pool.acquire(keyOf(1));
    fake.pool.release(keyOf(1));
    await vi.advanceTimersByTimeAsync(satanIdleMs - 1);
    expect(fake.closed).toEqual([]);
    expect(fake.pool.acquire(keyOf(1))).toBe(entry);
    await vi.advanceTimersByTimeAsync(satanIdleMs * 2);
    expect(fake.closed).toEqual([]);
    expect(fake.opened).toHaveLength(1);
  });

  it("opens a fresh entry when an acquire races an expiry that is still closing", async () => {
    const fake = fakePool({ holding: true });
    const entry = fake.pool.acquire(keyOf(1));
    fake.pool.release(keyOf(1));
    // The entry is out of the pool the moment its timer fires; its close outlives that.
    await vi.advanceTimersByTimeAsync(satanIdleMs);
    const second = fake.pool.acquire(keyOf(1));
    expect(second).not.toBe(entry);
    expect(second.closed).toBe(false);
    expect(fake.opened).toHaveLength(2);
    expect(fake.closed).toEqual([]);
    fake.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.closed).toEqual([entry]);
    expect(second.closed).toBe(false);
  });

  it("keeps one entry per conversation, and closes all fifty as they idle out", async () => {
    const fake = fakePool();
    const keys = Array.from({ length: 50 }, (_unused, index) => keyOf(index + 1));
    const values = keys.map((key) => fake.pool.acquire(key));
    expect(new Set(values).size).toBe(50);
    expect(fake.opened).toHaveLength(50);
    for (const key of keys) {
      fake.pool.release(key);
    }
    await vi.advanceTimersByTimeAsync(satanIdleMs);
    expect(new Set(fake.closed)).toEqual(new Set(values));
  });

  it("closeAll closes the other entries when one entry's close rejects", async () => {
    const fake = fakePool({ reject: 2 });
    const entries = [keyOf(1), keyOf(2), keyOf(3)].map((key) => fake.pool.acquire(key));
    // The one rejection is the pool's to swallow, not its caller's to catch.
    await expect(fake.pool.closeAll()).resolves.toBeUndefined();
    expect(fake.closed).toEqual([entries[0], entries[2]]);
    // The entry that named itself: its close was attempted, and it is still open.
    expect(entries[1]?.closed).toBe(false);
  });

  it("closeAll closes every entry, and then no acquire is answered", async () => {
    const fake = fakePool();
    const held = [keyOf(1), keyOf(2), keyOf(3)].map((key) => fake.pool.acquire(key));
    fake.pool.acquire(keyOf(1)); // still in flight: closeAll closes it anyway
    await fake.pool.closeAll();
    expect(new Set(fake.closed)).toEqual(new Set(held));
    // The timers are gone with the entries: nothing is closed a second time.
    await vi.advanceTimersByTimeAsync(satanIdleMs * 2);
    expect(fake.closed).toHaveLength(3);
    expect(() => fake.pool.acquire(keyOf(4))).toThrow();
  });
});
