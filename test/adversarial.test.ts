import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildServer } from "../src/server.js";
import { isWav } from "../src/sarvam/audio.js";
import { createSarvamStub, makeWav, testConfig, type FetchStub } from "./helpers.js";

/**
 * Adversarial input.
 *
 * Everything here is something a hostile or merely careless caller can send.
 * The bar is: the gateway must never crash, never hang, never emit a malformed
 * HTTP response, and never let caller-controlled bytes escape into a context
 * where they change meaning (headers, logs, metrics).
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

describe("header safety", () => {
  it("does not crash when an unknown voice id contains non-ASCII", async () => {
    // The unknown-voice warning embeds the caller's voice id, and warnings go
    // into an HTTP header. Node throws on non-latin1 header values, so an
    // unvalidated echo here is a remote crash.
    const { app } = await build();
    const res = await app.inject({
      method: "POST",
      url: `/v1/text-to-speech/${encodeURIComponent("वॉइस-आईडी-😀")}`,
      payload: { text: "hello" },
    });

    expect(res.statusCode).toBe(200);
    expect(isWav(res.rawPayload)).toBe(true);
  });

  it("neutralises CRLF injection attempts in a voice id", async () => {
    const { app } = await build();
    const res = await app.inject({
      method: "POST",
      url: `/v1/text-to-speech/${encodeURIComponent("x\r\nX-Injected: evil")}`,
      payload: { text: "hello" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-injected"]).toBeUndefined();
    const warnings = String(res.headers["x-sarvam-bridge-warnings"] ?? "");
    expect(warnings).not.toContain("\r");
    expect(warnings).not.toContain("\n");
  });

  it("caps warning header length so upstream proxies do not reject the response", async () => {
    const { app } = await build();
    const res = await app.inject({
      method: "POST",
      url: `/v1/text-to-speech/${"v".repeat(4000)}`,
      payload: { text: "hello", voice_settings: { stability: 1, style: 1 } },
    });

    const warnings = String(res.headers["x-sarvam-bridge-warnings"] ?? "");
    expect(warnings.length).toBeLessThanOrEqual(2000);
  });
});

describe("hostile and degenerate text", () => {
  const cases: Array<[string, string]> = [
    ["null bytes", "hello\u0000world"],
    ["control characters", "a\u0001\u0002\u0007b"],
    ["only emoji", "😀😀😀👨‍👩‍👧‍👦"],
    ["RTL text", "مرحبا بالعالم"],
    ["zero-width joiners", "क\u200dख\u200dग"],
    ["mixed scripts", "hello नमस्ते வணக்கம் নমস্কার"],
    ["combining marks only", "\u0901\u0902\u0903"],
    ["very long single word", "क".repeat(9000)],
    ["punctuation only", "।।।।।।।।।।"],
    ["newlines only", "\n\n\n\n"],
    ["html", "<script>alert(1)</script>"],
    ["json injection", '{"a":"b"}'],
    ["sql-ish", "'; DROP TABLE voices; --"],
  ];

  for (const [name, text] of cases) {
    it(`handles ${name} without crashing`, async () => {
      const { app } = await build();
      const res = await app.inject({
        method: "POST",
        url: "/v1/text-to-speech/v",
        payload: { text },
      });

      // Either it synthesises, or it rejects cleanly. Never a 5xx.
      expect([200, 400]).toContain(res.statusCode);
      if (res.statusCode === 200) expect(res.rawPayload.length).toBeGreaterThan(0);
      await app.close();
    });
  }

  it("rejects whitespace-only text as a client error, not a server error", async () => {
    const { app } = await build();
    for (const text of ["", "   ", "\t\n ", "\u00a0"]) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/text-to-speech/v",
        payload: { text },
      });
      expect(res.statusCode).toBe(400);
    }
    await app.close();
  });
});

describe("malformed requests", () => {
  it("rejects wrong types without a stack trace escaping", async () => {
    const { app } = await build();
    const payloads: unknown[] = [
      { text: 123 },
      { text: null },
      { text: ["a", "b"] },
      { text: { nested: true } },
      {},
      [],
      null,
    ];

    for (const payload of payloads) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/text-to-speech/v",
        payload: payload as never,
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain("at Object.");
      expect(res.body).not.toContain("node_modules");
    }
    await app.close();
  });

  it("rejects invalid JSON with 400, not 500", async () => {
    const { app } = await build();
    const res = await app.inject({
      method: "POST",
      url: "/v1/text-to-speech/v",
      headers: { "content-type": "application/json" },
      payload: "{ not json",
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("tolerates an absent body on a JSON route", async () => {
    const { app } = await build();
    const res = await app.inject({
      method: "POST",
      url: "/v1/text-to-speech/v",
      headers: { "content-type": "application/json" },
      payload: "",
    });
    expect(res.statusCode).toBe(400); // missing text, but cleanly
    await app.close();
  });

  it("survives deeply nested JSON without blowing the stack", async () => {
    const { app } = await build();
    let nested: Record<string, unknown> = { end: true };
    for (let i = 0; i < 2000; i += 1) nested = { n: nested };

    const res = await app.inject({
      method: "POST",
      url: "/v1/text-to-speech/v",
      payload: { text: "hi", voice_settings: nested } as never,
    });
    expect([200, 400, 413]).toContain(res.statusCode);
    await app.close();
  });

  it("rejects an oversized body at the configured limit", async () => {
    const { app } = await build({ MAX_UPLOAD_BYTES: "2048" });
    const res = await app.inject({
      method: "POST",
      url: "/v1/text-to-speech/v",
      payload: { text: "x".repeat(50_000) },
    });
    expect([400, 413]).toContain(res.statusCode);
    await app.close();
  });

  it("handles a missing content-type on the Deepgram raw-audio route", async () => {
    const { app } = await build();
    const res = await app.inject({
      method: "POST",
      url: "/v1/listen",
      payload: makeWav(),
    });
    expect(res.statusCode).toBeLessThan(500);
    await app.close();
  });

  it("rejects a multipart upload with no file part", async () => {
    const { app } = await build();
    const boundary = "----x";
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${boundary}--\r\n`;

    const res = await app.inject({
      method: "POST",
      url: "/v1/audio/transcriptions",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a non-multipart body on a transcription route", async () => {
    const { app } = await build();
    const res = await app.inject({
      method: "POST",
      url: "/v1/audio/transcriptions",
      payload: { model: "whisper-1" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("upstream misbehaviour", () => {
  it("reports a non-JSON upstream body as a gateway error", async () => {
    const badFetch: typeof fetch = async () =>
      new Response("<html>502 Bad Gateway</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      });

    const { app } = await buildServer(testConfig({ UPSTREAM_MAX_RETRIES: "0" }), {
      fetchImpl: badFetch,
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/text-to-speech/v",
      payload: { text: "hello" },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toHaveProperty("detail.message");
    await app.close();
  });

  it("rejects a 200 response with an empty audios array", async () => {
    const emptyFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ request_id: "x", audios: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const { app } = await buildServer(testConfig(), { fetchImpl: emptyFetch });
    const res = await app.inject({
      method: "POST",
      url: "/v1/text-to-speech/v",
      payload: { text: "hello" },
    });

    expect(res.statusCode).toBe(502);
    await app.close();
  });

  it("does not hang when the upstream never responds", async () => {
    const hangFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });

    const { app } = await buildServer(
      testConfig({ UPSTREAM_TIMEOUT_MS: "1000", UPSTREAM_MAX_RETRIES: "0" }),
      { fetchImpl: hangFetch },
    );

    const started = Date.now();
    const res = await app.inject({
      method: "POST",
      url: "/v1/text-to-speech/v",
      payload: { text: "hello" },
    });

    expect(res.statusCode).toBe(504);
    expect(Date.now() - started).toBeLessThan(5000);
    await app.close();
  });

  it("gives up after exhausting retries rather than looping forever", async () => {
    let calls = 0;
    const alwaysFail: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "down" } }), {
        status: 503,
        headers: { "content-type": "application/json", "retry-after": "0" },
      });
    };

    const { app } = await buildServer(testConfig({ UPSTREAM_MAX_RETRIES: "2" }), {
      fetchImpl: alwaysFail,
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/text-to-speech/v",
      payload: { text: "hello" },
    });

    expect(res.statusCode).toBe(503);
    expect(calls).toBe(3); // initial + 2 retries
    await app.close();
  });

  it("does not retry a 400, which would just burn quota", async () => {
    let calls = 0;
    const badRequest: typeof fetch = async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ error: { message: "bad speaker", code: "invalid" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    };

    const { app } = await buildServer(testConfig({ UPSTREAM_MAX_RETRIES: "3" }), {
      fetchImpl: badRequest,
    });
    await app.inject({
      method: "POST",
      url: "/v1/text-to-speech/v",
      payload: { text: "hello" },
    });

    expect(calls).toBe(1);
    await app.close();
  });

  it("survives a network-level failure", async () => {
    const netFail: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };

    const { app } = await buildServer(testConfig({ UPSTREAM_MAX_RETRIES: "1" }), {
      fetchImpl: netFail,
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/text-to-speech/v",
      payload: { text: "hello" },
    });

    expect(res.statusCode).toBe(502);
    await app.close();
  });

  it("handles garbage base64 in the audios array", async () => {
    const garbage: typeof fetch = async () =>
      new Response(JSON.stringify({ audios: ["!!!not base64!!!"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const { app } = await buildServer(testConfig(), { fetchImpl: garbage });
    const res = await app.inject({
      method: "POST",
      url: "/v1/text-to-speech/v",
      payload: { text: "hello" },
    });

    expect(res.statusCode).toBeLessThan(500);
    await app.close();
  });
});
