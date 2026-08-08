import { describe, expect, it } from "vitest";

import { chunkText, splitSentences } from "../src/sarvam/chunk.js";
import { detectScript, normaliseLanguage, resolveLanguage, SARVAM_LANGUAGES } from "../src/sarvam/languages.js";
import { isValidSpeaker, listSpeakers, resolveVoice, parseVoiceMap, type TtsModel } from "../src/sarvam/voices.js";
import { buildWavHeader, concatAudio, parseWav, toPcm } from "../src/sarvam/audio.js";
import { sanitiseHeaderValue } from "../src/lib/errors.js";
import { makeWav } from "./helpers.js";

/**
 * Property-based tests.
 *
 * Example-based tests only prove the cases you thought of. These generate
 * thousands of inputs and assert invariants that must hold for all of them.
 * A deterministic PRNG keeps failures reproducible.
 */

/** Small xorshift PRNG so a failing run can be replayed exactly. */
function prng(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return Math.abs(state) / 2 ** 31;
  };
}

const ALPHABETS = [
  "abcdefghijklmnopqrstuvwxyz ",
  "अआइईउऊएऐओऔकखगघङचछजझञटठडढणतथदधनपफबभमयरलवशषसह ािीुूृेैोौ्ं। ",
  "অআইঈউঊএঐওঔকখগঘঙচছজঝঞটঠডঢণতথদধনপফবভমযরলশষসহ ািীুূৃেৈোৌ্ং। ",
  "அஆஇஈஉஊஎஏஐஒஓஔகஙசஞடணதநபமயரலவழளறன ாிீுூெேைொோௌ் ",
  "అఆఇఈఉఊఎఏఐఒఓఔకఖగఘచఛజఝటఠడఢణతథదధనపఫబభమయరలవశషసహ ",
  "0123456789.,!?;:'\"()-—\n\t ",
  "😀🎉👨‍👩‍👧‍👦\u200d\u200b\ufeff",
];

function randomText(rand: () => number, maxLen: number): string {
  const alphabet = ALPHABETS[Math.floor(rand() * ALPHABETS.length)] as string;
  const len = Math.floor(rand() * maxLen);
  let out = "";
  for (let i = 0; i < len; i += 1) {
    out += alphabet[Math.floor(rand() * alphabet.length)];
  }
  return out;
}

function mixedText(rand: () => number, maxLen: number): string {
  let out = "";
  const segments = 1 + Math.floor(rand() * 5);
  for (let i = 0; i < segments; i += 1) {
    out += randomText(rand, Math.ceil(maxLen / segments));
  }
  return out;
}

