// One run at a time, and at most one more queued behind it (SL-028 design §4.3).

/** A caller waiting for the run that will settle it. */
interface Waiter {
  resolve: () => void;
  reject: (error: unknown) => void;
}

/**
 * Wraps `work` so that at most one run is in flight: a call made during one
 * shares the single run that follows it, so no caller gets a run that began
 * before its request, and runs happen in call order. A failed run rejects only
 * the callers it ran for.
 */
export function coalesce(work: () => Promise<void>): () => Promise<void> {
  let waiting: Waiter[] = [];
  let running = false;

  /** Runs `work` once, then settles `batch` with its outcome. */
  const settle = async (batch: readonly Waiter[]): Promise<void> => {
    try {
      await work();
      for (const waiter of batch) {
        waiter.resolve();
      }
    } catch (error) {
      for (const waiter of batch) {
        waiter.reject(error);
      }
    }
  };

  /** Runs the queued work until nobody is left waiting. */
  const drain = async (): Promise<void> => {
    running = true;
    while (waiting.length > 0) {
      const batch = waiting;
      waiting = [];
      await settle(batch);
    }
    running = false;
  };

  return (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      waiting.push({ resolve, reject });
      if (!running) {
        void drain();
      }
    });
}
