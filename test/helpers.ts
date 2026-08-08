import { buildWavHeader } from "../src/sarvam/audio.js";
import { loadConfig, type Config } from "../src/config.js";

/** Build a valid mono 16-bit WAV of the requested sample count. */
export function makeWav(samples = 1200, sampleRate = 24000): Buffer {
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    // A quiet sine, so concatenation artefacts would be audible if they existed.
    pcm.writeInt16LE(Math.round(Math.sin(i / 12) * 8000), i * 2);
  }
  const header = buildWavHeader(
    { audioFormat: 1, channels: 1, sampleRate, bitsPerSample: 16 },
    pcm.length,
  );
  return Buffer.concat([header, pcm]);
}

export interface StubCall {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

export interface StubOptions {
  /** Force a status for the first N calls, to exercise retry paths. */
  readonly failFirst?: number;
  readonly failStatus?: number;
  readonly transcript?: string;
  readonly languageCode?: string;
  /**
   * Artificial upstream latency. Essential for testing coalescing: with an
   * instant stub, requests complete one at a time and later ones hit the
   * cache, which would make a coalescing test pass for the wrong reason.
   */
  readonly delayMs?: number;
}

export interface FetchStub {
  readonly fetch: typeof fetch;
  readonly calls: StubCall[];
}

/** A stand-in for the Sarvam API, so tests never touch the network. */
export function createSarvamStub(opts: StubOptions = {}): FetchStub {
  const calls: StubCall[] = [];
  let failuresRemaining = opts.failFirst ?? 0;

  const stub: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : String(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(
      (init?.headers ?? {}) as Record<string, string>,
    )) {
      headers[k.toLowerCase()] = v;
    }

    let parsedBody: unknown = null;
    if (typeof init?.body === "string") {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    } else if (init?.body instanceof FormData) {
      const asObject: Record<string, unknown> = {};
      for (const [k, v] of init.body.entries()) {
        asObject[k] = v instanceof Blob ? `<blob:${v.size}>` : v;
      }
      parsedBody = asObject;
    }

    calls.push({
      url,
      method: init?.method ?? "GET",
      body: parsedBody,
      headers,
    });

    if (opts.delayMs && opts.delayMs > 0) {
      await new Promise((r) => setTimeout(r, opts.delayMs));
    }

    if (failuresRemaining > 0) {
      failuresRemaining -= 1;
      return new Response(JSON.stringify({ error: { message: "throttled" } }), {
        status: opts.failStatus ?? 429,
        headers: { "content-type": "application/json", "retry-after": "0" },
      });
    }

    if (url.includes("/text-to-speech")) {
      return new Response(
        JSON.stringify({
          request_id: "stub-tts",
          audios: [makeWav().toString("base64")],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url.includes("/speech-to-text")) {
      return new Response(
        JSON.stringify({
          request_id: "stub-stt",
          transcript: opts.transcript ?? "नमस्ते, आप कैसे हैं?",
          language_code: opts.languageCode ?? "hi-IN",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    return new Response("not found", { status: 404 });
  };

  return { fetch: stub, calls };
}

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    SARVAM_API_KEY: "test-key",
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    RATE_LIMIT_ENABLED: "false",
    CACHE_ENABLED: "true",
    UPSTREAM_MAX_RETRIES: "2",
    ...overrides,
  } as NodeJS.ProcessEnv);
}
