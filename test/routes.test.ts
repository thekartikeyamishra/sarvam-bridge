import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildServer } from "../src/server.js";
import { isWav, parseWav } from "../src/sarvam/audio.js";
import { createSarvamStub, makeWav, testConfig, type FetchStub } from "./helpers.js";

/**
 * End-to-end tests through the real Fastify stack with a stubbed upstream.
 *
 * These assert the property the whole project rests on: an unmodified vendor
 * client gets back exactly the response shape it already parses.
 */

async function build(
  overrides: Record<string, string> = {},
  stubOpts = {},
): Promise<{ app: FastifyInstance; stub: FetchStub }> {
  const stub = createSarvamStub(stubOpts);
  const { app } = await buildServer(testConfig(overrides), { fetchImpl: stub.fetch });
  await app.ready();
  return { app, stub };
}

/** Build a multipart body by hand, as an SDK would. */
function multipart(
  fields: Record<string, string>,
  file: Buffer,
  filename = "audio.wav",
): { body: Buffer; contentType: string } {
  const boundary = "----sarvambridgetest";
  const parts: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/wav\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );

  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe("ElevenLabs compatibility", () => {
  it("returns raw audio bytes, not Sarvam's base64 JSON", async () => {
    // This is the single most common migration bug, per Sarvam's own guide:
    // ElevenLabs returns the audio file, Sarvam returns JSON. Code doing
    // f.write(response.content) silently produces a file full of JSON text.
    const { app } = await build();
    const res = await app.inject({
      method: "POST",
      url: "/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM",
      headers: { "xi-api-key": "client-key" },
      payload: { text: "Welcome to our platform!" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("audio/");
    expect(isWav(res.rawPayload)).toBe(true);
    expect(res.rawPayload.toString("utf8", 0, 1)).not.toBe("{");
    await app.close();
  });

  it("supplies the required language_code that the client never sent", async () => {
    const { app, stub } = await build();
    await app.inject({
      method: "POST",
      url: "/v1/text-to-speech/any-voice",
      payload: { text: "नमस्ते, आप कैसे हैं?" },
    });

    const call = stub.calls.find((c) => c.url.includes("/text-to-speech"));
    expect((call?.body as Record<string, unknown>)["language_code"]).toBe("hi-IN");
    await app.close();
  });

  it("never forwards the caller's credential upstream", async () => {
    const { app, stub } = await build();
    await app.inject({
      method: "POST",
      url: "/v1/text-to-speech/v",
      headers: { "xi-api-key": "SECRET-CLIENT-KEY" },
      payload: { text: "hello" },
    });

    const call = stub.calls[0];
    expect(call?.headers["api-subscription-key"]).toBe("test-key");
    expect(JSON.stringify(call?.headers)).not.toContain("SECRET-CLIENT-KEY");
    await app.close();
  });

  it("chunks over-long input and returns one playable file", async () => {
    const { app, stub } = await build();
    const long = "यह एक लंबा वाक्य है। ".repeat(400); // well past 2500 chars

    const res = await app.inject({
      method: "POST",
      url: "/v1/text-to-speech/v",
      payload: { text: long },
    });

    const upstreamCalls = stub.calls.filter((c) => c.url.includes("/text-to-speech"));
    const chunks = Number(res.headers["x-sarvam-bridge-chunks"]);

    expect(chunks).toBeGreaterThan(1);
    // Upstream calls may be FEWER than chunks: this input repeats the same
    // sentence, so identical chunks are deduplicated by the cache and the
    // in-flight coalescer. Paying once for repeated content is the point.
    expect(upstreamCalls.length).toBeGreaterThan(0);
    expect(upstreamCalls.length).toBeLessThanOrEqual(chunks);

    // Regardless of dedup, the output must contain audio for every chunk,
    // under exactly one header.
    const parsed = parseWav(res.rawPayload);
    expect(parsed).not.toBeNull();
    expect(parsed!.data.length).toBe(chunks * 2400);
    await app.close();
  });

  it("issues one upstream call per chunk when chunks are all distinct", async () => {
    const { app, stub } = await build();
    // Distinct content per sentence, so nothing can be deduplicated.
    let text = "";
    for (let i = 0; i < 400; i += 1) text += `वाक्य संख्या ${i} यहाँ है। `;

    const res = await app.inject({
      method: "POST",
      url: "/v1/text-to-speech/v",
      payload: { text },
    });

    const upstreamCalls = stub.calls.filter((c) => c.url.includes("/text-to-speech"));
    expect(res.headers["x-sarvam-bridge-chunks"]).toBe(String(upstreamCalls.length));
    await app.close();
  });

  it("reports ElevenLabs-only voice settings instead of silently dropping them", async () => {
    const { app } = await build();
    const res = await app.inject({
      method: "POST",
      url: "/v1/text-to-speech/v",
      payload: {
        text: "hello",
        voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.2 },
      },
    });

    const warnings = res.headers["x-sarvam-bridge-warnings"] as string;
    expect(warnings).toContain("stability");
    expect(warnings).toContain("similarity_boost");
    await app.close();
  });

  it("decomposes output_format into codec and sample rate", async () => {
    const { app, stub } = await build();
    await app.inject({
      method: "POST",
      url: "/v1/text-to-speech/v",
      payload: { text: "hello", output_format: "mp3_44100_128" },
    });

    const body = stub.calls[0]?.body as Record<string, unknown>;
    expect(body["output_audio_codec"]).toBe("mp3");
    expect(body["speech_sample_rate"]).toBe(44100);
    await app.close();
  });

  it("clamps speed into the model's valid pace range", async () => {
    const { app, stub } = await build();
    await app.inject({
      method: "POST",
      url: "/v1/text-to-speech/v",
      payload: { text: "hello", voice_settings: { speed: 9 } },
    });

    expect((stub.calls[0]?.body as Record<string, unknown>)["pace"]).toBe(2.0);
    await app.close();
  });

  it("serves an ElevenLabs-shaped voice catalogue", async () => {
    const { app } = await build();
    const res = await app.inject({ method: "GET", url: "/v1/voices" });
    const body = res.json() as { voices: Array<Record<string, unknown>> };

    expect(Array.isArray(body.voices)).toBe(true);
    expect(body.voices.length).toBeGreaterThan(30);
    expect(body.voices[0]).toHaveProperty("voice_id");
    expect(body.voices[0]).toHaveProperty("name");
    await app.close();
  });

  it("renders errors in the ElevenLabs dialect", async () => {
    const { app } = await build();
    const res = await app.inject({
      method: "POST",
      url: "/v1/text-to-speech/v",
      payload: { text: "" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("detail.message");
    await app.close();
  });
});

describe("OpenAI compatibility", () => {
  it("returns audio bytes from /v1/audio/speech", async () => {
    const { app } = await build();
    const res = await app.inject({
      method: "POST",
      url: "/v1/audio/speech",
      headers: { authorization: "Bearer sk-test" },
      payload: { model: "tts-1", input: "Hello there", voice: "nova" },
    });

    expect(res.statusCode).toBe(200);
    expect(isWav(res.rawPayload)).toBe(true);
    await app.close();
  });

  it("preserves the gender implied by the OpenAI voice name", async () => {
    const { app, stub } = await build();
    await app.inject({
      method: "POST",
      url: "/v1/audio/speech",
      payload: { input: "hello", voice: "onyx" },
    });

    const speaker = (stub.calls[0]?.body as Record<string, unknown>)["speaker"];
    expect(["shubh", "ratan", "mani", "aditya"]).toContain(speaker);
    await app.close();
  });

  it("returns Whisper's {text} shape from /v1/audio/transcriptions", async () => {
    const { app } = await build();
    const { body, contentType } = multipart({ model: "whisper-1" }, makeWav());

    const res = await app.inject({
      method: "POST",
      url: "/v1/audio/transcriptions",
      headers: { "content-type": contentType },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ text: "नमस्ते, आप कैसे हैं?" });
    await app.close();
  });

  it("honours response_format=text and vtt", async () => {
    const { app } = await build();

    for (const [format, assertion] of [
      ["text", (b: string) => expect(b).toBe("नमस्ते, आप कैसे हैं?")],
      ["vtt", (b: string) => expect(b.startsWith("WEBVTT")).toBe(true)],
      ["srt", (b: string) => expect(b).toContain("-->")],
    ] as const) {
      const { body, contentType } = multipart({ response_format: format }, makeWav());
      const res = await app.inject({
        method: "POST",
        url: "/v1/audio/transcriptions",
        headers: { "content-type": contentType },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      assertion(res.body);
    }
    await app.close();
  });

  it("computes duration for verbose_json from the audio itself", async () => {
    const { app } = await build();
    const { body, contentType } = multipart(
      { response_format: "verbose_json" },
      makeWav(24000), // exactly one second at 24kHz mono 16-bit
    );

    const res = await app.inject({
      method: "POST",
      url: "/v1/audio/transcriptions",
      headers: { "content-type": contentType },
      payload: body,
    });

    const json = res.json() as { duration: number; segments: unknown[] };
    expect(json.duration).toBeCloseTo(1.0, 3);
    expect(json.segments).toHaveLength(1);
    await app.close();
  });

  it("routes /v1/audio/translations to Sarvam's translate mode", async () => {
    const { app, stub } = await build();
    const { body, contentType } = multipart({}, makeWav());

    await app.inject({
      method: "POST",
      url: "/v1/audio/translations",
      headers: { "content-type": contentType },
      payload: body,
    });

    const call = stub.calls.find((c) => c.url.includes("/speech-to-text"));
    expect((call?.body as Record<string, unknown>)["mode"]).toBe("translate");
    await app.close();
  });

  it("renders errors in the OpenAI dialect", async () => {
    const { app } = await build();
    const res = await app.inject({
      method: "POST",
      url: "/v1/audio/speech",
      payload: { input: "" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("error.message");
    expect(res.json()).toHaveProperty("error.type");
    await app.close();
  });
});

describe("Deepgram compatibility", () => {
  it("returns the nested transcript path Deepgram clients parse", async () => {
    const { app } = await build();
    const res = await app.inject({
      method: "POST",
      url: "/v1/listen?language=hi",
      headers: { "content-type": "audio/wav" },
      payload: makeWav(),
    });

    expect(res.statusCode).toBe(200);
    const json = res.json() as {
      results: { channels: Array<{ alternatives: Array<{ transcript: string }> }> };
      metadata: { duration: number };
    };
    expect(json.results.channels[0]!.alternatives[0]!.transcript).toBe(
      "नमस्ते, आप कैसे हैं?",
    );
    expect(json.metadata.duration).toBeGreaterThan(0);
    await app.close();
  });

  it("rejects URL ingestion with a clear explanation", async () => {
    const { app } = await build();
    const res = await app.inject({
      method: "POST",
      url: "/v1/listen",
      payload: { url: "https://example.com/a.wav" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("err_msg");
    await app.close();
  });
});

describe("caching, resilience and limits", () => {
  it("serves an identical repeat request without touching the upstream", async () => {
    // The cost argument: IVR and agent scripts synthesise the same strings
    // thousands of times a day.
    const { app, stub } = await build();
    const payload = { text: "आपका स्वागत है। कृपया एक विकल्प चुनें।" };

    await app.inject({ method: "POST", url: "/v1/text-to-speech/v", payload });
    const afterFirst = stub.calls.length;

    const second = await app.inject({
      method: "POST",
      url: "/v1/text-to-speech/v",
      payload,
    });

    expect(stub.calls.length).toBe(afterFirst);
    expect(second.headers["x-sarvam-bridge-cache-hits"]).toBe("1");
    expect(isWav(second.rawPayload)).toBe(true);
    await app.close();
  });

  it("retries a 429 and still succeeds", async () => {
    const { app, stub } = await build({}, { failFirst: 1, failStatus: 429 });
    const res = await app.inject({
      method: "POST",
      url: "/v1/text-to-speech/v",
      payload: { text: "hello" },
    });

    expect(res.statusCode).toBe(200);
    expect(stub.calls.length).toBe(2);
    await app.close();
  });

  it("surfaces an upstream key failure as 502, not 403", async () => {
    // A 403 from Sarvam means the *gateway's* key is wrong. Passing that
    // through would send the caller hunting for a problem on their side.
    const { app } = await build(
      { UPSTREAM_MAX_RETRIES: "0" },
      { failFirst: 1, failStatus: 403 },
    );
    const res = await app.inject({
      method: "POST",
      url: "/v1/text-to-speech/v",
      payload: { text: "hello" },
    });

    expect(res.statusCode).toBe(502);
    await app.close();
  });

  it("enforces the rate limit", async () => {
    const { app } = await build({
      RATE_LIMIT_ENABLED: "true",
      RATE_LIMIT_CAPACITY: "2",
      RATE_LIMIT_REFILL_PER_SEC: "0.1",
      CACHE_ENABLED: "false",
    });

    const send = (n: number) =>
      app.inject({
        method: "POST",
        url: "/v1/text-to-speech/v",
        headers: { "xi-api-key": "same-client" },
        payload: { text: `hello ${n}` },
      });

    await send(1);
    await send(2);
    const third = await send(3);

    expect(third.statusCode).toBe(429);
    expect(third.headers["retry-after"]).toBeDefined();
    await app.close();
  });

  it("enforces gateway auth when configured", async () => {
    const { app } = await build({ GATEWAY_AUTH_TOKEN: "shared-secret" });

    const denied = await app.inject({
      method: "POST",
      url: "/v1/text-to-speech/v",
      headers: { "xi-api-key": "wrong" },
      payload: { text: "hello" },
    });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "POST",
      url: "/v1/text-to-speech/v",
      headers: { "xi-api-key": "shared-secret" },
      payload: { text: "hello" },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });
});

describe("operations", () => {
  it("separates liveness from readiness", async () => {
    const { app } = await build();
    expect((await app.inject({ url: "/healthz" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/readyz" })).statusCode).toBe(200);
    await app.close();
  });

  it("exposes Prometheus metrics including cache effectiveness", async () => {
    const { app } = await build();
    const payload = { text: "cache me" };
    await app.inject({ method: "POST", url: "/v1/text-to-speech/v", payload });
    await app.inject({ method: "POST", url: "/v1/text-to-speech/v", payload });

    const res = await app.inject({ url: "/metrics" });
    expect(res.body).toContain("sarvam_bridge_requests_total");
    expect(res.body).toContain("sarvam_bridge_cache_hit_ratio");
    expect(res.body).toContain("sarvam_bridge_request_duration_seconds_bucket");
    await app.close();
  });

  it("explains a translation without spending any upstream credit", async () => {
    const { app, stub } = await build();
    const res = await app.inject({
      method: "POST",
      url: "/v1/bridge/explain",
      payload: { text: "வணக்கம், நீங்கள் எப்படி இருக்கிறீர்கள்?", voice: "unknown-id" },
    });

    const json = res.json() as {
      language: { resolved: string; source: string };
      voice: { resolved: string };
      upstreamCallsRequired: number;
    };

    expect(json.language.resolved).toBe("ta-IN");
    expect(json.language.source).toBe("detected");
    expect(json.voice.resolved).toBeTruthy();
    expect(json.upstreamCallsRequired).toBe(1);
    expect(stub.calls.length).toBe(0); // nothing was actually called
    await app.close();
  });

  it("documents its own surface at the root", async () => {
    const { app } = await build();
    const res = await app.inject({ url: "/" });
    const json = res.json() as { routes: Record<string, string[]> };
    expect(json.routes["elevenlabs"]!.length).toBeGreaterThan(0);
    expect(json.routes["openai"]!.length).toBeGreaterThan(0);
    await app.close();
  });
});

describe("proxy trust", () => {
  it("ignores forged X-Forwarded-For by default", async () => {
    // req.ip is a rate-limit bucketing key. If X-Forwarded-For were trusted
    // blindly, rotating it would hand an attacker unlimited quota.
    const { app } = await build({
      RATE_LIMIT_ENABLED: "true",
      RATE_LIMIT_CAPACITY: "2",
      RATE_LIMIT_REFILL_PER_SEC: "0.1",
      CACHE_ENABLED: "false",
    });

    const send = (forgedIp: string, n: number) =>
      app.inject({
        method: "POST",
        url: "/v1/text-to-speech/v",
        headers: { "x-forwarded-for": forgedIp },
        payload: { text: `hello ${n}` },
      });

    await send("10.0.0.1", 1);
    await send("10.0.0.2", 2);
    const third = await send("10.0.0.3", 3);

    // A new forged IP each time must not reset the bucket.
    expect(third.statusCode).toBe(429);
    await app.close();
  });

  it("honours an explicit trusted-proxy list", async () => {
    const { app } = await build({ TRUST_PROXY: "127.0.0.1,10.0.0.0/8" });
    const res = await app.inject({
      method: "POST",
      url: "/v1/text-to-speech/v",
      payload: { text: "hello" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
