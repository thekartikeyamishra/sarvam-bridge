/**
 * Text chunking.
 *
 * Sarvam caps a single synthesis request at 2500 characters on bulbul:v3 and
 * 1500 on bulbul:v2. ElevenLabs allows far longer inputs, so a migrating app
 * that used to send one large call now needs chunking logic it never had to
 * write. Sarvam's own migration guide calls this out. The bridge does it
 * transparently.
 *
 * Three properties matter:
 *
 * - Split on sentence boundaries, including the Devanagari danda (।) and double
 *   danda (॥). A naive splitter that only knows about "." will treat an entire
 *   Hindi paragraph as one sentence and then hard-cut it mid-word.
 *
 * - Never split inside a grapheme cluster. Indic scripts attach matras, viramas
 *   and other combining marks to a base consonant. Slicing a JavaScript string
 *   by code unit can separate them, which produces both visible garbage and
 *   audibly wrong speech. Hard splits go through Intl.Segmenter.
 *
 * - Prefer fewer, larger chunks. Every chunk is a billable request and a
 *   prosody reset, so packing greedily keeps both cost and audio quality good.
 */

/** Documented per-model input ceilings. */
export const MODEL_CHAR_LIMIT: Record<string, number> = {
  "bulbul:v3": 2500,
  "bulbul:v2": 1500,
};

export const DEFAULT_CHAR_LIMIT = 2500;

export function charLimitFor(model: string): number {
  return MODEL_CHAR_LIMIT[model] ?? DEFAULT_CHAR_LIMIT;
}

/** Sentence-final punctuation across the scripts Sarvam supports. */
const SENTENCE_END = /[.!?।॥\u061F\u2026]/;
/** Clause-level punctuation, used as a second-choice split point. */
const CLAUSE_END = /[,;:\u2014\u2013)\]]/;

let graphemeSegmenter: Intl.Segmenter | null = null;
function getSegmenter(): Intl.Segmenter {
  graphemeSegmenter ??= new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  });
  return graphemeSegmenter;
}

/**
 * Split a string at `limit` characters without breaking a grapheme cluster.
 * Returns the head (<= limit) and the remaining tail.
 */
function splitAtGrapheme(text: string, limit: number): [string, string] {
  if (text.length <= limit) return [text, ""];

  let head = "";
  for (const { segment } of getSegmenter().segment(text)) {
    if (head.length + segment.length > limit) break;
    head += segment;
  }

  if (head.length === 0) {
    // A single grapheme cluster longer than the whole limit. This happens with
    // degenerate input — a long run of orphan combining marks with no base
    // character parses as one cluster. Emitting it whole would exceed Sarvam's
    // documented ceiling and earn a guaranteed 422, so we hard-slice instead.
    // The cluster is already meaningless, and a truncated one is strictly
    // better than a rejected request.
    head = sliceCodePoints(text, limit);
  }
  return [head, text.slice(head.length)];
}

/**
 * Slice to at most `limit` UTF-16 units without splitting a surrogate pair,
 * which would leave an unpaired surrogate and produce invalid UTF-8 on the
 * wire.
 */
function sliceCodePoints(text: string, limit: number): string {
  if (limit <= 0) return text.slice(0, 1);
  let out = "";
  for (const char of text) {
    if (out.length + char.length > limit) break;
    out += char;
  }
  // Guarantee forward progress even when the first codepoint alone exceeds
  // the limit (a surrogate pair with limit 1).
  return out.length > 0 ? out : String.fromCodePoint(text.codePointAt(0) as number);
}

/** Unicode combining marks; a chunk must never begin with one. */
const COMBINING_MARK = /\p{M}/u;

/**
 * Break text into sentences, keeping terminal punctuation attached to the
 * sentence it ends. Newlines are treated as hard boundaries.
 *
 * A terminator is only treated as a boundary when the next character is not a
 * combining mark. In malformed input a danda can be followed by a matra, and
 * those form a single grapheme cluster — splitting between them would strand
 * the mark at the head of the next chunk.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let current = "";

  const chars = [...text];
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i] as string;
    current += char;

    if (char === "\n") {
      if (current.trim()) out.push(current.trim());
      current = "";
      continue;
    }

    if (SENTENCE_END.test(char)) {
      const next = chars[i + 1];
      if (next !== undefined && COMBINING_MARK.test(next)) continue;
      if (current.trim()) out.push(current.trim());
      current = "";
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** Split an over-long sentence at clause punctuation, then at whitespace. */
function splitLongSentence(sentence: string, limit: number): string[] {
  const out: string[] = [];
  let remaining = sentence;

  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);

    let cut = -1;
    for (let i = window.length - 1; i >= Math.floor(limit * 0.5); i -= 1) {
      const ch = window[i];
      if (ch !== undefined && CLAUSE_END.test(ch)) {
        cut = i + 1;
        break;
      }
    }
    if (cut === -1) {
      for (let i = window.length - 1; i >= Math.floor(limit * 0.5); i -= 1) {
        if (window[i] === " ") {
          cut = i + 1;
          break;
        }
      }
    }

    if (cut === -1) {
      const [head, tail] = splitAtGrapheme(remaining, limit);
      out.push(head.trim());
      remaining = tail.trimStart();
    } else {
      const [head, tail] = splitAtGrapheme(remaining, cut);
      out.push(head.trim());
      remaining = tail.trimStart();
    }
  }

  if (remaining.trim()) out.push(remaining.trim());
  return out.filter((s) => s.length > 0);
}

/**
 * Chunk text into pieces that each fit within `limit`, splitting on the most
 * natural boundary available and never breaking a grapheme cluster.
 */
export function chunkText(text: string, limit: number = DEFAULT_CHAR_LIMIT): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= limit) return [trimmed];

  const sentences = splitSentences(trimmed);
  const chunks: string[] = [];
  let buffer = "";

  for (const sentence of sentences) {
    if (sentence.length > limit) {
      if (buffer) {
        chunks.push(buffer);
        buffer = "";
      }
      chunks.push(...splitLongSentence(sentence, limit));
      continue;
    }

    const candidate = buffer ? `${buffer} ${sentence}` : sentence;
    if (candidate.length <= limit) {
      buffer = candidate;
    } else {
      if (buffer) chunks.push(buffer);
      buffer = sentence;
    }
  }

  if (buffer) chunks.push(buffer);
  return chunks.filter((c) => c.trim().length > 0);
}
