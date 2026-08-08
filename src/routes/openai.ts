import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { AppContext } from "../context.js";
import { badRequest, payloadTooLarge } from "../lib/errors.js";
import { parseWav } from "../sarvam/audio.js";
import { normaliseLanguage } from "../sarvam/languages.js";
import { synthesize } from "../sarvam/synthesis.js";
import type { TtsModel } from "../sarvam/voices.js";
import { attachWarnings, guard, withDialect } from "./shared.js";

/**
 * OpenAI-compatible audio surface.
 *
 * Covers /v1/audio/speech, /v1/audio/transcriptions and /v1/audio/translations.
 * Chat completions are deliberately absent: Sarvam already exposes an
 * OpenAI-compatible /chat/completions endpoint, so proxying it here would add
 * a hop and buy nothing.
 */

/**
 * OpenAI's stock voice names carry a gender that users have already designed
 * around. Preserving it keeps a swapped-in Sarvam voice from sounding jarring.
 */
const OPENAI_VOICE_GENDER: Readonly<Record<string, "male" | "female">> = {
  alloy: "female",
  ash: "male",
  ballad: "male",
  coral: "female",
  echo: "male",
  fable: "male",
  nova: "female",
  onyx: "male",
  sage: "female",
  shimmer: "female",
  verse: "male",
};

const SpeechBodySchema = z.object({
  model: z.string().optional(),
  input: z.string(),
  voice: z.string().optional(),
  response_format: z
    .enum(["mp3", "opus", "aac", "flac", "wav", "pcm"])
    .optional(),
  speed: z.number().optional(),
  language: z.string().optional(),
  instructions: z.string().optional(),
});

function responseFormatToCodec(format: string | undefined): string | undefined {
  if (!format) return undefined;
  if (format === "pcm") return "linear16";
  return format;
}

/**
 * Look up the gender an OpenAI stock voice implies.
 *
 * We hand the resolver the gender rather than a substitute voice name, so it
 * can still choose the best-scoring Sarvam speaker for the detected language.
 * Mapping "onyx" to one fixed speaker would throw that away.
 */
function genderForVoice(voice: string | undefined): "male" | "female" | undefined {
  if (!voice) return undefined;
  return OPENAI_VOICE_GENDER[voice.toLowerCase()];
}

export interface MultipartPayload {
  readonly file: Buffer;
  readonly filename: string;
  readonly contentType: string;
  readonly fields: Record<string, string>;
}

/** Read a multipart upload into memory, enforcing the configured size cap. */
async function readMultipart(
  req: FastifyRequest,
  maxBytes: number,
): Promise<MultipartPayload> {
  if (!req.isMultipart()) {
    throw badRequest("Expected a multipart/form-data request with a `file` part.");
  }

  const fields: Record<string, string> = {};
  let file: Buffer | null = null;
  let filename = "audio.wav";
  let contentType = "audio/wav";

  for await (const part of req.parts()) {
    if (part.type === "file") {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of part.file) {
        total += chunk.length;
        if (total > maxBytes) {
          throw payloadTooLarge(
            `Upload exceeds the ${maxBytes} byte limit. Raise MAX_UPLOAD_BYTES or use Sarvam's Batch API for long audio.`,
          );
        }
        chunks.push(chunk as Buffer);
      }
      file = Buffer.concat(chunks);
      filename = part.filename || filename;
      contentType = part.mimetype || contentType;
    } else {
      fields[part.fieldname] = String(part.value);
    }
  }

  if (!file || file.length === 0) {
    throw badRequest("No audio file was provided, or the file was empty.");
  }
  return { file, filename, contentType, fields };
}

/** Best-effort duration, used for verbose_json and subtitle output. */
function wavDurationSeconds(buf: Buffer): number | null {
  const parsed = parseWav(buf);
  if (!parsed) return null;
  const { channels, sampleRate, bitsPerSample } = parsed.format;
  const bytesPerSecond = (sampleRate * channels * bitsPerSample) / 8;
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return null;
  return parsed.data.length / bytesPerSecond;
}

