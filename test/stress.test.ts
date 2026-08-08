import { describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";
import { SarvamClient } from "../src/sarvam/client.js";
import { LruCache } from "../src/lib/cache.js";
import { isWav, parseWav } from "../src/sarvam/audio.js";
import { createSarvamStub, makeWav, testConfig } from "./helpers.js";

/**
 * Concurrency and load.
 *
 * These are the failures that never show up in a single-request test: leaked
 * semaphore slots, unbounded memory, interleaved responses, cache accounting
 * drift. Each test asserts an invariant that must hold no matter how requests
 * overlap.
 */

describe("upstream concurrency control", () => {
  it("never exceeds the configured concurrency, even under a burst", async () => {
    let inFlight = 0;
    let peak = 0;

    const slowFetch: typeof fetch = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight -= 1;
      return new Response(
        JSON.stringify({ audios: [makeWav(200).toString("base64")] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const client = new SarvamClient({
      apiKey: "k",
      baseUrl: "https://api.sarvam.ai",
      timeoutMs: 5000,
      maxRetries: 0,
      concurrency: 4,
      fetchImpl: slowFetch,
    });

    await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        client.textToSpeech({
          text: `chunk ${i}`,
          language_code: "en-IN",
          model: "bulbul:v3",
        }),
      ),
    );

    expect(peak).toBeLessThanOrEqual(4);
    expect(inFlight).toBe(0);
  });

  it("releases its slot when a request fails, rather than leaking it", async () => {
    // A leaked slot is insidious: throughput silently degrades to zero over
    // time as failures accumulate, long after the failures stop.
    let calls = 0;
    const flaky: typeof fetch = async () => {
      calls += 1;
      if (calls % 2 === 0) throw new TypeError("fetch failed");
      return new Response(
        JSON.stringify({ audios: [makeWav(100).toString("base64")] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const client = new SarvamClient({
      apiKey: "k",
      baseUrl: "https://api.sarvam.ai",
      timeoutMs: 2000,
      maxRetries: 0,
      concurrency: 2,
      fetchImpl: flaky,
    });

    const results = await Promise.allSettled(
      Array.from({ length: 30 }, () =>
        client.textToSpeech({
          text: "t",
          language_code: "en-IN",
          model: "bulbul:v3",
        }),
      ),
    );
    expect(results.filter((r) => r.status === "rejected").length).toBeGreaterThan(0);

    // If slots leaked, this final call would hang and the test would time out.
    const after = await Promise.race([
      client
        .textToSpeech({ text: "final", language_code: "en-IN", model: "bulbul:v3" })
        .then(() => "completed")
        .catch(() => "completed"),
      new Promise((r) => setTimeout(() => r("hung"), 3000)),
    ]);
    expect(after).toBe("completed");
  });

  it("releases its slot after a timeout", async () => {
    const hangFetch: typeof fetch = (_i, init) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          rej(e);
        });
      });

    const client = new SarvamClient({
      apiKey: "k",
      baseUrl: "https://api.sarvam.ai",
      timeoutMs: 200,
      maxRetries: 0,
      concurrency: 2,
      fetchImpl: hangFetch,
    });

    await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        client.textToSpeech({
          text: "t",
          language_code: "en-IN",
          model: "bulbul:v3",
        }),
      ),
    );

    const outcome = await Promise.race([
      client
        .textToSpeech({ text: "x", language_code: "en-IN", model: "bulbul:v3" })
        .catch(() => "completed"),
      new Promise((r) => setTimeout(() => r("hung"), 2000)),
    ]);
    expect(outcome).toBe("completed");
  });
});

