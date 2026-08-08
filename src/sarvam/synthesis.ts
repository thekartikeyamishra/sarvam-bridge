import { cacheKey, type CacheStore } from "../lib/cache.js";
import { SingleFlight } from "../lib/singleflight.js";
import { badRequest } from "../lib/errors.js";
import { concatAudio, codecToMime } from "./audio.js";
import { charLimitFor, chunkText } from "./chunk.js";
import type { SarvamClient } from "./client.js";
import { resolveLanguage, type SarvamLanguage } from "./languages.js";
import { resolveVoice, type Gender, type TtsModel } from "./voices.js";

/**
 * Synthesis orchestration.
 *
 * This is where a request in someone else's dialect becomes a correct Sarvam
 * call. It is also where the five failure modes Sarvam's own migration guide
 * warns about get handled once, centrally, instead of in every application:
 *
 *   1. Writing the JSON response straight to disk as audio  -> we decode base64.
 *   2. Forgetting the required language_code                -> we resolve it.
 *   3. Reaching for pace/pitch instead of a better speaker   -> we map voices.
 *   4. Sending pitch/loudness to bulbul:v3, where they no-op -> we drop them.
 *   5. Exceeding the per-model character limit               -> we chunk.
 */

/** Parameter ranges that differ between model generations. */
const MODEL_RANGES: Record<TtsModel, { pace: [number, number] }> = {
  "bulbul:v3": { pace: [0.5, 2.0] },
  "bulbul:v2": { pace: [0.3, 3.0] },
};

const V2_ONLY_RANGES = {
  pitch: [-0.75, 0.75] as [number, number],
  loudness: [0.3, 3.0] as [number, number],
};

const VALID_SAMPLE_RATES = new Set([8000, 16000, 22050, 24000, 32000, 44100, 48000]);

export interface SynthesisRequest {
  readonly text: string;
  readonly voiceId?: string | undefined;
  readonly language?: string | undefined;
  readonly model?: string | undefined;
  readonly pace?: number | undefined;
  readonly pitch?: number | undefined;
  readonly loudness?: number | undefined;
  readonly sampleRate?: number | undefined;
  readonly codec?: string | undefined;
  readonly enablePreprocessing?: boolean | undefined;
  /** Gender implied by the source dialect's voice name, when known. */
  readonly genderHint?: Gender | undefined;
}

export interface SynthesisDeps {
  readonly client: SarvamClient;
  readonly cache: CacheStore;
  /** Collapses concurrent identical synthesis calls into one upstream request. */
  readonly inFlight: SingleFlight<Buffer>;
  readonly defaults: {
    readonly model: TtsModel;
    readonly language: string;
    readonly speaker: string;
  };
  readonly voiceMap: Readonly<Record<string, string>>;
}

export interface SynthesisResult {
  readonly audio: Buffer;
  readonly contentType: string;
  readonly meta: {
    readonly language: SarvamLanguage;
    readonly languageSource: string;
    readonly speaker: string;
    readonly voiceSource: string;
    readonly model: TtsModel;
    readonly chunks: number;
    readonly cacheHits: number;
    readonly warnings: string[];
  };
}

function clamp(value: number, [min, max]: [number, number]): number {
  return Math.min(max, Math.max(min, value));
}

function normaliseModel(model: string | undefined, fallback: TtsModel): TtsModel {
  if (model === "bulbul:v2" || model === "bulbul:v3") return model;
  return fallback;
}

/**
 * Resolve every upstream parameter, then synthesise. Chunks are cached
 * individually, which gives a high hit rate on workloads that reuse fixed
 * prompts (IVR menus, agent scripts) even when the surrounding text differs.
 */
