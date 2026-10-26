// Which conversation a connection serves, kept as a pool: one value per
// (conversation, kind), held while a call uses it and for an idle timeout after
// the last one lets go (design V11, EX-3). Pure apart from the timers it sets:
// it knows nothing of MCP, so satan-tools.ts supplies both ends.

import type { ConversationId } from "@earendil-works/pi-durable";
import type { SatanKind } from "./conversation-context.ts";

/** Fifteen minutes: a conversation's connection lasts between turns, not forever. */
export const DEFAULT_SATAN_IDLE_MS = 900_000;

/** What a pooled value serves: one conversation, of one kind. */
export interface PoolKey {
  conversation: ConversationId;
  kind: SatanKind;
}

/**
 * One value per key, opened on first `acquire` and closed once it has been idle
 * for `idleMs`. Never blocks: a value is opened and handed over as it is made.
 */
export interface SatanPool<T> {
  /** The value for `key`, opened if the pool has none yet. Throws once closed. */
  acquire: (key: PoolKey) => T;
  /** One holder is done with `key`: at the last one the idle countdown starts. */
  release: (key: PoolKey) => void;
  /** Close for good: no `acquire` is answered again, and every value is closed. */
  closeAll: () => Promise<void>;
}

/** A pooled value, and how many calls hold it. */
interface Entry<T> {
  readonly value: T;
  /** Calls that acquired the entry and have not released it. */
  inFlight: number;
  /** The idle countdown, while no call holds the entry. */
  timer?: ReturnType<typeof setTimeout>;
}

/** Entries are keyed by a string: the conversation and the kind, unambiguously joined. */
const keyString = (key: PoolKey): string => `${String(key.conversation)}\u0000${key.kind}`;

export function satanPool<T>(options: {
  /** How long a value survives once no call holds it. */
  idleMs: number;
  /** Makes `key`'s value: called with no call yet holding it. */
  open: (key: PoolKey) => T;
  /** Closes a value: on its expiry, and for every value on `closeAll`. */
  close: (value: T) => Promise<void>;
}): SatanPool<T> {
  const entries = new Map<string, Entry<T>>();
  /** Set by `closeAll`: every value is out of the pool, and none is opened again. */
  let shut = false;

  /**
   * Deletes the entry before closing it, so an `acquire` during the close opens a
   * fresh value instead of reviving one that is on its way out. The close is left
   * to itself: its rejection is the caller's business, not an unhandled one.
   */
  const expire = (id: string, entry: Entry<T>): void => {
    if (entries.get(id) !== entry) {
      return;
    }
    entries.delete(id);
    void options.close(entry.value).catch(() => undefined);
  };

  const acquire = (key: PoolKey): T => {
    if (shut) {
      throw new Error("the pool is closed");
    }
    const id = keyString(key);
    let entry = entries.get(id);
    if (entry === undefined) {
      entry = { value: options.open(key), inFlight: 0 };
      entries.set(id, entry);
    }
    entry.inFlight += 1;
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      delete entry.timer;
    }
    return entry.value;
  };

  const release = (key: PoolKey): void => {
    const id = keyString(key);
    const entry = entries.get(id);
    // Gone means it was closed under the call (by `closeAll`): nothing left to time out.
    if (entry === undefined) {
      return;
    }
    entry.inFlight -= 1;
    if (entry.inFlight > 0) {
      return;
    }
    const timer = setTimeout(() => {
      expire(id, entry);
    }, options.idleMs);
    // An idle entry must not hold the process open.
    timer.unref();
    entry.timer = timer;
  };

  const closeAll = async (): Promise<void> => {
    shut = true;
    const closing = [...entries.values()];
    entries.clear();
    for (const entry of closing) {
      if (entry.timer !== undefined) {
        clearTimeout(entry.timer);
      }
    }
    // A close that fails must not stop the others.
    await Promise.allSettled(closing.map((entry) => options.close(entry.value)));
  };

  return { acquire, release, closeAll };
}
