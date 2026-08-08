/**
 * Speaker catalogue and selection.
 *
 * Two facts drive the design here:
 *
 * 1. Sarvam speaker sets are NOT interchangeable between bulbul:v2 and
 *    bulbul:v3. Sending a v3 speaker to v2 is a hard failure. Any gateway that
 *    forwards a speaker name blindly will break the moment someone flips the
 *    model, so we validate and remap on every request.
 *
 * 2. Sarvam publishes per-language speaker quality guidance measured by
 *    Critical Error Rate (the share of words with critical pronunciation
 *    errors). Picking a speaker at random is measurably worse than picking the
 *    recommended one for the target language. We encode that guidance so an
 *    unmapped incoming voice lands on a good speaker rather than an arbitrary
 *    one.
 *
 * Note on `varun`: it has an excellent CER but carries a deliberately dramatic
 * villain/suspense character. Sarvam flags it as unsuitable for neutral use, so
 * it is excluded from automatic selection and only used if asked for by name.
 */

import type { SarvamLanguage } from "./languages.js";

export type Gender = "male" | "female";
export type TtsModel = "bulbul:v2" | "bulbul:v3";

export const V3_FEMALE = [
  "ritu",
  "priya",
  "neha",
  "pooja",
  "simran",
  "kavya",
  "ishita",
  "shreya",
  "roopa",
  "tanya",
  "shruti",
  "suhani",
  "kavitha",
  "rupali",
  "amelia",
  "sophia",
] as const;

export const V3_MALE = [
  "shubh",
  "aditya",
  "rahul",
  "rohan",
  "amit",
  "dev",
  "ratan",
  "varun",
  "manan",
  "sumit",
  "kabir",
  "aayan",
  "ashutosh",
  "advait",
  "anand",
  "tarun",
  "sunny",
  "mani",
  "gokul",
  "vijay",
  "mohit",
  "rehan",
  "soham",
] as const;

export const V2_FEMALE = ["anushka", "manisha", "vidya", "arya"] as const;
export const V2_MALE = ["abhilash", "karun", "hitesh"] as const;

/** Speakers excluded from automatic selection (character voices). */
const NON_NEUTRAL = new Set<string>(["varun"]);

export const SPEAKERS_BY_MODEL: Record<TtsModel, ReadonlySet<string>> = {
  "bulbul:v3": new Set<string>([...V3_FEMALE, ...V3_MALE]),
  "bulbul:v2": new Set<string>([...V2_FEMALE, ...V2_MALE]),
};

export const DEFAULT_SPEAKER: Record<TtsModel, string> = {
  "bulbul:v3": "shubh",
  "bulbul:v2": "anushka",
};

const GENDER_OF = new Map<string, Gender>();
for (const s of [...V3_FEMALE, ...V2_FEMALE]) GENDER_OF.set(s, "female");
for (const s of [...V3_MALE, ...V2_MALE]) GENDER_OF.set(s, "male");

export function genderOfSpeaker(speaker: string): Gender | null {
  return GENDER_OF.get(speaker.toLowerCase()) ?? null;
}

export function isValidSpeaker(speaker: string, model: TtsModel): boolean {
  return SPEAKERS_BY_MODEL[model].has(speaker.toLowerCase());
}

/**
 * Per-language preferred speakers, ordered best-first, derived from Sarvam's
 * published CER guidance. Used when we have to choose a speaker ourselves.
 */
const PREFERRED_V3: Record<SarvamLanguage, Record<Gender, readonly string[]>> = {
  "en-IN": { female: ["priya", "ishita"], male: ["ratan", "shubh"] },
  "hi-IN": { female: ["priya", "ishita"], male: ["shubh", "aditya"] },
  "te-IN": { female: ["priya", "ishita"], male: ["shubh", "ratan"] },
  "kn-IN": { female: ["priya", "ishita"], male: ["shubh", "ratan"] },
  "ta-IN": { female: ["priya", "ishita"], male: ["ratan", "shubh"] },
  "mr-IN": { female: ["priya", "ishita"], male: ["ratan", "shubh"] },
  "gu-IN": { female: ["priya", "ishita"], male: ["ratan", "shubh"] },
  "ml-IN": { female: ["ishita", "priya"], male: ["shubh", "ratan"] },
  "od-IN": { female: ["ishita", "priya"], male: ["shubh", "ratan"] },
  "pa-IN": { female: ["priya", "ishita"], male: ["mani", "shubh"] },
  "bn-IN": { female: ["priya", "ishita"], male: ["shubh", "ratan"] },
};

const PREFERRED_V2: Record<Gender, readonly string[]> = {
  female: ["anushka", "manisha"],
  male: ["abhilash", "karun"],
};

/**
 * A small convenience map for the best-known stock ElevenLabs voice IDs, so
 * that an unmodified ElevenLabs app lands on a sensibly-gendered Sarvam voice
 * on the very first request.
 *
 * This is a nicety, not a contract: ElevenLabs voice IDs are opaque and
 * account-specific, and stock voices change. Anything not listed here falls
 * through to language-aware selection, and operators can supply their own
 * mapping via the VOICE_MAP environment variable, which always takes priority.
 */
