import { createHash } from "node:crypto";

/**
 * Response cache.
 *
 * This is the single biggest cost lever in the whole gateway, and it exists
 * because of a property specific to the workloads Sarvam serves. IVR menus,
 * collection-agent scripts, government scheme explainers and tutor prompts
 * synthesise the *same* strings over and over, thousands of times a day. Every
 * one of those is a billable request returning byte-identical audio.
 *
 * A bounded in-process LRU removes that spend entirely, with no change to
 * application behaviour. Bounded is the operative word: audio buffers are large,
 * so eviction is driven by a byte budget as well as an entry count, which keeps
 * the resident set predictable and the container OOM-free.
 *
 * The cache is deliberately in-process rather than Redis-backed. It needs no
 * extra infrastructure, survives the only failure mode that matters (a cold
 * start just re-synthesises), and keeps the deployment story to one container.
 * `CacheStore` is an interface so a shared backend can be dropped in later
 * without touching call sites.
 */

export interface CacheEntry {
  readonly value: Buffer;
  readonly contentType: string;
  readonly expiresAt: number;
}

export interface CacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly entries: number;
  readonly bytes: number;
  readonly evictions: number;
}

export interface CacheStore {
  get(key: string): CacheEntry | undefined;
  set(key: string, value: Buffer, contentType: string): void;
  clear(): void;
  stats(): CacheStats;
}

export interface CacheOptions {
  readonly enabled: boolean;
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly ttlSeconds: number;
  /** Injectable clock, for deterministic tests. */
  readonly now?: () => number;
}

/**
 * Build a stable cache key from the fully-resolved upstream parameters.
 *
 * Hashing the *resolved* request rather than the inbound one matters: two
 * callers using different vendor dialects that normalise to the same Sarvam
 * call should share a cache entry.
 */
export function cacheKey(parts: Record<string, unknown>): string {
  const canonical = Object.keys(parts)
    .sort()
    .map((k) => `${k}=${String(parts[k] ?? "")}`)
    .join("\u0000");
  return createHash("sha256").update(canonical).digest("hex");
}

export class LruCache implements CacheStore {
  // Map preserves insertion order, which gives us LRU for free: delete and
  // re-set on access moves an entry to the most-recent end.
  private readonly map = new Map<string, CacheEntry>();
  private readonly opts: Required<CacheOptions>;
  private bytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(opts: CacheOptions) {
    this.opts = { now: () => Date.now(), ...opts };
  }

  get(key: string): CacheEntry | undefined {
    if (!this.opts.enabled) return undefined;

    const entry = this.map.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= this.opts.now()) {
      this.map.delete(key);
      this.bytes -= entry.value.length;
      this.misses += 1;
      return undefined;
    }

    this.map.delete(key);
    this.map.set(key, entry);
    this.hits += 1;
    return entry;
  }

  set(key: string, value: Buffer, contentType: string): void {
    if (!this.opts.enabled || this.opts.maxEntries === 0) return;
    // Never let one oversized object evict the entire working set.
    if (value.length > this.opts.maxBytes) return;

    const existing = this.map.get(key);
    if (existing) {
      this.bytes -= existing.value.length;
      this.map.delete(key);
    }

    this.map.set(key, {
      value,
      contentType,
      expiresAt: this.opts.now() + this.opts.ttlSeconds * 1000,
    });
    this.bytes += value.length;
    this.evict();
  }

  private evict(): void {
    while (
      this.map.size > this.opts.maxEntries ||
      this.bytes > this.opts.maxBytes
    ) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      const entry = this.map.get(oldest.value);
      if (entry) this.bytes -= entry.value.length;
      this.map.delete(oldest.value);
      this.evictions += 1;
    }
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }

  stats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      entries: this.map.size,
      bytes: this.bytes,
      evictions: this.evictions,
    };
  }
}