export async function synthesize(
  deps: SynthesisDeps,
  req: SynthesisRequest,
): Promise<SynthesisResult> {
  const text = req.text?.trim() ?? "";
  if (text.length === 0) {
    throw badRequest("`text` must be a non-empty string.");
  }

  const warnings: string[] = [];
  const model = normaliseModel(req.model, deps.defaults.model);

  const { language, source: languageSource } = resolveLanguage(
    text,
    req.language,
    deps.defaults.language,
  );

  const voice = resolveVoice({
    requested: req.voiceId,
    model,
    language,
    operatorMap: deps.voiceMap,
    configuredDefault: deps.defaults.speaker || undefined,
    genderHint: req.genderHint,
  });
  if (voice.warning) warnings.push(voice.warning);

  // pace: same concept across vendors, different valid range per model.
  let pace: number | undefined;
  if (req.pace !== undefined && Number.isFinite(req.pace)) {
    const range = MODEL_RANGES[model].pace;
    pace = clamp(req.pace, range);
    if (pace !== req.pace) {
      warnings.push(
        `pace ${req.pace} is outside the ${model} range [${range[0]}, ${range[1]}]; clamped to ${pace}.`,
      );
    }
  }

  // pitch and loudness are accepted syntactically on v3 but silently ignored.
  // Dropping them explicitly turns a confusing no-op into a visible warning.
  let pitch: number | undefined;
  let loudness: number | undefined;
  if (model === "bulbul:v2") {
    if (req.pitch !== undefined && Number.isFinite(req.pitch)) {
      pitch = clamp(req.pitch, V2_ONLY_RANGES.pitch);
    }
    if (req.loudness !== undefined && Number.isFinite(req.loudness)) {
      loudness = clamp(req.loudness, V2_ONLY_RANGES.loudness);
    }
  } else {
    if (req.pitch !== undefined) {
      warnings.push("pitch is only effective on bulbul:v2; dropped for bulbul:v3.");
    }
    if (req.loudness !== undefined) {
      warnings.push(
        "loudness is only effective on bulbul:v2; dropped for bulbul:v3.",
      );
    }
  }

  let sampleRate: number | undefined;
  if (req.sampleRate !== undefined && Number.isFinite(req.sampleRate)) {
    if (VALID_SAMPLE_RATES.has(req.sampleRate)) {
      sampleRate = req.sampleRate;
    } else {
      warnings.push(
        `Unsupported sample rate ${req.sampleRate}; using the Sarvam default.`,
      );
    }
  }

  const codec = req.codec?.toLowerCase();
  const chunks = chunkText(text, charLimitFor(model));
  if (chunks.length === 0) {
    throw badRequest("`text` contained no synthesisable content.");
  }
  if (chunks.length > 1) {
    warnings.push(
      `Input exceeded the ${model} limit of ${charLimitFor(model)} characters and was split into ${chunks.length} chunks at sentence boundaries.`,
    );
  }

  let cacheHits = 0;
  const contentType = codecToMime(codec ?? "wav");

  const buffers = await Promise.all(
    chunks.map(async (chunk) => {
      const key = cacheKey({
        t: chunk,
        l: language,
        s: voice.speaker,
        m: model,
        p: pace ?? "",
        pi: pitch ?? "",
        lo: loudness ?? "",
        sr: sampleRate ?? "",
        c: codec ?? "",
        pre: req.enablePreprocessing ?? "",
      });

      const hit = deps.cache.get(key);
      if (hit) {
        cacheHits += 1;
        return hit.value;
      }

      // Concurrent callers wanting this exact chunk share one upstream call.
      return deps.inFlight.run(key, async () => {
        // Re-check: another waiter may have populated the cache while we
        // queued behind them.
        const late = deps.cache.get(key);
        if (late) {
          cacheHits += 1;
          return late.value;
        }

        const response = await deps.client.textToSpeech({
          text: chunk,
          language_code: language,
          speaker: voice.speaker,
          model,
          ...(pace !== undefined ? { pace } : {}),
          ...(pitch !== undefined ? { pitch } : {}),
          ...(loudness !== undefined ? { loudness } : {}),
          ...(sampleRate !== undefined ? { speech_sample_rate: sampleRate } : {}),
          ...(codec ? { output_audio_codec: codec } : {}),
          ...(req.enablePreprocessing !== undefined && model === "bulbul:v2"
            ? { enable_preprocessing: req.enablePreprocessing }
            : {}),
        });

        // Sarvam may return several base64 segments for one input; join them
        // before decoding, exactly as their own decode example does.
        const buffer = Buffer.from(response.audios.join(""), "base64");
        deps.cache.set(key, buffer, contentType);
        return buffer;
      });
    }),
  );

  return {
    audio: concatAudio(buffers),
    contentType,
    meta: {
      language,
      languageSource,
      speaker: voice.speaker,
      voiceSource: voice.source,
      model,
      chunks: chunks.length,
      cacheHits,
      warnings,
    },
  };
}
