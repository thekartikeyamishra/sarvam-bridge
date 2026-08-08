/**
 * Single-flight request coalescing.
 *
 * The cache eliminates *sequential* duplicate work. It does nothing for
 * *concurrent* duplicate work, because a hundred simultaneous requests for the
 * same string all miss the cache before any of them has finished populating it.
 *
 * That pattern is not hypothetical here. It is exactly what an IVR burst looks
 * like: a broadcast goes out, a few hundred callers hit the same menu prompt
 * within the same second, and the gateway fans that into a few hundred
 * identical billable synthesis calls. Coalescing collapses them into one
 * upstream request whose result is shared by every waiter.
 *
 * The map is keyed by the same resolved-parameter hash the cache uses, and
 * entries are removed as soon as the underlying promise settles, so a failure
 * is never cached and the next caller retries cleanly.
 */
export class SingleFlight<T> {
  private readonly inFlight = new Map<string, Promise<T>>();

  /**
   * Run `fn` for `key`, or join the existing run if one is already in progress.
   *
   * Every waiter observes the same resolution. Rejections propagate to all
   * waiters and leave nothing behind, so an upstream blip does not poison
   * subsequent attempts.
   */
  async run(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) {
      this.joined += 1;
      return existing;
    }

    // Start eagerly, then register, so concurrent callers arriving during the
    // synchronous part of fn() still find the entry.
    const promise = (async () => fn())();
    this.inFlight.set(key, promise);

    try {
      return await promise;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private joined = 0;

  /** Number of calls that piggybacked on an in-flight request. */
  get coalesced(): number {
    return this.joined;
  }

  get size(): number {
    return this.inFlight.size;
  }
}
