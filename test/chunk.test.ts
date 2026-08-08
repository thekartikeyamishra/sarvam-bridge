import { describe, expect, it } from "vitest";
import { charLimitFor, chunkText, splitSentences } from "../src/sarvam/chunk.js";

describe("splitSentences", () => {
  it("splits on the Devanagari danda", () => {
    const out = splitSentences("यह पहला वाक्य है। यह दूसरा वाक्य है।");
    expect(out).toHaveLength(2);
    expect(out[0]).toBe("यह पहला वाक्य है।");
    expect(out[1]).toBe("यह दूसरा वाक्य है।");
  });

  it("splits on the double danda and ASCII terminators", () => {
    expect(splitSentences("एक॥ दो। Three! Four?")).toHaveLength(4);
  });

  it("treats newlines as hard boundaries", () => {
    expect(splitSentences("line one\nline two")).toEqual(["line one", "line two"]);
  });
});

describe("chunkText", () => {
  it("returns a single chunk when the text already fits", () => {
    expect(chunkText("short text", 2500)).toEqual(["short text"]);
  });

  it("never emits a chunk larger than the limit", () => {
    const sentence = "यह एक लंबा हिंदी वाक्य है जिसमें बहुत सारे शब्द हैं। ";
    const text = sentence.repeat(200);
    for (const chunk of chunkText(text, 300)) {
      expect(chunk.length).toBeLessThanOrEqual(300);
    }
  });

  it("preserves all non-whitespace content across chunks", () => {
    const text = "अ ब स द ई फ ग ह ".repeat(120);
    const rejoined = chunkText(text, 200).join(" ").replace(/\s+/g, "");
    expect(rejoined).toBe(text.replace(/\s+/g, ""));
  });

  it("does not split inside a grapheme cluster", () => {
    // "कि" is a base consonant plus a dependent vowel sign; splitting between
    // them would strand a combining mark at the start of the next chunk.
    const text = "कि".repeat(400);
    for (const chunk of chunkText(text, 101)) {
      expect(chunk.codePointAt(0)).not.toBe(0x093f); // no leading matra
      expect(chunk.length % 2).toBe(0);
    }
  });

  it("breaks an over-long sentence with no punctuation at all", () => {
    const chunks = chunkText("क".repeat(1000), 250);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(250);
  });

  it("prefers packing sentences greedily", () => {
    const text = "One. Two. Three. Four. Five.";
    expect(chunkText(text, 2500)).toHaveLength(1);
  });

  it("drops empty input", () => {
    expect(chunkText("   ", 2500)).toEqual([]);
  });
});

describe("charLimitFor", () => {
  it("uses the documented per-model ceilings", () => {
    expect(charLimitFor("bulbul:v3")).toBe(2500);
    expect(charLimitFor("bulbul:v2")).toBe(1500);
    expect(charLimitFor("unknown")).toBe(2500);
  });
});
