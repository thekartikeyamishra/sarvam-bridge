import { describe, expect, it } from "vitest";
import { LruCache, cacheKey } from "../src/lib/cache.js";

const base = {
  enabled: true,
  maxEntries: 3,
  maxBytes: 1_000,
  ttlSeconds: 60,
};

describe("cacheKey", () => {
  it("is order-independent", () => {
    expect(cacheKey({ a: 1, b: 2 })).toBe(cacheKey({ b: 2, a: 1 }));
  });

  it("separates different parameter sets", () => {
    expect(cacheKey({ speaker: "priya" })).not.toBe(cacheKey({ speaker: "kavya" }));
  });
});

describe("LruCache", () => {
  it("stores and returns entries", () => {
    const cache = new LruCache(base);
    cache.set("k", Buffer.from("audio"), "audio/wav");
    expect(cache.get("k")?.value.toString()).toBe("audio");
    expect(cache.stats().hits).toBe(1);
  });

  it("evicts least-recently-used entries beyond the count limit", () => {
    const cache = new LruCache(base);
    cache.set("a", Buffer.alloc(10), "audio/wav");
    cache.set("b", Buffer.alloc(10), "audio/wav");
    cache.set("c", Buffer.alloc(10), "audio/wav");
    cache.get("a"); // refresh a, making b the oldest
    cache.set("d", Buffer.alloc(10), "audio/wav");

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
  });

  it("respects the byte budget, which is what keeps the container alive", () => {
    const cache = new LruCache({ ...base, maxEntries: 100, maxBytes: 100 });
    for (let i = 0; i < 10; i += 1) {
      cache.set(`k${i}`, Buffer.alloc(30), "audio/wav");
    }
    expect(cache.stats().bytes).toBeLessThanOrEqual(100);
    expect(cache.stats().evictions).toBeGreaterThan(0);
  });

  it("refuses a single object larger than the whole budget", () => {
    const cache = new LruCache({ ...base, maxBytes: 100 });
    cache.set("huge", Buffer.alloc(500), "audio/wav");
    expect(cache.stats().entries).toBe(0);
  });

  it("expires entries after the TTL", () => {
    let now = 0;
    const cache = new LruCache({ ...base, ttlSeconds: 10, now: () => now });
    cache.set("k", Buffer.alloc(5), "audio/wav");
    now = 9_000;
    expect(cache.get("k")).toBeDefined();
    now = 11_000;
    expect(cache.get("k")).toBeUndefined();
  });

  it("is a no-op when disabled", () => {
    const cache = new LruCache({ ...base, enabled: false });
    cache.set("k", Buffer.alloc(5), "audio/wav");
    expect(cache.get("k")).toBeUndefined();
  });

  it("does not double-count bytes when a key is overwritten", () => {
    const cache = new LruCache(base);
    cache.set("k", Buffer.alloc(10), "audio/wav");
    cache.set("k", Buffer.alloc(20), "audio/wav");
    expect(cache.stats().bytes).toBe(20);
    expect(cache.stats().entries).toBe(1);
  });
});