describe("chunkText invariants", () => {
  it("holds over 3000 random inputs across all scripts", () => {
    const rand = prng(20260807);

    for (let i = 0; i < 3000; i += 1) {
      const limit = 20 + Math.floor(rand() * 400);
      const text = mixedText(rand, 1500);
      const chunks = chunkText(text, limit);

      // 1. No chunk exceeds the limit.
      for (const chunk of chunks) {
        expect(chunk.length, `limit=${limit} iter=${i}`).toBeLessThanOrEqual(limit);
      }

      // 2. No chunk is empty or pure whitespace.
      for (const chunk of chunks) {
        expect(chunk.trim().length).toBeGreaterThan(0);
      }

      // 3. Content is preserved: ignoring whitespace, the rejoined chunks
      //    equal the input. Nothing is dropped and nothing is invented.
      const stripped = (s: string) => s.replace(/\s+/g, "");
      expect(stripped(chunks.join(""))).toBe(stripped(text));

      // 4. Empty input yields no chunks.
      if (text.trim().length === 0) expect(chunks).toHaveLength(0);
    }
  });

  it("always terminates on pathological single-token input", () => {
    const rand = prng(99);
    for (let i = 0; i < 200; i += 1) {
      const limit = 5 + Math.floor(rand() * 50);
      const char = ["क", "😀", "a", "\u0901", "ि"][Math.floor(rand() * 5)] as string;
      const text = char.repeat(200 + Math.floor(rand() * 500));

      const started = Date.now();
      const chunks = chunkText(text, limit);
      expect(Date.now() - started).toBeLessThan(1000);
      for (const c of chunks) expect(c.length).toBeLessThanOrEqual(limit);
    }
  });

  it("never introduces a cluster break in well-formed Indic text", () => {
    // The earlier formulation of this test was wrong: it flagged inputs that
    // *already began* with an orphan matra, which the chunker faithfully
    // preserved. The real property is that chunking must not INTRODUCE a break
    // inside a grapheme cluster. Generating only complete syllables isolates
    // that: any chunk starting with a combining mark can only have come from a
    // break the chunker made.
    const rand = prng(4242);
    const bases = "कखगघचछजझटठडढतथदधनपफबमयरलवशषसह";
    const matras = ["", "ि", "ी", "ु", "ू", "े", "ै", "ो", "ौ", "ा", "्र"];
    const combining = /^\p{M}/u;

    const syllable = (): string => {
      const base = bases[Math.floor(rand() * bases.length)] as string;
      const matra = matras[Math.floor(rand() * matras.length)] as string;
      return base + matra;
    };

    for (let i = 0; i < 500; i += 1) {
      const limit = 10 + Math.floor(rand() * 100);

      let text = "";
      const words = 5 + Math.floor(rand() * 60);
      for (let w = 0; w < words; w += 1) {
        const syllables = 1 + Math.floor(rand() * 4);
        for (let s = 0; s < syllables; s += 1) text += syllable();
        text += rand() < 0.15 ? "। " : " ";
      }

      for (const chunk of chunkText(text, limit)) {
        expect(combining.test(chunk), `limit=${limit} iter=${i}`).toBe(false);
      }
    }
  });

  it("respects the limit even for degenerate orphan-combining-mark runs", () => {
    // A long run of combining marks with no base parses as ONE grapheme
    // cluster. Emitting it whole would exceed Sarvam's ceiling and earn a 422.
    for (const mark of ["\u0901", "\u093F", "\u0BBE"]) {
      for (const limit of [5, 17, 64]) {
        const chunks = chunkText(mark.repeat(400), limit);
        expect(chunks.length).toBeGreaterThan(0);
        for (const c of chunks) expect(c.length).toBeLessThanOrEqual(limit);
      }
    }
  });

  it("splitSentences never loses non-whitespace content", () => {
    const rand = prng(7);
    for (let i = 0; i < 1000; i += 1) {
      const text = mixedText(rand, 400);
      const rejoined = splitSentences(text).join("").replace(/\s+/g, "");
      expect(rejoined).toBe(text.replace(/\s+/g, ""));
    }
  });
});

describe("language resolution invariants", () => {
  it("never throws and always returns a supported language", () => {
    const rand = prng(1234);
    const junk = [undefined, null, 42, {}, [], "", "  ", "xx", "auto", "HI-in", "or"];

    for (let i = 0; i < 2000; i += 1) {
      const text = mixedText(rand, 300);
      const explicit = junk[Math.floor(rand() * junk.length)];
      const out = resolveLanguage(text, explicit, "en-IN");
      expect(SARVAM_LANGUAGES).toContain(out.language);
      expect(["explicit", "detected", "default"]).toContain(out.source);
    }
  });

  it("detectScript returns a confidence in [0,1] and never throws", () => {
    const rand = prng(555);
    for (let i = 0; i < 2000; i += 1) {
      const result = detectScript(mixedText(rand, 400));
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      if (result.language) expect(SARVAM_LANGUAGES).toContain(result.language);
    }
  });

  it("normaliseLanguage is idempotent on its own output", () => {
    for (const lang of SARVAM_LANGUAGES) {
      const once = normaliseLanguage(lang);
      expect(once).toBe(lang);
      expect(normaliseLanguage(once)).toBe(lang);
      expect(normaliseLanguage(lang.toUpperCase())).toBe(lang);
    }
  });
});

describe("voice resolution invariants", () => {
  it("always returns a speaker valid for the requested model, for any input", () => {
    const rand = prng(31337);
    const models: TtsModel[] = ["bulbul:v2", "bulbul:v3"];

    for (let i = 0; i < 3000; i += 1) {
      const model = models[Math.floor(rand() * 2)] as TtsModel;
      const language = SARVAM_LANGUAGES[
        Math.floor(rand() * SARVAM_LANGUAGES.length)
      ] as (typeof SARVAM_LANGUAGES)[number];

      const requested = rand() < 0.3 ? undefined : randomText(rand, 40);

      const out = resolveVoice({
        requested,
        model,
        language,
        ...(rand() < 0.2 ? { configuredDefault: randomText(rand, 10) } : {}),
        ...(rand() < 0.2 ? { genderHint: rand() < 0.5 ? "male" : "female" } : {}),
      });

      expect(isValidSpeaker(out.speaker, model)).toBe(true);
      expect(out.speaker).toBe(out.speaker.toLowerCase());
    }
  });

  it("is deterministic: the same input always yields the same speaker", () => {
    const rand = prng(8);
    for (let i = 0; i < 500; i += 1) {
      const requested = randomText(rand, 30);
      const args = { requested, model: "bulbul:v3" as const, language: "hi-IN" as const };
      expect(resolveVoice(args).speaker).toBe(resolveVoice(args).speaker);
    }
  });

  it("every catalogued speaker round-trips through resolution unchanged", () => {
    for (const model of ["bulbul:v2", "bulbul:v3"] as const) {
      for (const speaker of listSpeakers(model)) {
        const out = resolveVoice({ requested: speaker, model, language: "hi-IN" });
        expect(out.speaker).toBe(speaker);
        expect(out.source).toBe("passthrough");
      }
    }
  });

  it("parseVoiceMap never throws on arbitrary strings", () => {
    const rand = prng(64);
    for (let i = 0; i < 500; i += 1) {
      expect(() => parseVoiceMap(randomText(rand, 60))).not.toThrow();
    }
    for (const junk of ["{", "}", "null", "true", '{"a":1}', '{"a":null}', "[]"]) {
      expect(() => parseVoiceMap(junk)).not.toThrow();
    }
  });
});

