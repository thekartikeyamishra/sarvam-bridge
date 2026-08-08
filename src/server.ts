import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";

import type { Config } from "./config.js";
import { buildContext, type AppContext, type BuildContextOptions } from "./context.js";
import { serialiseError, toGatewayError } from "./lib/errors.js";
import { registerDeepgramRoutes } from "./routes/deepgram.js";
import { registerElevenLabsRoutes } from "./routes/elevenlabs.js";
import { registerOpenAIRoutes } from "./routes/openai.js";
import { registerOpsRoutes, VERSION } from "./routes/ops.js";

export interface BuiltServer {
  readonly app: FastifyInstance;
  readonly ctx: AppContext;
}

/** Content types that arrive as raw bytes rather than JSON. */
const BINARY_CONTENT_TYPES = [
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/aac",
  "audio/ogg",
  "audio/opus",
  "audio/flac",
  "audio/x-flac",
  "audio/webm",
  "audio/amr",
  "audio/basic",
  "audio/l16",
  "application/octet-stream",
];

/**
 * Interpret the TRUST_PROXY setting.
 *
 * Off by default. `req.ip` is a rate-limit bucketing key, so trusting
 * X-Forwarded-For unconditionally would let a caller forge a fresh identity per
 * request and bypass the limiter entirely. An explicit list of trusted proxy
 * addresses is strictly safer than `true` and is what production should use.
 */
export function parseTrustProxy(value: string): boolean | string[] {
  const raw = value.trim();
  if (raw.length === 0) return false;
  if (raw.toLowerCase() === "true") return true;
  if (raw.toLowerCase() === "false") return false;
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export async function buildServer(
  config: Config,
  opts: BuildContextOptions = {},
): Promise<BuiltServer> {
  const ctx = buildContext(config, opts);

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Credentials must never reach disk, even at debug level.
      redact: {
        paths: [
          'req.headers["xi-api-key"]',
          'req.headers["api-key"]',
          'req.headers["authorization"]',
          'req.headers["api-subscription-key"]',
        ],
        censor: "[redacted]",
      },
      ...(config.NODE_ENV === "development"
        ? { transport: { target: "pino-pretty", options: { colorize: true } } }
        : {}),
    },
    bodyLimit: config.MAX_UPLOAD_BYTES,
    trustProxy: parseTrustProxy(config.TRUST_PROXY),
    // Collision-resistant ids: Math.random collides often enough at volume to
    // make two unrelated requests indistinguishable in a log search.
    genReqId: () => `req_${randomUUID()}`,
  });

  await app.register(helmet, {
    // The gateway serves audio and JSON to SDKs, never HTML to browsers, so
    // the CSP machinery is dead weight here.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: false,
  });

  await app.register(multipart, {
    limits: {
      fileSize: config.MAX_UPLOAD_BYTES,
      files: 1,
      fields: 20,
    },
  });

  for (const type of BINARY_CONTENT_TYPES) {
    app.addContentTypeParser(type, { parseAs: "buffer" }, (_req, body, done) => {
      done(null, body);
    });
  }

  // Tolerate an empty or absent JSON body rather than 400-ing on it, which is
  // what several vendor SDKs send for parameterless calls.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      const raw = typeof body === "string" ? body.trim() : "";
      if (raw.length === 0) return done(null, {});
      try {
        done(null, JSON.parse(raw));
      } catch (err) {
        done(err instanceof Error ? err : new Error("Invalid JSON"), undefined);
      }
    },
  );

  app.setNotFoundHandler(async (req, reply) => {
    return reply.status(404).send({
      error: {
        code: "not_found",
        message: `No route for ${req.method} ${req.url}. See / for the supported surface.`,
      },
    });
  });

  app.setErrorHandler(async (err, req, reply) => {
    const gatewayError = toGatewayError(err);
    req.log.error({ err, status: gatewayError.statusCode }, "unhandled error");
    return reply
      .status(gatewayError.statusCode)
      .send(serialiseError(gatewayError, "native"));
  });

  app.get("/", async (_req, reply) => {
    return reply.send({
      name: "sarvam-bridge",
      version: VERSION,
      description:
        "Drop-in compatibility gateway. Point an existing ElevenLabs, OpenAI Audio or Deepgram client at this base URL and it runs on Sarvam AI, unmodified.",
      upstream: config.SARVAM_BASE_URL,
      models: {
        tts: config.DEFAULT_TTS_MODEL,
        stt: config.DEFAULT_STT_MODEL,
      },
      routes: {
        elevenlabs: [
          "POST /v1/text-to-speech/:voice_id",
          "POST /v1/text-to-speech/:voice_id/stream",
          "GET  /v1/voices",
          "GET  /v1/voices/:voice_id",
          "GET  /v1/models",
        ],
        openai: [
          "POST /v1/audio/speech",
          "POST /v1/audio/transcriptions",
          "POST /v1/audio/translations",
          "GET  /v1/audio/models",
        ],
        deepgram: ["POST /v1/listen"],
        ops: [
          "GET  /healthz",
          "GET  /readyz",
          "GET  /metrics",
          "POST /v1/bridge/explain",
        ],
      },
    });
  });

  registerOpsRoutes(app, ctx);
  registerElevenLabsRoutes(app, ctx);
  registerOpenAIRoutes(app, ctx);
  registerDeepgramRoutes(app, ctx);

  return { app, ctx };
}