const KNOWN_ELEVENLABS_GENDER: Readonly<Record<string, Gender>> = {
  "21m00tcm4tlvdq8ikwam": "female", // Rachel
  aznzlk1xvdvuebnxmlld: "female", // Domi
  exavitqu4vr4xnsdxmal: "female", // Bella / Sarah
  mf3mgyeycl7xywbv9v6o: "female", // Elli
  tht5kcbeypx3keuqqhph: "female", // Dorothy
  erxwobayin019pkysvjv: "male", // Antoni
  txgeqnhwrfwftfgw9xjx: "male", // Josh
  vr6aewltigwg4xsoukag: "male", // Arnold
  pninz6obpgdqgcfmajgb: "male", // Adam
  yoz06amxzjj28mfd3poq: "male", // Sam
  onwk4e9zlutakqww03f9: "male", // Daniel
};

export interface VoiceResolution {
  readonly speaker: string;
  readonly source:
    | "passthrough"
    | "operator-map"
    | "known-vendor-id"
    | "language-default";
  /** Set when the requested speaker was not usable and we substituted one. */
  readonly warning?: string;
}

export interface ResolveVoiceOptions {
  /** The voice identifier supplied by the caller, if any. */
  readonly requested?: string | undefined;
  readonly model: TtsModel;
  readonly language: SarvamLanguage;
  /** Operator-supplied overrides, parsed from VOICE_MAP. */
  readonly operatorMap?: Readonly<Record<string, string>> | undefined;
  /** Global fallback speaker from configuration. */
  readonly configuredDefault?: string | undefined;
  /**
   * Gender the caller's original voice implied, when the dialect knows it.
   * OpenAI voice names carry a gender that users have designed around, so we
   * pass it explicitly rather than encoding it in a sentinel string.
   */
  readonly genderHint?: Gender | undefined;
}

function pickForLanguage(
  model: TtsModel,
  language: SarvamLanguage,
  gender: Gender,
): string {
  const candidates =
    model === "bulbul:v3"
      ? (PREFERRED_V3[language]?.[gender] ?? [])
      : PREFERRED_V2[gender];

  for (const candidate of candidates) {
    if (isValidSpeaker(candidate, model) && !NON_NEUTRAL.has(candidate)) {
      return candidate;
    }
  }
  return DEFAULT_SPEAKER[model];
}

/**
 * Resolve an incoming voice identifier to a valid Sarvam speaker.
 *
 * Resolution order:
 *   1. Operator override (VOICE_MAP) — always wins, by design.
 *   2. The value is already a valid Sarvam speaker for this model.
 *   3. A valid speaker for the *other* model — remap by gender to this model.
 *   4. A known stock vendor voice ID — keep the gender, pick the best speaker
 *      for the target language.
 *   5. Anything else — best speaker for the target language.
 */
export function resolveVoice(opts: ResolveVoiceOptions): VoiceResolution {
  const { model, language, operatorMap, configuredDefault } = opts;
  const requested = opts.requested?.trim().toLowerCase() ?? "";

  // 1. Operator-supplied mapping.
  if (requested && operatorMap) {
    const mapped = operatorMap[requested];
    if (mapped && isValidSpeaker(mapped, model)) {
      return { speaker: mapped.toLowerCase(), source: "operator-map" };
    }
  }

  // 2. Already a valid speaker for this model.
  if (requested && isValidSpeaker(requested, model)) {
    return { speaker: requested, source: "passthrough" };
  }

  // 3. Valid speaker, wrong model generation — remap preserving gender.
  if (requested) {
    const otherModel: TtsModel =
      model === "bulbul:v3" ? "bulbul:v2" : "bulbul:v3";
    if (isValidSpeaker(requested, otherModel)) {
      const gender = genderOfSpeaker(requested) ?? "female";
      const speaker = pickForLanguage(model, language, gender);
      return {
        speaker,
        source: "language-default",
        warning: `Speaker "${requested}" belongs to ${otherModel} and is not available on ${model}. Substituted "${speaker}".`,
      };
    }
  }

  // 4. Known stock vendor voice ID — preserve gender.
  if (requested) {
    const gender = KNOWN_ELEVENLABS_GENDER[requested];
    if (gender) {
      return {
        speaker: pickForLanguage(model, language, gender),
        source: "known-vendor-id",
      };
    }
  }

  // 5. Gender carried over from the source dialect's voice name.
  if (opts.genderHint) {
    return {
      speaker: pickForLanguage(model, language, opts.genderHint),
      source: "known-vendor-id",
    };
  }

  // 6. Configured default, if it is usable.
  if (configuredDefault && isValidSpeaker(configuredDefault, model)) {
    return { speaker: configuredDefault.toLowerCase(), source: "language-default" };
  }

  // 7. Best speaker for the language.
  const speaker = pickForLanguage(model, language, "female");
  return {
    speaker,
    source: "language-default",
    ...(requested
      ? {
          // The echoed id is caller-controlled, so it is length-bounded here
          // and sanitised again at the header boundary.
          warning: `Unknown voice "${requested.slice(0, 64)}". Selected "${speaker}" as the recommended ${language} voice. Set VOICE_MAP to control this mapping.`,
        }
      : {}),
  };
}

/** Parse the VOICE_MAP environment variable (JSON object of id -> speaker). */
export function parseVoiceMap(raw: string | undefined): Record<string, string> {
  if (!raw || raw.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") out[key.toLowerCase()] = value.toLowerCase();
    }
    return out;
  } catch {
    return {};
  }
}

/** Full speaker list for a model, used by the voice-discovery endpoints. */
export function listSpeakers(model: TtsModel): string[] {
  return [...SPEAKERS_BY_MODEL[model]].sort();
}
