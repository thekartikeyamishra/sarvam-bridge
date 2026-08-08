import { describe, expect, it } from "vitest";
import {
  detectScript,
  normaliseLanguage,
  resolveLanguage,
} from "../src/sarvam/languages.js";

describe("normaliseLanguage", () => {
  it("maps bare ISO codes used by other vendors", () => {
    expect(normaliseLanguage("hi")).toBe("hi-IN");
    expect(normaliseLanguage("ta")).toBe("ta-IN");
    expect(normaliseLanguage("en-US")).toBe("en-IN");
  });

  it("maps Odia to Sarvam's non-standard od-IN code", () => {
    // ISO 639-1 says "or"; Sarvam's API expects "od-IN". A migrating client
    // will send "or" and get a 400 unless this is translated.
    expect(normaliseLanguage("or")).toBe("od-IN");
    expect(normaliseLanguage("or-IN")).toBe("od-IN");
  });

  it("returns null for absent or auto-detect sentinels", () => {
    expect(normaliseLanguage(undefined)).toBeNull();
    expect(normaliseLanguage("auto")).toBeNull();
    expect(normaliseLanguage("klingon")).toBeNull();
  });
});

describe("detectScript", () => {
  it("identifies each supported Indic script", () => {
    expect(detectScript("नमस्ते").language).toBe("hi-IN");
    expect(detectScript("வணக்கம்").language).toBe("ta-IN");
    expect(detectScript("নমস্কার").language).toBe("bn-IN");
    expect(detectScript("ನಮಸ್ಕಾರ").language).toBe("kn-IN");
    expect(detectScript("നമസ്കാരം").language).toBe("ml-IN");
    expect(detectScript("નમસ્તે").language).toBe("gu-IN");
    expect(detectScript("ਸਤ ਸ੍ਰੀ ਅਕਾਲ").language).toBe("pa-IN");
    expect(detectScript("నమస్కారం").language).toBe("te-IN");
  });

  it("returns null for pure Latin text", () => {
    expect(detectScript("hello world").language).toBeNull();
  });

  it("picks the dominant script, not the first one seen", () => {
    const result = detectScript("வணக்கம் வணக்கம் வணக்கம் न");
    expect(result.language).toBe("ta-IN");
  });

  it("flags code-mixed input", () => {
    const result = detectScript("Hello नमस्ते");
    expect(result.mixed).toBe(true);
    expect(result.language).toBe("hi-IN");
  });
});

describe("resolveLanguage", () => {
  it("prefers an explicit language over detection", () => {
    const out = resolveLanguage("नमस्ते", "ta", "en-IN");
    expect(out.language).toBe("ta-IN");
    expect(out.source).toBe("explicit");
  });

  it("detects from script when the caller sent nothing", () => {
    // This is the whole point: ElevenLabs and OpenAI clients never send a
    // language, and Sarvam requires one.
    const out = resolveLanguage("नमस्ते दुनिया", undefined, "en-IN");
    expect(out.language).toBe("hi-IN");
    expect(out.source).toBe("detected");
  });

  it("falls back to the configured default for Latin text", () => {
    const out = resolveLanguage("hello", undefined, "en-IN");
    expect(out.language).toBe("en-IN");
    expect(out.source).toBe("default");
  });
});
