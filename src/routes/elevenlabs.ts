import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppContext } from "../context.js";
import { badRequest } from "../lib/errors.js";
import { buildWavHeader, codecToMime, isWav, toPcm } from "../sarvam/audio.js";
import { charLimitFor, chunkText } from "../sarvam/chunk.js";
import { resolveLanguage } from "../sarvam/languages.js";
import { synthesize } from "../sarvam/synthesis.js";
import {
  genderOfSpeaker,
  listSpeakers,
  resolveVoice,
  type TtsModel,
} from "../sarvam/voices.js";
import { attachWarnings, guard, withDialect } from "./shared.js";

/**
 * ElevenLabs-compatible surface.
 *
 * The critical detail is the response body. ElevenLabs returns raw audio
 * bytes; Sarvam returns JSON with base64 strings in an `audios` array. Sarvam's
 * migration guide names writing that JSON straight to disk as "the single most
 * common migration bug". Here the caller keeps receiving raw bytes, so the bug
 * cannot occur — no application change, no decode step, no corrupted files.
 */

const VoiceSettingsSchema = z
  .object({
    stability: z.number().optional(),
    similarity_boost: z.number().optional(),
    style: z.number().optional(),
    use_speaker_boost: z.boolean().optional(),
    speed: z.number().optional(),
  })
  .partial()
  .optional();

const TtsBodySchema = z.object({
  text: z.string(),
  model_id: z.string().optional(),
  language_code: z.string().optional(),
  voice_settings: VoiceSettingsSchema,
  output_format: z.string().optional(),
  // Accepted and ignored; present so strict clients do not fail validation.
  pronunciation_dictionary_locators: z.array(z.unknown()).optional(),
  seed: z.number().optional(),
  previous_text: z.string().optional(),
  next_text: z.string().optional(),
});

export interface ParsedOutputFormat {
  readonly codec?: string;
  readonly sampleRate?: number;
}

/**
 * ElevenLabs encodes container, sample rate and bitrate in one string
 * (`mp3_44100_128`, `pcm_16000`, `ulaw_8000`). Sarvam takes codec and sample
 * rate as separate parameters, so we decompose it.
 */
export function parseOutputFormat(value: string | undefined): ParsedOutputFormat {
  if (!value) return {};
  const parts = value.toLowerCase().split("_");
  const container = parts[0];
  const rate = parts[1] ? Number.parseInt(parts[1], 10) : Number.NaN;

  const codecMap: Record<string, string> = {
    mp3: "mp3",
    pcm: "linear16",
    ulaw: "mulaw",
    mulaw: "mulaw",
    alaw: "alaw",
    opus: "opus",
    flac: "flac",
    aac: "aac",
    wav: "wav",
  };

  const result: ParsedOutputFormat = {
    ...(container && codecMap[container] ? { codec: codecMap[container] } : {}),
    ...(Number.isFinite(rate) ? { sampleRate: rate } : {}),
  };
  return result;
}

/**
 * Translate ElevenLabs voice_settings into Sarvam terms, reporting what could
 * not be carried across rather than silently discarding it.
 */
export function translateVoiceSettings(
  settings: z.infer<typeof VoiceSettingsSchema>,
  strict: boolean,
): { pace?: number; warnings: string[] } {
  const warnings: string[] = [];
  if (!settings) return { warnings };

  const unsupported: string[] = [];
  if (settings.stability !== undefined) unsupported.push("stability");
  if (settings.similarity_boost !== undefined) unsupported.push("similarity_boost");
  if (settings.style !== undefined) unsupported.push("style");
  if (settings.use_speaker_boost !== undefined) unsupported.push("use_speaker_boost");

  if (unsupported.length > 0) {
    warnings.push(
      `Ignored ElevenLabs-only voice settings: ${unsupported.join(", ")}. Sarvam voices are pre-tuned; choose a different speaker instead of calibrating these.`,
    );
    if (strict) {
      throw badRequest(
        `STRICT_COMPAT is on and these parameters have no Sarvam equivalent: ${unsupported.join(", ")}.`,
      );
    }
  }

  return {
    ...(settings.speed !== undefined ? { pace: settings.speed } : {}),
    warnings,
  };
}

