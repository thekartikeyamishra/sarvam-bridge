import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { parseTrustProxy } from "../src/server.js";

describe("configuration", () => {
  it("refuses to boot without an API key", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/SARVAM_API_KEY/);
  });

  it("rejects an out-of-range port rather than binding something odd", () => {
    expect(() =>
      loadConfig({ SARVAM_API_KEY: "k", PORT: "99999" } as NodeJS.ProcessEnv),
    ).toThrow();
  });

  it("coerces booleanish strings the way operators actually write them", () => {
    const cfg = loadConfig({
      SARVAM_API_KEY: "k",
      CACHE_ENABLED: "no",
      RATE_LIMIT_ENABLED: "1",
    } as NodeJS.ProcessEnv);
    expect(cfg.CACHE_ENABLED).toBe(false);
    expect(cfg.RATE_LIMIT_ENABLED).toBe(true);
  });

  it("only accepts documented TTS models", () => {
    expect(() =>
      loadConfig({
        SARVAM_API_KEY: "k",
        DEFAULT_TTS_MODEL: "bulbul:v9",
      } as NodeJS.ProcessEnv),
    ).toThrow();
  });
});

describe("parseTrustProxy", () => {
  it("defaults to not trusting anything", () => {
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("   ")).toBe(false);
  });

  it("supports an explicit allowlist", () => {
    expect(parseTrustProxy("127.0.0.1, 10.0.0.0/8")).toEqual([
      "127.0.0.1",
      "10.0.0.0/8",
    ]);
  });

  it("supports the blunt true/false forms", () => {
    expect(parseTrustProxy("true")).toBe(true);
    expect(parseTrustProxy("false")).toBe(false);
  });
});
