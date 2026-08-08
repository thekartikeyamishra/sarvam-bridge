/**
 * Token-bucket rate limiting.
 *
 * Protects two things at once: the upstream Sarvam quota (a runaway client
 * loop should not burn the month's credits before anyone notices) and the
 * gateway's own memory, since every in-flight request holds audio buffers.
 *
 * Buckets are keyed per client credential and swept lazily, so an attacker
 * cycling keys cannot grow the map without bound.
 */

export interface RateLimitOptions {
  readonly enabled: boolean;
  /** Maximum burst size. */
  readonly capacity: number;
  /** Sustained refill rate, tokens per second. */
  readonly refillPerSecond: number;
  readonly now?: () => number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  /** Seconds until the next token is available; 0 when allowed. */
  readonly retryAfter: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const SWEEP_INTERVAL_MS = 60_000;
const MAX_BUCKETS = 10_000;

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly opts: Required<RateLimitOptions>;
  private lastSweep: number;

  constructor(opts: RateLimitOptions) {
    this.opts = { now: () => Date.now(), ...opts };
    this.lastSweep = this.opts.now();
  }

  consume(key: string, cost = 1): RateLimitResult {
    if (!this.opts.enabled) {
      return { allowed: true, remaining: this.opts.capacity, retryAfter: 0 };
    }

    const now = this.opts.now();
    this.maybeSweep(now);

    let bucket = this.buckets.get(key);
    if (!bucket) {
      // Hard cap on distinct buckets, so key-cycling cannot exhaust memory.
      if (this.buckets.size >= MAX_BUCKETS) this.sweep(now, true);
      bucket = { tokens: this.opts.capacity, updatedAt: now };
      this.buckets.set(key, bucket);
    }

    const elapsedSec = Math.max(0, (now - bucket.updatedAt) / 1000);
    bucket.tokens = Math.min(
      this.opts.capacity,
      bucket.tokens + elapsedSec * this.opts.refillPerSecond,
    );
    bucket.updatedAt = now;

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        retryAfter: 0,
      };
    }

    const deficit = cost - bucket.tokens;
    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.ceil(deficit / this.opts.refillPerSecond),
    };
  }

  private maybeSweep(now: number): void {
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) return;
    this.sweep(now, false);
  }

  /** Drop buckets that have refilled completely; they carry no state. */
  private sweep(now: number, aggressive: boolean): void {
    this.lastSweep = now;
    const fullAfterMs = (this.opts.capacity / this.opts.refillPerSecond) * 1000;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt >= fullAfterMs) {
        this.buckets.delete(key);
      }
    }
    if (aggressive && this.buckets.size >= MAX_BUCKETS) {
      const excess = this.buckets.size - Math.floor(MAX_BUCKETS / 2);
      let removed = 0;
      for (const key of this.buckets.keys()) {
        if (removed >= excess) break;
        this.buckets.delete(key);
        removed += 1;
      }
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}