function formatTimestamp(seconds: number, comma: boolean): string {
  const clamped = Math.max(0, seconds);
  const hh = Math.floor(clamped / 3600);
  const mm = Math.floor((clamped % 3600) / 60);
  const ss = Math.floor(clamped % 60);
  const ms = Math.floor((clamped % 1) * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}${comma ? "," : "."}${pad(ms, 3)}`;
}

/**
 * Render a transcript in the requested OpenAI response format.
 *
 * Sarvam's synchronous REST endpoint returns a transcript without word-level
 * timings, so subtitle formats emit a single cue spanning the clip rather than
 * inventing segment boundaries. Fabricated timings would look right and be
 * wrong, which is worse than an honest single cue. Applications that need real
 * segmentation should use Sarvam's Batch API, which supports diarisation.
 */
export function renderTranscript(
  transcript: string,
  format: string,
  language: string | null,
  durationSeconds: number | null,
): { body: unknown; contentType: string } {
  const duration = durationSeconds ?? 0;

  switch (format) {
    case "text":
      return { body: transcript, contentType: "text/plain; charset=utf-8" };

    case "verbose_json":
      return {
        body: {
          task: "transcribe",
          language: language ?? "unknown",
          duration,
          text: transcript,
          segments: transcript
            ? [
                {
                  id: 0,
                  seek: 0,
                  start: 0,
                  end: duration,
                  text: transcript,
                  tokens: [],
                  temperature: 0,
                  avg_logprob: 0,
                  compression_ratio: 0,
                  no_speech_prob: 0,
                },
              ]
            : [],
        },
        contentType: "application/json",
      };

    case "srt":
      return {
        body: transcript
          ? `1\n${formatTimestamp(0, true)} --> ${formatTimestamp(duration, true)}\n${transcript}\n`
          : "",
        contentType: "text/plain; charset=utf-8",
      };

    case "vtt":
      return {
        body: transcript
          ? `WEBVTT\n\n${formatTimestamp(0, false)} --> ${formatTimestamp(duration, false)}\n${transcript}\n`
          : "WEBVTT\n",
        contentType: "text/vtt; charset=utf-8",
      };

    case "json":
    default:
      return { body: { text: transcript }, contentType: "application/json" };
  }
}

export function registerOpenAIRoutes(app: FastifyInstance, ctx: AppContext): void {
  const dialect = "openai" as const;

  app.post(
    "/v1/audio/speech",
    withDialect(ctx, dialect, "oai.speech", async (req, reply) => {
      guard(ctx, req, reply);

      const parsed = SpeechBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw badRequest(
          `Invalid request body: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
        );
      }
      const body = parsed.data;

      const warnings: string[] = [];
      if (body.instructions) {
        warnings.push(
          "`instructions` has no Sarvam equivalent and was ignored. Select a speaker whose delivery already matches your intent.",
        );
      }

      const result = await synthesize(ctx.synthesisDeps, {
        text: body.input,
        voiceId: body.voice,
        genderHint: genderForVoice(body.voice),
        language: body.language,
        ...(body.speed !== undefined ? { pace: body.speed } : {}),
        ...(responseFormatToCodec(body.response_format)
          ? { codec: responseFormatToCodec(body.response_format) as string }
          : {}),
      });

      attachWarnings(reply, [...warnings, ...result.meta.warnings]);
      reply
        .header("x-sarvam-bridge-speaker", result.meta.speaker)
        .header("x-sarvam-bridge-language", result.meta.language)
        .header("x-sarvam-bridge-cache-hits", String(result.meta.cacheHits))
        .type(result.contentType);
      return reply.send(result.audio);
    }),
  );

  const transcriptionHandler = (mode: "transcribe" | "translate") =>
    withDialect(
      ctx,
      dialect,
      mode === "translate" ? "oai.translations" : "oai.transcriptions",
      async (req, reply) => {
        guard(ctx, req, reply);

        const payload = await readMultipart(req, ctx.config.MAX_UPLOAD_BYTES);
        const format = payload.fields["response_format"] ?? "json";
        const requestedLanguage =
          mode === "translate" ? undefined : payload.fields["language"];

        const response = await ctx.client.speechToText({
          audio: payload.file,
          filename: payload.filename,
          contentType: payload.contentType,
          model: ctx.config.DEFAULT_STT_MODEL,
          languageCode: normaliseLanguage(requestedLanguage) ?? undefined,
          mode,
        });

        const rendered = renderTranscript(
          response.transcript,
          format,
          response.language_code ?? null,
          wavDurationSeconds(payload.file),
        );

        reply
          .header("x-sarvam-bridge-language", response.language_code ?? "unknown")
          .type(rendered.contentType);
        return reply.send(rendered.body);
      },
    );

  app.post("/v1/audio/transcriptions", transcriptionHandler("transcribe"));
  app.post("/v1/audio/translations", transcriptionHandler("translate"));

  /** Minimal model listing, so tooling that probes /v1/models does not break. */
  app.get(
    "/v1/audio/models",
    withDialect(ctx, dialect, "oai.models", async (req, reply) => {
      guard(ctx, req, reply);
      const model = ctx.config.DEFAULT_TTS_MODEL as TtsModel;
      return reply.send({
        object: "list",
        data: [
          { id: model, object: "model", owned_by: "sarvam" },
          {
            id: ctx.config.DEFAULT_STT_MODEL,
            object: "model",
            owned_by: "sarvam",
          },
        ],
      });
    }),
  );
}
