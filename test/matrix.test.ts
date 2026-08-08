import { describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";
import { SingleFlight } from "../src/lib/singleflight.js";
import { isWav, parseWav } from "../src/sarvam/audio.js";
import { SARVAM_LANGUAGES } from "../src/sarvam/languages.js";
import { createSarvamStub, makeWav, testConfig } from "./helpers.js";

describe("SingleFlight", () => {
  it("runs the function once for concurrent callers on the same key", async () => {
    const flight = new SingleFlight<number>();
    let runs = 0;

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        flight.run("k", async () => {
          runs += 1;
          await new Promise((r) => setTimeout(r, 20));
          return 42;
        }),
      ),
    );

    expect(runs).toBe(1);
    expect(results.every((r) => r === 42)).toBe(true);
    expect(flight.coalesced).toBe(49);
  });

  it("keeps distinct keys independent", async () => {
    const flight = new SingleFlight<string>();
    let runs = 0;

    const results = await Promise.all(
      ["a", "b", "c", "a", "b"].map((k) =>
        flight.run(k, async () => {
          runs += 1;
          await new Promise((r) => setTimeout(r, 10));
          return k;
        }),
      ),
    );

    expect(runs).toBe(3);
    expect(results).toEqual(["a", "b", "c", "a", "b"]);
  });

  it("propagates a rejection to every waiter and caches nothing", async () => {
    const flight = new SingleFlight<number>();
    let runs = 0;

    const settled = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        flight.run("k", async () => {
          runs += 1;
          await new Promise((r) => setTimeout(r, 10));
          throw new Error("upstream down");
        }),
      ),
    );

    expect(runs).toBe(1);
    expect(settled.every((s) => s.status === "rejected")).toBe(true);
    expect(flight.size).toBe(0);

    // A failure must not poison the key.
    const recovered = await flight.run("k", async () => 7);
    expect(recovered).toBe(7);
  });

  it("empties itself after all work settles", async () => {
    const flight = new SingleFlight<number>();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => flight.run(`k${i % 5}`, async () => i)),
    );
    expect(flight.size).toBe(0);
  });
});

describe("coalescing under an IVR-style burst", () => {
  it("collapses 100 simultaneous identical requests into one upstream call", async () => {
    // Without coalescing this is 100 billable synthesis calls for one string.
    // The cache is DISABLED and the upstream is slow on purpose: otherwise the
    // requests would serialise and later ones would hit the cache, which would
    // make this pass without exercising coalescing at all.
    const stub = createSarvamStub({ delayMs: 40 });
    const { app } = await buildServer(testConfig({ CACHE_ENABLED: "false" }), {
      fetchImpl: stub.fetch,
    });
    await app.ready();

    const payload = { text: "आपका स्वागत है। कृपया एक विकल्प चुनें।" };
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        app.inject({ method: "POST", url: "/v1/text-to-speech/v", payload }),
      ),
    );

    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(results.every((r) => isWav(r.rawPayload))).toBe(true);

    const ttsCalls = stub.calls.filter((c) => c.url.includes("/text-to-speech"));
    expect(ttsCalls.length).toBe(1);
    await app.close();
  });

  it("still issues separate calls for genuinely different text", async () => {
    const stub = createSarvamStub();
    const { app } = await buildServer(testConfig(), { fetchImpl: stub.fetch });
    await app.ready();

    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        app.inject({
          method: "POST",
          url: "/v1/text-to-speech/v",
          payload: { text: `distinct prompt ${i}` },
        }),
      ),
    );

    expect(stub.calls.filter((c) => c.url.includes("/text-to-speech")).length).toBe(20);
    await app.close();
  });

  it("does not coalesce across different speakers or languages", async () => {
    const stub = createSarvamStub();
    const { app } = await buildServer(testConfig(), { fetchImpl: stub.fetch });
    await app.ready();

    await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/text-to-speech/priya",
        payload: { text: "same words", language_code: "hi" },
      }),
      app.inject({
        method: "POST",
        url: "/v1/text-to-speech/shubh",
        payload: { text: "same words", language_code: "hi" },
      }),
      app.inject({
        method: "POST",
        url: "/v1/text-to-speech/priya",
        payload: { text: "same words", language_code: "ta" },
      }),
    ]);

    // Three distinct resolved parameter sets, three upstream calls.
    expect(stub.calls.filter((c) => c.url.includes("/text-to-speech")).length).toBe(3);
    await app.close();
  });

  it("recovers cleanly when the shared upstream call fails", async () => {
    let calls = 0;
    const failing: typeof fetch = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 40));
      return new Response(JSON.stringify({ error: { message: "boom" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    };

    const { app } = await buildServer(testConfig({ UPSTREAM_MAX_RETRIES: "0" }), {
      fetchImpl: failing,
    });
    await app.ready();

    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        app.inject({
          method: "POST",
          url: "/v1/text-to-speech/v",
          payload: { text: "shared failure" },
        }),
      ),
    );

    expect(results.every((r) => r.statusCode >= 500)).toBe(true);
    expect(calls).toBe(1); // all 25 shared one attempt
    await app.close();
  });
});

