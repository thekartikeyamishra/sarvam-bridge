/**
 * Audio container handling.
 *
 * When the bridge chunks a long input, Sarvam returns one complete audio file
 * per chunk. Concatenating WAV files byte-for-byte is wrong: every file after
 * the first carries its own 44+ byte RIFF header, which the decoder renders as
 * an audible click, or refuses outright.
 *
 * So for WAV we parse each chunk, extract the raw PCM payload, concatenate the
 * payloads, and emit a single correct header. Frame-based codecs (MP3, AAC,
 * Opus) concatenate cleanly and are passed through untouched.
 */

export interface WavFormat {
  readonly audioFormat: number;
  readonly channels: number;
  readonly sampleRate: number;
  readonly bitsPerSample: number;
}

export interface ParsedWav {
  readonly format: WavFormat;
  readonly data: Buffer;
}

const DEFAULT_FORMAT: WavFormat = {
  audioFormat: 1,
  channels: 1,
  sampleRate: 24000,
  bitsPerSample: 16,
};

export function isWav(buf: Buffer): boolean {
  return (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WAVE"
  );
}

/**
 * Parse a RIFF/WAVE buffer, walking the subchunk list rather than assuming a
 * fixed 44-byte header — Sarvam responses may include LIST or fact chunks.
 */
export function parseWav(buf: Buffer): ParsedWav | null {
  if (!isWav(buf)) return null;

  let format: WavFormat | null = null;
  let data: Buffer | null = null;
  let offset = 12;

  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    // A truncated final chunk is tolerated: clamp rather than throw.
    const end = Math.min(body + size, buf.length);

    if (id === "fmt " && end - body >= 16) {
      format = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      data = buf.subarray(body, end);
    }

    // Subchunks are word-aligned.
    offset = body + size + (size % 2);
    if (size === 0) break;
  }

  if (!data) return null;
  return { format: format ?? DEFAULT_FORMAT, data };
}

/** Build a 44-byte canonical RIFF/WAVE header for a PCM payload. */
export function buildWavHeader(format: WavFormat, dataLength: number): Buffer {
  const header = Buffer.alloc(44);
  const byteRate =
    (format.sampleRate * format.channels * format.bitsPerSample) / 8;
  const blockAlign = (format.channels * format.bitsPerSample) / 8;

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(format.audioFormat, 20);
  header.writeUInt16LE(format.channels, 22);
  header.writeUInt32LE(format.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(format.bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataLength, 40);
  return header;
}

/**
 * Join per-chunk audio buffers into one playable file.
 * WAV inputs are re-wrapped with a single header; anything else is
 * concatenated directly.
 */
export function concatAudio(buffers: readonly Buffer[]): Buffer {
  const parts = buffers.filter((b) => b.length > 0);
  if (parts.length === 0) return Buffer.alloc(0);
  if (parts.length === 1) return parts[0] as Buffer;

  const first = parts[0] as Buffer;
  if (!isWav(first)) return Buffer.concat([...parts]);

  const payloads: Buffer[] = [];
  let format: WavFormat | null = null;

  for (const part of parts) {
    const parsed = parseWav(part);
    if (!parsed) {
      // Not a WAV after all (mixed codecs) — fall back to raw concatenation.
      return Buffer.concat([...parts]);
    }
    format ??= parsed.format;
    payloads.push(parsed.data);
  }

  const pcm = Buffer.concat(payloads);
  return Buffer.concat([buildWavHeader(format ?? DEFAULT_FORMAT, pcm.length), pcm]);
}

/**
 * Strip the container from a WAV buffer, returning bare PCM plus its format.
 * Used by the streaming path, which emits one header up front and then raw
 * frames as each chunk completes.
 */
export function toPcm(buf: Buffer): { format: WavFormat; pcm: Buffer } {
  const parsed = parseWav(buf);
  if (!parsed) return { format: DEFAULT_FORMAT, pcm: buf };
  return { format: parsed.format, pcm: parsed.data };
}

/** Map a MIME type to the codec value Sarvam expects. */
export function codecToMime(codec: string): string {
  switch (codec.toLowerCase()) {
    case "mp3":
      return "audio/mpeg";
    case "opus":
      return "audio/opus";
    case "flac":
      return "audio/flac";
    case "aac":
      return "audio/aac";
    case "mulaw":
    case "alaw":
    case "linear16":
    case "wav":
    default:
      return "audio/wav";
  }
}