describe("audio invariants", () => {
  it("concatenation preserves total PCM length for any chunk count", () => {
    const rand = prng(2718);
    for (let i = 0; i < 300; i += 1) {
      const count = 1 + Math.floor(rand() * 8);
      const sizes = Array.from({ length: count }, () => 1 + Math.floor(rand() * 500));
      const parts = sizes.map((s) => makeWav(s));

      const joined = concatAudio(parts);
      const expected = sizes.reduce((a, b) => a + b, 0) * 2;
      expect(parseWav(joined)?.data.length).toBe(expected);
    }
  });

  it("survives truncated and malformed RIFF containers", () => {
    const wav = makeWav(300);
    for (let cut = 0; cut < wav.length; cut += 37) {
      expect(() => parseWav(wav.subarray(0, cut))).not.toThrow();
      expect(() => toPcm(wav.subarray(0, cut))).not.toThrow();
    }
  });

  it("does not loop forever on a header claiming an absurd chunk size", () => {
    const wav = makeWav(100);
    const evil = Buffer.from(wav);
    evil.writeUInt32LE(0xfffffff0, 16); // fmt chunk claims a huge size

    const started = Date.now();
    expect(() => parseWav(evil)).not.toThrow();
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("tolerates a zero-length data chunk", () => {
    const header = buildWavHeader(
      { audioFormat: 1, channels: 1, sampleRate: 24000, bitsPerSample: 16 },
      0,
    );
    expect(() => parseWav(header)).not.toThrow();
    expect(concatAudio([header, makeWav(50)]).length).toBeGreaterThan(0);
  });

  it("handles random bytes without throwing", () => {
    const rand = prng(160);
    for (let i = 0; i < 300; i += 1) {
      const buf = Buffer.alloc(Math.floor(rand() * 200));
      for (let j = 0; j < buf.length; j += 1) buf[j] = Math.floor(rand() * 256);
      expect(() => parseWav(buf)).not.toThrow();
      expect(() => concatAudio([buf, buf])).not.toThrow();
    }
  });
});

describe("header sanitisation invariants", () => {
  it("output is always latin1, CRLF-free and length-bounded", () => {
    const rand = prng(909);
    // Character checks are folded into a single predicate rather than an
    // expect() per character: 2000 inputs x ~1800 chars is 3.6M assertions,
    // which turns a millisecond property into a minute of wall clock.
    const violations: string[] = [];

    for (let i = 0; i < 2000; i += 1) {
      const out = sanitiseHeaderValue(mixedText(rand, 3000));

      if (out.length > 1800) violations.push(`length ${out.length} at ${i}`);
      if (/[\r\n]/.test(out)) violations.push(`CRLF at ${i}`);

      for (const ch of out) {
        const cp = ch.codePointAt(0) ?? 0;
        if (cp < 0x20 || cp > 0xff) {
          violations.push(`codepoint ${cp} at ${i}`);
          break;
        }
      }
      if (violations.length > 0) break;
    }

    expect(violations).toEqual([]);
  });

  it("can actually be assigned as a Node header value", () => {
    const rand = prng(11);
    for (let i = 0; i < 200; i += 1) {
      const value = sanitiseHeaderValue(mixedText(rand, 500));
      // Node throws on invalid header characters; Buffer.from with latin1
      // round-trips only if every codepoint fits.
      expect(Buffer.from(value, "latin1").toString("latin1")).toBe(value);
    }
  });
});
