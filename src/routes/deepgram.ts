import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

import type { AppContext } from "../context.js";
import { badRequest } from "../lib/errors.js";
import { parseWav } from "../sarvam/audio.js";
import { normaliseLanguage } from "../sarvam/languages.js";
import { guard, withDialect } from "./shared.js";

/**
 * Deepgram-compatible surface.
 *
 * Deepgram clients send raw audio as the request body and read the transcript
 * from a deeply nested path: results.channels[0].alternatives[0].transcript.
 * Reproducing that shape exactly is what lets an existing integration keep its
 * parsing code unchanged.
 */

function durationOf(buf: Buffer): number {
  const parsed = parseWav(buf);
  if (!parsed) return 0;
  const { channels, sampleRate, bitsPerSample } = parsed.format;
  const bytesPerSecond = (sampleRate * channels * bitsPerSample) / 8;
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return 0;
  return Number((parsed.data.length / bytesPerSecond).toFixed(3));
}

export function buildDeepgramResponse(args: {
  transcript: string;
  model: string;
  audio: Buffer;
  languageCode: string | null;
}): Record<string, unknown> {
  const duration = durationOf(args.audio);

  return {
    metadata: {
      transaction_key: "deprecated",
      request_id: randomUUID(),
      sha256: createHash("sha256").update(args.audio).digest("hex"),
      created: new Date().toISOString(),
      duration,
      channels: 1,
      models: [args.model],
      model_info: {
        [args.model]: {
          name: args.model,
          version: "1.0",
          arch: "sarvam",
        },
      },
      // Not part of Deepgram's schema; harmless to their parsers, useful in logs.
      detected_language: args.languageCode ?? "unknown",
    },
    results: {
      channels: [
        {
          alternatives: [
            {
              transcript: args.transcript,
              // Sarvam's sync REST endpoint does not return a confidence score.
              // We report 1.0 rather than a fabricated value, and document it.
              confidence: args.transcript.length > 0 ? 1.0 : 0,
              words: [],
            },
          ],
          detected_language: args.languageCode ?? undefined,
        },
      ],
    },
  };
}

export function registerDeepgramRoutes(app: FastifyInstance, ctx: AppContext): void {
  const dialect = "deepgram" as const;

  app.post(
    "/v1/listen",
    withDialect(ctx, dialect, "dg.listen", async (req, reply) => {
      guard(ctx, req, reply);

      const query = req.query as Record<string, string | undefined>;
      const body = req.body;

      if (!Buffer.isBuffer(body)) {
        if (
          typeof body === "object" &&
          body !== null &&
          "url" in (body as Record<string, unknown>)
        ) {
          throw badRequest(
            "Remote URL ingestion is not supported by the bridge. Send the audio bytes directly, or use Sarvam's Batch API for large files.",
          );
        }
        throw badRequest(
          "Send raw audio bytes as the request body with an audio/* content-type.",
        );
      }

      if (body.length === 0) {
        throw badRequest("Request body was empty.");
      }
      if (body.length > ctx.config.MAX_UPLOAD_BYTES) {
        throw badRequest(
          `Audio exceeds the ${ctx.config.MAX_UPLOAD_BYTES} byte limit.`,
        );
      }

      const contentType = req.headers["content-type"] ?? "audio/wav";
      const model = ctx.config.DEFAULT_STT_MODEL;

      const response = await ctx.client.speechToText({
        audio: body,
        filename: "audio.wav",
        contentType,
        model,
        languageCode: normaliseLanguage(query["language"]) ?? undefined,
        // Deepgram's `detect_language` maps onto Sarvam's automatic detection,
        // which is the default when no language_code is supplied.
        mode: "transcribe",
      });

      reply
        .header("x-sarvam-bridge-language", response.language_code ?? "unknown")
        .type("application/json");

      return reply.send(
        buildDeepgramResponse({
          transcript: response.transcript,
          model,
          audio: body,
          languageCode: response.language_code ?? null,
        }),
      );
    }),
  );
}