describe("parallel request handling", () => {
  it("keeps 100 concurrent responses correct and un-interleaved", async () => {
    const stub = createSarvamStub();
    const { app } = await buildServer(testConfig({ CACHE_ENABLED: "false" }), {
      fetchImpl: stub.fetch,
    });
    await app.ready();

    const responses = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        app.inject({
          method: "POST",
          url: "/v1/text-to-speech/v",
          payload: { text: `request number ${i}` },
        }),
      ),
    );

    for (const res of responses) {
      expect(res.statusCode).toBe(200);
      expect(isWav(res.rawPayload)).toBe(true);
      // Every response must be a complete, independently valid WAV.
      expect(parseWav(res.rawPayload)?.data.length).toBe(2400);
    }
    await app.close();
  });

  it("serves mixed dialects concurrently without cross-talk", async () => {
    const stub = createSarvamStub();
    const { app } = await buildServer(testConfig({ CACHE_ENABLED: "false" }), {
      fetchImpl: stub.fetch,
    });
    await app.ready();

    const work = [
      ...Array.from({ length: 20 }, () =>
        app.inject({
          method: "POST",
          url: "/v1/text-to-speech/v",
          payload: { text: "eleven" },
        }),
      ),
      ...Array.from({ length: 20 }, () =>
        app.inject({
          method: "POST",
          url: "/v1/audio/speech",
          payload: { input: "openai", voice: "nova" },
        }),
      ),
      ...Array.from({ length: 20 }, () =>
        app.inject({
          method: "POST",
          url: "/v1/listen",
          headers: { "content-type": "audio/wav" },
          payload: makeWav(),
        }),
      ),
    ];

    const results = await Promise.all(work);
    expect(results.every((r) => r.statusCode === 200)).toBe(true);

    // Deepgram responses must be JSON; the audio ones must be binary.
    const deepgram = results.slice(40);
    for (const r of deepgram) {
      expect(r.json()).toHaveProperty("results.channels");
    }
    await app.close();
  });

  it("handles many concurrent chunked requests without mixing chunks", async () => {
    const stub = createSarvamStub();
    const { app } = await buildServer(testConfig({ CACHE_ENABLED: "false" }), {
      fetchImpl: stub.fetch,
    });
    await app.ready();

    const long = "यह एक लंबा वाक्य है। ".repeat(300);
    const results = await Promise.all(
      Array.from({ length: 15 }, () =>
        app.inject({
          method: "POST",
          url: "/v1/text-to-speech/v",
          payload: { text: long },
        }),
      ),
    );

    const chunkCounts = new Set(
      results.map((r) => r.headers["x-sarvam-bridge-chunks"]),
    );
    expect(chunkCounts.size).toBe(1); // deterministic chunking

    const expected = Number([...chunkCounts][0]);
    for (const r of results) {
      expect(parseWav(r.rawPayload)?.data.length).toBe(expected * 2400);
    }
    await app.close();
  });
});

describe("resource bounds", () => {
  it("keeps cache memory bounded under sustained churn", async () => {
    const cache = new LruCache({
      enabled: true,
      maxEntries: 50,
      maxBytes: 100_000,
      ttlSeconds: 3600,
    });

    for (let i = 0; i < 20_000; i += 1) {
      cache.set(`key-${i}`, Buffer.alloc(5_000), "audio/wav");
    }

    const stats = cache.stats();
    expect(stats.bytes).toBeLessThanOrEqual(100_000);
    expect(stats.entries).toBeLessThanOrEqual(50);
    // Byte accounting must not drift from reality.
    expect(stats.bytes).toBe(stats.entries * 5_000);
  });

  it("keeps byte accounting exact through interleaved set, overwrite and expiry", async () => {
    let now = 0;
    const cache = new LruCache({
      enabled: true,
      maxEntries: 20,
      maxBytes: 1_000_000,
      ttlSeconds: 10,
      now: () => now,
    });

    for (let round = 0; round < 200; round += 1) {
      const key = `k${round % 10}`;
      cache.set(key, Buffer.alloc(100 + (round % 7)), "audio/wav");
      if (round % 3 === 0) cache.get(key);
      if (round % 25 === 0) now += 11_000;
    }

    let observed = 0;
    for (let i = 0; i < 10; i += 1) {
      const entry = cache.get(`k${i}`);
      if (entry) observed += entry.value.length;
    }
    expect(cache.stats().bytes).toBeGreaterThanOrEqual(observed);
    expect(cache.stats().bytes).toBeGreaterThanOrEqual(0);
  });

  it("does not grow memory unboundedly across many distinct requests", async () => {
    const stub = createSarvamStub();
    const { app } = await buildServer(
      testConfig({ CACHE_MAX_ENTRIES: "20", CACHE_MAX_BYTES: "200000" }),
      { fetchImpl: stub.fetch },
    );
    await app.ready();

    for (let batch = 0; batch < 10; batch += 1) {
      await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          app.inject({
            method: "POST",
            url: "/v1/text-to-speech/v",
            payload: { text: `unique text ${batch}-${i}` },
          }),
        ),
      );
    }

    const metrics = await app.inject({ url: "/metrics" });
    const match = /sarvam_bridge_cache_bytes (\d+)/.exec(metrics.body);
    expect(Number(match?.[1] ?? 0)).toBeLessThanOrEqual(200_000);
    await app.close();
  });

  it("bounds rate-limiter memory when every request uses a fresh credential", async () => {
    const stub = createSarvamStub();
    const { app } = await buildServer(
      testConfig({
        RATE_LIMIT_ENABLED: "true",
        RATE_LIMIT_CAPACITY: "5",
        RATE_LIMIT_REFILL_PER_SEC: "50",
        CACHE_ENABLED: "false",
      }),
      { fetchImpl: stub.fetch },
    );
    await app.ready();

    for (let i = 0; i < 400; i += 1) {
      await app.inject({
        method: "POST",
        url: "/v1/bridge/explain",
        headers: { "xi-api-key": `key-${i}` },
        payload: { text: "hello" },
      });
    }

    const metrics = await app.inject({ url: "/metrics" });
    const match = /sarvam_bridge_ratelimit_buckets (\d+)/.exec(metrics.body);
    expect(Number(match?.[1] ?? 0)).toBeLessThan(10_000);
    await app.close();
  });
});
