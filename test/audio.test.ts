import { describe, expect, it } from "vitest";
import { concatAudio, isWav, parseWav, toPcm } from "../src/sarvam/audio.js";
import { makeWav } from "./helpers.js";

describe("WAV handling", () => {
  it("recognises and parses a RIFF container", () => {
    const wav = makeWav(500);
    expect(isWav(wav)).toBe(true);
    const parsed = parseWav(wav);
    expect(parsed?.format.sampleRate).toBe(24000);
    expect(parsed?.format.channels).toBe(1);
    expect(parsed?.data.length).toBe(1000);
  });

  it("returns null for non-WAV bytes", () => {
    expect(parseWav(Buffer.from("ID3\u0004not audio"))).toBeNull();
  });

  it("concatenates WAVs into one file with a single header", () => {
    // The naive approach — Buffer.concat on whole files — leaves a 44-byte
    // header embedded mid-stream, which decoders render as a click.
    const parts = [makeWav(500), makeWav(700), makeWav(300)];
    const joined = concatAudio(parts);
    const parsed = parseWav(joined);

    expect(parsed).not.toBeNull();
    expect(parsed?.data.length).toBe((500 + 700 + 300) * 2);
    expect(joined.length).toBe(44 + 3000);

    // Exactly one RIFF marker in the output.
    let markers = 0;
    for (let i = 0; i + 4 <= joined.length; i += 1) {
      if (joined.toString("ascii", i, i + 4) === "RIFF") markers += 1;
    }
    expect(markers).toBe(1);
  });

  it("declares the correct payload size in the rebuilt header", () => {
    const joined = concatAudio([makeWav(100), makeWav(100)]);
    expect(joined.readUInt32LE(40)).toBe(400);
    expect(joined.readUInt32LE(4)).toBe(joined.length - 8);
  });

  it("passes frame-based codecs through untouched", () => {
    const a = Buffer.from([0xff, 0xfb, 0x01, 0x02]);
    const b = Buffer.from([0xff, 0xfb, 0x03, 0x04]);
    expect(concatAudio([a, b])).toEqual(Buffer.concat([a, b]));
  });

  it("handles single and empty inputs", () => {
    const one = makeWav(50);
    expect(concatAudio([one])).toBe(one);
    expect(concatAudio([]).length).toBe(0);
  });

  it("strips the container for the streaming path", () => {
    const { format, pcm } = toPcm(makeWav(250));
    expect(format.sampleRate).toBe(24000);
    expect(pcm.length).toBe(500);
  });
});