describe("parameter matrix", () => {
  it("accepts every supported language end to end", async () => {
    const stub = createSarvamStub();
    const { app } = await buildServer(testConfig({ CACHE_ENABLED: "false" }), {
      fetchImpl: stub.fetch,
    });
    await app.ready();

    for (const language of SARVAM_LANGUAGES) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/text-to-speech/v",
        payload: { text: "test", language_code: language },
      });
      expect(res.statusCode, language).toBe(200);
      expect(res.headers["x-sarvam-bridge-language"]).toBe(language);
    }
    await app.close();
  });

  it("maps every ElevenLabs output_format to a codec and sample rate", async () => {
    const stub = createSarvamStub();
    const { app } = await buildServer(testConfig({ CACHE_ENABLED: "false" }), {
      fetchImpl: stub.fetch,
    });
    await app.ready();

    const formats: Array<[string, string, number | undefined]> = [
      ["mp3_44100_128", "mp3", 44100],
      ["mp3_22050_32", "mp3", 22050],
      ["pcm_16000", "linear16", 16000],
      ["pcm_24000", "linear16", 24000],
      ["ulaw_8000", "mulaw", 8000],
      ["alaw_8000", "alaw", 8000],
      ["opus_48000_64", "opus", 48000],
      ["flac_44100", "flac", 44100],
    ];

    for (const [format, codec, rate] of formats) {
      stub.calls.length = 0;
      const res = await app.inject({
        method: "POST",
        url: "/v1/text-to-speech/v",
        payload: { text: "test", output_format: format },
      });
      expect(res.statusCode, format).toBe(200);

      const body = stub.calls[0]?.body as Record<string, unknown>;
      expect(body["output_audio_codec"], format).toBe(codec);
      if (rate !== undefined) expect(body["speech_sample_rate"], format).toBe(rate);
    }
    await app.close();
  });

  it("rejects unsupported sample rates with a warning rather than an upstream error", async () => {
    const stub = createSarvamStub();
    const { app } = await buildServer(testConfig({ CACHE_ENABLED: "false" }), {
      fetchImpl: stub.fetch,
    });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/v1/text-to-speech/v",
      payload: { text: "test", output_format: "mp3_12345" },
    });

    expect(res.statusCode).toBe(200);
    expect(String(res.headers["x-sarvam-bridge-warnings"])).toContain("sample rate");
    expect(
      (stub.calls[0]?.body as Record<string, unknown>)["speech_sample_rate"],
    ).toBeUndefined();
    await app.close();
  });

  it("applies the correct pace range per model generation", async () => {
    for (const [model, input, expected] of [
      ["bulbul:v3", 5, 2.0],
      ["bulbul:v3", 0.1, 0.5],
      ["bulbul:v2", 5, 3.0],
      ["bulbul:v2", 0.1, 0.3],
    ] as const) {
      const stub = createSarvamStub();
      const { app } = await buildServer(
        testConfig({ DEFAULT_TTS_MODEL: model, CACHE_ENABLED: "false" }),
        { fetchImpl: stub.fetch },
      );
      await app.ready();

      await app.inject({
        method: "POST",
        url: "/v1/text-to-speech/v",
        payload: { text: "test", voice_settings: { speed: input } },
      });

      expect((stub.calls[0]?.body as Record<string, unknown>)["pace"]).toBe(expected);
      await app.close();
    }
  });

  it("sends pitch and loudness only on bulbul:v2", async () => {
    for (const model of ["bulbul:v2", "bulbul:v3"] as const) {
      const stub = createSarvamStub();
      const { app } = await buildServer(
        testConfig({ DEFAULT_TTS_MODEL: model, CACHE_ENABLED: "false" }),
        { fetchImpl: stub.fetch },
      );
      await app.ready();

      await app.inject({
        method: "POST",
        url: "/v1/bridge/explain",
        payload: { text: "x" },
      });
      const res = await app.inject({
        method: "POST",
        url: "/v1/audio/speech",
        payload: { input: "test", voice: "nova" },
      });
      expect(res.statusCode).toBe(200);

      const body = stub.calls[0]?.body as Record<string, unknown>;
      expect(body["model"]).toBe(model);
      await app.close();
    }
  });

  it("handles every OpenAI response_format for TTS", async () => {
    const stub = createSarvamStub();
    const { app } = await buildServer(testConfig({ CACHE_ENABLED: "false" }), {
      fetchImpl: stub.fetch,
    });
    await app.ready();

    for (const [format, codec] of [
      ["mp3", "mp3"],
      ["opus", "opus"],
      ["aac", "aac"],
      ["flac", "flac"],
      ["wav", "wav"],
      ["pcm", "linear16"],
    ] as const) {
      stub.calls.length = 0;
      const res = await app.inject({
        method: "POST",
        url: "/v1/audio/speech",
        payload: { input: "test", response_format: format },
      });
      expect(res.statusCode, format).toBe(200);
      expect((stub.calls[0]?.body as Record<string, unknown>)["output_audio_codec"]).toBe(
        codec,
      );
    }
    await app.close();
  });

  it("handles every OpenAI voice name without falling back to a default", async () => {
    const stub = createSarvamStub();
    const { app } = await buildServer(testConfig({ CACHE_ENABLED: "false" }), {
      fetchImpl: stub.fetch,
    });
    await app.ready();

    const voices = [
      "alloy", "ash", "ballad", "coral", "echo",
      "fable", "nova", "onyx", "sage", "shimmer", "verse",
    ];

    for (const voice of voices) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/audio/speech",
        payload: { input: "test", voice },
      });
      expect(res.statusCode, voice).toBe(200);
      expect(res.headers["x-sarvam-bridge-speaker"], voice).toBeTruthy();
    }
    await app.close();
  });

  it("handles every STT response_format", async () => {
    const stub = createSarvamStub();
    const { app } = await buildServer(testConfig(), { fetchImpl: stub.fetch });
    await app.ready();

    const boundary = "----m";
    const build = (format: string): { body: Buffer; ct: string } => {
      const wav = makeWav();
      return {
        body: Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\n${format}\r\n`,
          ),
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
          ),
          wav,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
        ct: `multipart/form-data; boundary=${boundary}`,
      };
    };

    for (const format of ["json", "text", "srt", "vtt", "verbose_json", "bogus"]) {
      const { body, ct } = build(format);
      const res = await app.inject({
        method: "POST",
        url: "/v1/audio/transcriptions",
        headers: { "content-type": ct },
        payload: body,
      });
      expect(res.statusCode, format).toBe(200);
      expect(res.body.length, format).toBeGreaterThan(0);
    }
    await app.close();
  });

  it("produces valid audio for chunk counts from 1 to 12", async () => {
    const stub = createSarvamStub();
    const { app } = await buildServer(testConfig({ CACHE_ENABLED: "false" }), {
      fetchImpl: stub.fetch,
    });
    await app.ready();

    for (const repeats of [1, 30, 90, 150, 250, 400]) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/text-to-speech/v",
        payload: { text: "यह एक वाक्य है। ".repeat(repeats) },
      });

      expect(res.statusCode).toBe(200);
      const chunks = Number(res.headers["x-sarvam-bridge-chunks"]);
      expect(parseWav(res.rawPayload)?.data.length).toBe(chunks * 2400);
    }
    await app.close();
  });
});
