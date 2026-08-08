import { describe, expect, it } from "vitest";
import {
  isValidSpeaker,
  genderOfSpeaker,
  listSpeakers,
  parseVoiceMap,
  resolveVoice,
} from "../src/sarvam/voices.js";

describe("speaker catalogue", () => {
  it("keeps v2 and v3 speaker sets disjoint in the ways that matter", () => {
    expect(isValidSpeaker("shubh", "bulbul:v3")).toBe(true);
    expect(isValidSpeaker("shubh", "bulbul:v2")).toBe(false);
    expect(isValidSpeaker("anushka", "bulbul:v2")).toBe(true);
    expect(isValidSpeaker("anushka", "bulbul:v3")).toBe(false);
  });

  it("knows the gender of every catalogued speaker", () => {
    for (const model of ["bulbul:v2", "bulbul:v3"] as const) {
      for (const speaker of listSpeakers(model)) {
        expect(genderOfSpeaker(speaker)).toMatch(/^(male|female)$/);
      }
    }
  });
});

describe("resolveVoice", () => {
  it("passes through a speaker that is already valid", () => {
    const out = resolveVoice({
      requested: "priya",
      model: "bulbul:v3",
      language: "hi-IN",
    });
    expect(out.speaker).toBe("priya");
    expect(out.source).toBe("passthrough");
  });

  it("remaps a speaker from the wrong model generation, preserving gender", () => {
    const out = resolveVoice({
      requested: "anushka", // female, v2 only
      model: "bulbul:v3",
      language: "hi-IN",
    });
    expect(isValidSpeaker(out.speaker, "bulbul:v3")).toBe(true);
    expect(genderOfSpeaker(out.speaker)).toBe("female");
    expect(out.warning).toContain("bulbul:v2");
  });

  it("honours an operator-supplied mapping above everything else", () => {
    const out = resolveVoice({
      requested: "21m00Tcm4TlvDq8ikWAM",
      model: "bulbul:v3",
      language: "hi-IN",
      operatorMap: { "21m00tcm4tlvdq8ikwam": "kavya" },
    });
    expect(out.speaker).toBe("kavya");
    expect(out.source).toBe("operator-map");
  });

  it("preserves gender for a known stock vendor voice id", () => {
    const male = resolveVoice({
      requested: "pNInz6obpgDQGcFmaJgB", // Adam
      model: "bulbul:v3",
      language: "en-IN",
    });
    expect(genderOfSpeaker(male.speaker)).toBe("male");
  });

  it("uses Sarvam's language-specific recommendation for Punjabi", () => {
    // Sarvam names `mani` as the best male speaker for Punjabi.
    const out = resolveVoice({
      requested: "onwK4e9ZLuTAKqWW03F9", // Daniel, male
      model: "bulbul:v3",
      language: "pa-IN",
    });
    expect(out.speaker).toBe("mani");
  });

  it("never auto-selects the villain character voice", () => {
    // `varun` has an excellent CER but Sarvam flags it as non-neutral.
    for (const language of ["hi-IN", "en-IN", "ta-IN", "pa-IN"] as const) {
      for (const id of ["unknown-id", "pNInz6obpgDQGcFmaJgB", ""]) {
        const out = resolveVoice({ requested: id, model: "bulbul:v3", language });
        expect(out.speaker).not.toBe("varun");
      }
    }
  });

  it("always returns a speaker valid for the requested model", () => {
    for (const model of ["bulbul:v2", "bulbul:v3"] as const) {
      const out = resolveVoice({
        requested: "totally-unknown-voice",
        model,
        language: "hi-IN",
      });
      expect(isValidSpeaker(out.speaker, model)).toBe(true);
    }
  });
});

describe("parseVoiceMap", () => {
  it("parses and lowercases a JSON mapping", () => {
    expect(parseVoiceMap('{"ABC":"Priya"}')).toEqual({ abc: "priya" });
  });

  it("degrades safely on malformed input rather than crashing boot", () => {
    expect(parseVoiceMap("not json")).toEqual({});
    expect(parseVoiceMap("[1,2]")).toEqual({});
    expect(parseVoiceMap(undefined)).toEqual({});
  });
});
