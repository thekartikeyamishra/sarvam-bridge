import { describe, expect, it } from "vitest";
import { TokenBucketLimiter } from "../src/lib/ratelimit.js";

describe("TokenBucketLimiter", () => {
  it("allows a burst up to capacity then refuses", () => {
    let now = 0;
    const limiter = new TokenBucketLimiter({
      enabled: true,
      capacity: 3,
      refillPerSecond: 1,
      now: () => now,
    });

    expect(limiter.consume("k").allowed).toBe(true);
    expect(limiter.consume("k").allowed).toBe(true);
    expect(limiter.consume("k").allowed).toBe(true);

    const denied = limiter.consume("k");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfter).toBeGreaterThan(0);
  });

  it("refills over time", () => {
    let now = 0;
    const limiter = new TokenBucketLimiter({
      enabled: true,
      capacity: 2,
      refillPerSecond: 1,
      now: () => now,
    });
    limiter.consume("k");
    limiter.consume("k");
    expect(limiter.consume("k").allowed).toBe(false);

    now = 2_000;
    expect(limiter.consume("k").allowed).toBe(true);
  });

  it("isolates buckets per key", () => {
    const limiter = new TokenBucketLimiter({
      enabled: true,
      capacity: 1,
      refillPerSecond: 0.1,
    });
    expect(limiter.consume("a").allowed).toBe(true);
    expect(limiter.consume("a").allowed).toBe(false);
    expect(limiter.consume("b").allowed).toBe(true);
  });

  it("is a no-op when disabled", () => {
    const limiter = new TokenBucketLimiter({
      enabled: false,
      capacity: 1,
      refillPerSecond: 1,
    });
    for (let i = 0; i < 50; i += 1) {
      expect(limiter.consume("k").allowed).toBe(true);
    }
  });

  it("does not grow unboundedly when keys are cycled", () => {
    let now = 0;
    const limiter = new TokenBucketLimiter({
      enabled: true,
      capacity: 5,
      refillPerSecond: 100,
      now: () => now,
    });
    for (let i = 0; i < 5_000; i += 1) {
      limiter.consume(`key-${i}`);
      now += 1_000;
    }
    expect(limiter.size).toBeLessThan(1_000);
  });
});
