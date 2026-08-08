import "dotenv/config";
import { z } from "zod";

/**
 * All configuration is environment-driven so the same image runs in dev,
 * staging and production without a rebuild. Validation happens once at boot:
 * a misconfigured deployment fails immediately and loudly rather than at the
 * first user request.
 */

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) => {
    if (typeof v === "boolean") return v;
    return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
  });

const ConfigSchema = z.object({
  /** Sarvam API subscription key. The only real secret in the system. */
  SARVAM_API_KEY: z.string().min(1, "SARVAM_API_KEY is required"),
  SARVAM_BASE_URL: z.string().url().default("https://api.sarvam.ai"),

  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  /** Default models. Overridable per request where the source API allows it. */
  DEFAULT_TTS_MODEL: z.enum(["bulbul:v2", "bulbul:v3"]).default("bulbul:v3"),
  DEFAULT_STT_MODEL: z.string().default("saaras:v3"),
  DEFAULT_LANGUAGE: z.string().default("en-IN"),
  DEFAULT_SPEAKER: z.string().default(""),

  /**
   * Optional gateway auth. When set, callers must present this value in the
   * inbound vendor header (xi-api-key / Authorization / etc). This lets you
   * expose the bridge to your own services without leaking the Sarvam key,
   * and rotate client credentials independently of the upstream key.
   */
  GATEWAY_AUTH_TOKEN: z.string().default(""),

  /** Response cache. The single largest cost lever for repeated TTS prompts. */
  CACHE_ENABLED: booleanish.default(true),
  CACHE_MAX_ENTRIES: z.coerce.number().int().min(0).default(500),
  CACHE_MAX_BYTES: z.coerce.number().int().min(0).default(256 * 1024 * 1024),
  CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(3600),

  /** Upstream resilience. */
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30000),
  UPSTREAM_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
  UPSTREAM_CONCURRENCY: z.coerce.number().int().min(1).default(8),

  /** Inbound rate limiting (token bucket, per client key). */
  RATE_LIMIT_ENABLED: booleanish.default(true),
  RATE_LIMIT_CAPACITY: z.coerce.number().int().min(1).default(60),
  RATE_LIMIT_REFILL_PER_SEC: z.coerce.number().min(0.1).default(10),

  /** Hard ceiling on inbound request bodies (audio uploads). */
  MAX_UPLOAD_BYTES: z.coerce.number().int().min(1024).default(32 * 1024 * 1024),

  /**
   * Whether to trust X-Forwarded-* headers.
   *
   * Defaults to OFF. Blindly trusting these lets any caller spoof their source
   * IP, which matters here because req.ip is a rate-limit bucketing key: an
   * attacker rotating a forged X-Forwarded-For would get unlimited quota.
   *
   * Set this only when the gateway genuinely sits behind a proxy you control.
   * Accepts `true`, or a comma-separated list of trusted proxy IPs/CIDRs,
   * which is the safer form.
   */
  TRUST_PROXY: z.string().default(""),

  /** Emit a warning header when a source-API param has no Sarvam equivalent. */
  STRICT_COMPAT: booleanish.default(false),
});

export type Config = z.infer<typeof ConfigSchema>;

let cached: Config | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}

export function getConfig(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test helper: inject a config without touching process.env. */
export function setConfig(cfg: Config): void {
  cached = cfg;
}

export function resetConfig(): void {
  cached = null;
}
