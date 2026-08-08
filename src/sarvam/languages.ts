/**
 * Language handling.
 *
 * Sarvam requires `language_code` on every text-to-speech request. This is a
 * deliberate design choice on their side: it removes guesswork from
 * pronunciation and prosody, which matters enormously for code-mixed Indian
 * text. It is also the single most common migration bug, because ElevenLabs,
 * OpenAI and Deepgram clients treat language as optional and simply never
 * send it.
 *
 * The bridge closes that gap by deriving the language from three sources, in
 * descending order of trust:
 *   1. An explicit language passed by the caller (normalised to BCP-47).
 *   2. The dominant Indic script present in the text itself.
 *   3. The configured default.
 *
 * Script detection is deterministic, allocation-light and needs no model call,
 * so it costs effectively nothing per request.
 */

export const SARVAM_LANGUAGES = [
  "en-IN",
  "hi-IN",
  "bn-IN",
  "gu-IN",
  "kn-IN",
  "ml-IN",
  "mr-IN",
  "od-IN",
  "pa-IN",
  "ta-IN",
  "te-IN",
] as const;

export type SarvamLanguage = (typeof SARVAM_LANGUAGES)[number];

const LANGUAGE_SET = new Set<string>(SARVAM_LANGUAGES);

export function isSarvamLanguage(value: string): value is SarvamLanguage {
  return LANGUAGE_SET.has(value);
}

/**
 * Unicode block ranges for the scripts Sarvam supports.
 * Devanagari is shared by Hindi and Marathi; we resolve it to Hindi unless the
 * caller told us otherwise, which matches Sarvam's own default behaviour.
 */
const SCRIPT_RANGES: ReadonlyArray<{
  readonly lang: SarvamLanguage;
  readonly start: number;
  readonly end: number;
}> = [
  { lang: "hi-IN", start: 0x0900, end: 0x097f }, // Devanagari
  { lang: "bn-IN", start: 0x0980, end: 0x09ff }, // Bengali
  { lang: "pa-IN", start: 0x0a00, end: 0x0a7f }, // Gurmukhi
  { lang: "gu-IN", start: 0x0a80, end: 0x0aff }, // Gujarati
  { lang: "od-IN", start: 0x0b00, end: 0x0b7f }, // Odia
  { lang: "ta-IN", start: 0x0b80, end: 0x0bff }, // Tamil
  { lang: "te-IN", start: 0x0c00, end: 0x0c7f }, // Telugu
  { lang: "kn-IN", start: 0x0c80, end: 0x0cff }, // Kannada
  { lang: "ml-IN", start: 0x0d00, end: 0x0d7f }, // Malayalam
];

/**
 * Aliases from the language identifiers used by the source APIs we emulate.
 * ElevenLabs and OpenAI use bare ISO-639-1; Deepgram mixes bare codes with
 * region-qualified ones. Everything funnels into Sarvam's BCP-47 set.
 */
const ALIASES: Readonly<Record<string, SarvamLanguage>> = {
  en: "en-IN",
  eng: "en-IN",
  "en-us": "en-IN",
  "en-gb": "en-IN",
  "en-in": "en-IN",
  hi: "hi-IN",
  hin: "hi-IN",
  "hi-in": "hi-IN",
  hinglish: "hi-IN",
  bn: "bn-IN",
  ben: "bn-IN",
  "bn-in": "bn-IN",
  "bn-bd": "bn-IN",
  gu: "gu-IN",
  guj: "gu-IN",
  "gu-in": "gu-IN",
  kn: "kn-IN",
  kan: "kn-IN",
  "kn-in": "kn-IN",
  ml: "ml-IN",
  mal: "ml-IN",
  "ml-in": "ml-IN",
  mr: "mr-IN",
  mar: "mr-IN",
  "mr-in": "mr-IN",
  or: "od-IN",
  ori: "od-IN",
  ody: "od-IN",
  od: "od-IN",
  "or-in": "od-IN",
  "od-in": "od-IN",
  pa: "pa-IN",
  pan: "pa-IN",
  "pa-in": "pa-IN",
  ta: "ta-IN",
  tam: "ta-IN",
  "ta-in": "ta-IN",
  te: "te-IN",
  tel: "te-IN",
  "te-in": "te-IN",
};

/**
 * Normalise any caller-supplied language identifier to a Sarvam language code.
 * Returns null when the value is absent, unrecognised, or an explicit
 * "auto-detect" sentinel — all of which mean "fall through to detection".
 */
export function normaliseLanguage(input: unknown): SarvamLanguage | null {
  if (typeof input !== "string") return null;
  const raw = input.trim().toLowerCase();
  if (raw.length === 0) return null;
  if (raw === "auto" || raw === "unknown" || raw === "null") return null;

  if (LANGUAGE_SET.has(raw)) {
    // Already a Sarvam code, just fix the casing of the region subtag.
    const [lang, region] = raw.split("-");
    return `${lang}-${(region ?? "in").toUpperCase()}` as SarvamLanguage;
  }
  return ALIASES[raw] ?? null;
}

export interface ScriptDetection {
  readonly language: SarvamLanguage | null;
  /** Fraction of letter characters belonging to the winning Indic script. */
  readonly confidence: number;
  /** True when Latin and an Indic script both appear (e.g. Hinglish). */
  readonly mixed: boolean;
}

/**
 * Detect the dominant Indic script in a string.
 *
 * We count codepoints per script rather than short-circuiting on the first
 * match, so a mostly-Tamil string containing one stray Devanagari character
 * still resolves to Tamil.
 */
export function detectScript(text: string): ScriptDetection {
  const counts = new Map<SarvamLanguage, number>();
  let latin = 0;
  let indic = 0;

  for (const char of text) {
    const cp = char.codePointAt(0);
    if (cp === undefined) continue;

    if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) {
      latin += 1;
      continue;
    }
    if (cp < 0x0900 || cp > 0x0d7f) continue;

    for (const range of SCRIPT_RANGES) {
      if (cp >= range.start && cp <= range.end) {
        counts.set(range.lang, (counts.get(range.lang) ?? 0) + 1);
        indic += 1;
        break;
      }
    }
  }

  if (indic === 0) {
    return { language: null, confidence: 0, mixed: false };
  }

  let winner: SarvamLanguage | null = null;
  let best = 0;
  for (const [lang, count] of counts) {
    if (count > best) {
      best = count;
      winner = lang;
    }
  }

  const totalLetters = latin + indic;
  return {
    language: winner,
    confidence: totalLetters === 0 ? 0 : best / totalLetters,
    mixed: latin > 0 && indic > 0,
  };
}

/**
 * Resolve the final language for a synthesis request.
 * `explicit` wins; otherwise we detect from the text; otherwise the default.
 */
export function resolveLanguage(
  text: string,
  explicit: unknown,
  fallback: string,
): { language: SarvamLanguage; source: "explicit" | "detected" | "default" } {
  const normalised = normaliseLanguage(explicit);
  if (normalised) return { language: normalised, source: "explicit" };

  const detected = detectScript(text);
  if (detected.language) return { language: detected.language, source: "detected" };

  const fallbackLang = normaliseLanguage(fallback) ?? "en-IN";
  return { language: fallbackLang, source: "default" };
}