export function registerElevenLabsRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): void {
  const dialect = "elevenlabs" as const;

  const handleTts = (streaming: boolean) =>
    withDialect(ctx, dialect, streaming ? "el.tts.stream" : "el.tts", async (req, reply) => {
      guard(ctx, req, reply);

      const params = req.params as { voice_id?: string };
      const parsed = TtsBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw badRequest(
          `Invalid request body: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
        );
      }
      const body = parsed.data;

      const query = req.query as Record<string, string | undefined>;
      const format = parseOutputFormat(body.output_format ?? query["output_format"]);
      const settings = translateVoiceSettings(
        body.voice_settings,
        ctx.config.STRICT_COMPAT,
      );

      if (streaming) {
        return streamSynthesis(ctx, req, reply, {
          text: body.text,
          voiceId: params.voice_id,
          language: body.language_code,
          format,
          pace: settings.pace,
          extraWarnings: settings.warnings,
        });
      }

      const result = await synthesize(ctx.synthesisDeps, {
        text: body.text,
        voiceId: params.voice_id,
        language: body.language_code,
        pace: settings.pace,
        ...(format.codec ? { codec: format.codec } : {}),
        ...(format.sampleRate ? { sampleRate: format.sampleRate } : {}),
      });

      attachWarnings(reply, [...settings.warnings, ...result.meta.warnings]);
      reply
        .header("x-sarvam-bridge-speaker", result.meta.speaker)
        .header("x-sarvam-bridge-language", result.meta.language)
        .header("x-sarvam-bridge-chunks", String(result.meta.chunks))
        .header("x-sarvam-bridge-cache-hits", String(result.meta.cacheHits))
        .type(result.contentType);

      // Raw bytes, exactly as ElevenLabs would return them.
      return reply.send(result.audio);
    });

  app.post("/v1/text-to-speech/:voice_id", handleTts(false));
  app.post("/v1/text-to-speech/:voice_id/stream", handleTts(true));

  /**
   * Voice discovery. Sarvam has no equivalent endpoint — speakers are a fixed
   * published list — so we synthesise an ElevenLabs-shaped catalogue. Existing
   * voice-picker UIs keep working untouched.
   */
  app.get(
    "/v1/voices",
    withDialect(ctx, dialect, "el.voices", async (req, reply) => {
      guard(ctx, req, reply);
      const model = ctx.config.DEFAULT_TTS_MODEL as TtsModel;

      const voices = listSpeakers(model).map((speaker) => ({
        voice_id: speaker,
        name: speaker.charAt(0).toUpperCase() + speaker.slice(1),
        category: "premade",
        labels: {
          provider: "sarvam",
          model,
          gender: genderOfSpeaker(speaker) ?? "unknown",
        },
        description: `Sarvam ${model} speaker "${speaker}".`,
        preview_url: null,
        available_for_tiers: [],
        settings: null,
      }));

      return reply.send({ voices });
    }),
  );

  app.get(
    "/v1/voices/:voice_id",
    withDialect(ctx, dialect, "el.voice", async (req, reply) => {
      guard(ctx, req, reply);
      const model = ctx.config.DEFAULT_TTS_MODEL as TtsModel;
      const { voice_id: voiceId } = req.params as { voice_id: string };

      const resolution = resolveVoice({
        requested: voiceId,
        model,
        language: "en-IN",
        operatorMap: ctx.voiceMap,
        configuredDefault: ctx.config.DEFAULT_SPEAKER || undefined,
      });

      return reply.send({
        voice_id: resolution.speaker,
        name: resolution.speaker,
        category: "premade",
        labels: {
          provider: "sarvam",
          model,
          gender: genderOfSpeaker(resolution.speaker) ?? "unknown",
          resolved_from: voiceId,
        },
      });
    }),
  );

  app.get(
    "/v1/models",
    withDialect(ctx, dialect, "el.models", async (req, reply) => {
      guard(ctx, req, reply);
      return reply.send([
        {
          model_id: "bulbul:v3",
          name: "Bulbul v3",
          can_do_text_to_speech: true,
          max_characters_request_free_user: charLimitFor("bulbul:v3"),
          max_characters_request_subscribed_user: charLimitFor("bulbul:v3"),
          languages: [
            "en-IN", "hi-IN", "bn-IN", "gu-IN", "kn-IN", "ml-IN",
            "mr-IN", "od-IN", "pa-IN", "ta-IN", "te-IN",
          ].map((code) => ({ language_id: code, name: code })),
        },
        {
          model_id: "bulbul:v2",
          name: "Bulbul v2",
          can_do_text_to_speech: true,
          max_characters_request_free_user: charLimitFor("bulbul:v2"),
          max_characters_request_subscribed_user: charLimitFor("bulbul:v2"),
          languages: [],
        },
      ]);
    }),
  );
}

/**
 * Progressive streaming.
 *
 * We synthesise chunk by chunk and write each one as it lands, so the caller
 * hears the first sentence while the rest is still being generated. For
 * frame-based codecs the chunks concatenate directly. For WAV we emit one
 * header up front with an open-ended length and then raw PCM, which is the
 * conventional way to stream a RIFF container of unknown duration.
 */
async function streamSynthesis(
  ctx: AppContext,
  req: Parameters<Parameters<typeof withDialect>[3]>[0],
  reply: Parameters<Parameters<typeof withDialect>[3]>[1],
  args: {
    text: string;
    voiceId?: string | undefined;
    language?: string | undefined;
    format: ParsedOutputFormat;
    pace?: number | undefined;
    extraWarnings: string[];
  },
): Promise<void> {
  const model = ctx.config.DEFAULT_TTS_MODEL as TtsModel;
  const text = args.text?.trim() ?? "";
  if (text.length === 0) throw badRequest("`text` must be a non-empty string.");

  const { language } = resolveLanguage(
    text,
    args.language,
    ctx.config.DEFAULT_LANGUAGE,
  );
  const voice = resolveVoice({
    requested: args.voiceId,
    model,
    language,
    operatorMap: ctx.voiceMap,
    configuredDefault: ctx.config.DEFAULT_SPEAKER || undefined,
  });

  const chunks = chunkText(text, charLimitFor(model));
  const codec = args.format.codec ?? "wav";

  attachWarnings(reply, [
    ...args.extraWarnings,
    ...(voice.warning ? [voice.warning] : []),
  ]);
  reply
    .header("x-sarvam-bridge-speaker", voice.speaker)
    .header("x-sarvam-bridge-language", language)
    .header("x-sarvam-bridge-chunks", String(chunks.length))
    .header("transfer-encoding", "chunked")
    .type(codecToMime(codec));

  reply.raw.writeHead(200, {
    "content-type": codecToMime(codec),
    "cache-control": "no-store",
  });

  let headerWritten = false;

  try {
    for (const chunk of chunks) {
      const result = await synthesize(ctx.synthesisDeps, {
        text: chunk,
        voiceId: voice.speaker,
        language,
        ...(args.pace !== undefined ? { pace: args.pace } : {}),
        ...(args.format.codec ? { codec: args.format.codec } : {}),
        ...(args.format.sampleRate ? { sampleRate: args.format.sampleRate } : {}),
      });

      if (!isWav(result.audio)) {
        reply.raw.write(result.audio);
        continue;
      }

      const { format, pcm } = toPcm(result.audio);
      if (!headerWritten) {
        // Open-ended length: play until the connection closes.
        reply.raw.write(buildWavHeader(format, 0xffffffff - 36));
        headerWritten = true;
      }
      reply.raw.write(pcm);
    }
    reply.raw.end();
  } catch (err) {
    // Headers are already sent, so destroy rather than attempt a JSON error.
    req.log.error({ err }, "streaming synthesis failed mid-response");
    reply.raw.destroy();
  }
}
