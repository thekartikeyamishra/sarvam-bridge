import type { Config } from "./config.js";
import { LruCache, type CacheStore } from "./lib/cache.js";
import { Metrics } from "./lib/metrics.js";
import { SingleFlight } from "./lib/singleflight.js";
import { TokenBucketLimiter } from "./lib/ratelimit.js";
import { SarvamClient } from "./sarvam/client.js";
import type { SynthesisDeps } from "./sarvam/synthesis.js";
import { parseVoiceMap, type TtsModel } from "./sarvam/voices.js";

/**
 * Composition root. Everything stateful is constructed once here and passed
 * explicitly, which keeps the routes pure functions of their inputs and makes
 * the whole gateway trivial to instantiate inside a test with a fake fetch.
 */

export interface AppContext {
  readonly config: Config;
  readonly client: SarvamClient;
  readonly cache: CacheStore;
  readonly limiter: TokenBucketLimiter;
  readonly metrics: Metrics;
  readonly voiceMap: Readonly<Record<string, string>>;
  readonly inFlight: SingleFlight<Buffer>;
  readonly synthesisDeps: SynthesisDeps;
}

export interface BuildContextOptions {
  /** Injected in tests to stub the upstream without a network. */
  readonly fetchImpl?: typeof fetch;
}

export function buildContext(
  config: Config,
  opts: BuildContextOptions = {},
): AppContext {
  const client = new SarvamClient({
    apiKey: config.SARVAM_API_KEY,
    baseUrl: config.SARVAM_BASE_URL,
    timeoutMs: config.UPSTREAM_TIMEOUT_MS,
    maxRetries: config.UPSTREAM_MAX_RETRIES,
    concurrency: config.UPSTREAM_CONCURRENCY,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });

  const cache = new LruCache({
    enabled: config.CACHE_ENABLED,
    maxEntries: config.CACHE_MAX_ENTRIES,
    maxBytes: config.CACHE_MAX_BYTES,
    ttlSeconds: config.CACHE_TTL_SECONDS,
  });

  const limiter = new TokenBucketLimiter({
    enabled: config.RATE_LIMIT_ENABLED,
    capacity: config.RATE_LIMIT_CAPACITY,
    refillPerSecond: config.RATE_LIMIT_REFILL_PER_SEC,
  });

  const voiceMap = parseVoiceMap(process.env["VOICE_MAP"]);

  const inFlight = new SingleFlight<Buffer>();

  const synthesisDeps: SynthesisDeps = {
    client,
    cache,
    inFlight,
    defaults: {
      model: config.DEFAULT_TTS_MODEL as TtsModel,
      language: config.DEFAULT_LANGUAGE,
      speaker: config.DEFAULT_SPEAKER,
    },
    voiceMap,
  };

  return {
    config,
    client,
    cache,
    limiter,
    metrics: new Metrics(),
    voiceMap,
    inFlight,
    synthesisDeps,
  };
}
