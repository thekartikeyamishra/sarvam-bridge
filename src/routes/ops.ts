import type { FastifyInstance } from "fastify";

import type { AppContext } from "../context.js";
import { detectScript, resolveLanguage } from "../sarvam/languages.js";
import { charLimitFor, chunkText } from "../sarvam/chunk.js";
import { resolveVoice, type TtsModel } from "../sarvam/voices.js";

export const VERSION = "1.0.0";

/**
 * Operational and introspection endpoints.
 *
 * /healthz and /readyz are separated on purpose. Liveness must never depend on
 * a third party: if Sarvam has a bad minute, an orchestrator that conflates the
 * two will start killing healthy pods and turn a partial outage into a total
 * one. Liveness answers "is this process working"; readiness answers "should it
 * receive traffic".
 */
export function registerOpsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/healthz", async (_req, reply) => {
    return reply.send({
      status: "ok",
      version: VERSION,
      uptimeSeconds: Math.floor(process.uptime()),
    });
  });

  app.get("/readyz", async (_req, reply) => {
    const configured = ctx.config.SARVAM_API_KEY.length > 0;
    return reply.status(configured ? 200 : 503).send({
      status: configured ? "ready" : "not-ready",
      upstream: ctx.config.SARVAM_BASE_URL,
      ttsModel: ctx.config.DEFAULT_TTS_MODEL,
      sttModel: ctx.config.DEFAULT_STT_MODEL,
    });
  });

  app.get("/metrics", async (_req, reply) => {
    const cache = ctx.cache.stats();
    const total = cache.hits + cache.misses;

    const body = ctx.metrics.render({
      sarvam_bridge_cache_hits_total: cache.hits,
      sarvam_bridge_cache_misses_total: cache.misses,
      sarvam_bridge_cache_entries: cache.entries,
      sarvam_bridge_cache_bytes: cache.bytes,
      sarvam_bridge_cache_evictions_total: cache.evictions,
      sarvam_bridge_cache_hit_ratio: total === 0 ? 0 : cache.hits / total,
      sarvam_bridge_coalesced_requests_total: ctx.inFlight.coalesced,
      sarvam_bridge_inflight_synthesis: ctx.inFlight.size,
      sarvam_bridge_ratelimit_buckets: ctx.limiter.size,
      sarvam_bridge_rss_bytes: process.memoryUsage().rss,
    });

    return reply.type("text/plain; version=0.0.4; charset=utf-8").send(body);
  });

  /**
   * Dry-run endpoint. Shows exactly how an inbound request would be translated
   * — language, speaker, chunking — without spending a single upstream credit.
   *
   * This exists because the scariest part of any migration is not knowing what
   * the layer in the middle is doing. Being able to diff the mapping for your
   * real production strings, for free, before sending traffic, is what makes a
   * gateway auditable rather than a black box.
   */
  app.post("/v1/bridge/explain", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = typeof body["text"] === "string" ? body["text"] : "";
    if (text.trim().length === 0) {
      return reply.status(400).send({
        error: { code: "invalid_request_error", message: "`text` is required." },
      });
    }

    const model = ((body["model"] as string) ??
      ctx.config.DEFAULT_TTS_MODEL) as TtsModel;
    const { language, source } = resolveLanguage(
      text,
      body["language"],
      ctx.config.DEFAULT_LANGUAGE,
    );
    const voice = resolveVoice({
      requested: body["voice"] as string | undefined,
      model,
      language,
      operatorMap: ctx.voiceMap,
      configuredDefault: ctx.config.DEFAULT_SPEAKER || undefined,
    });
    const limit = charLimitFor(model);
    const chunks = chunkText(text, limit);

    return reply.send({
      input: { characters: text.length, model, limit },
      script: detectScript(text),
      language: { resolved: language, source },
      voice: {
        requested: body["voice"] ?? null,
        resolved: voice.speaker,
        source: voice.source,
        ...(voice.warning ? { warning: voice.warning } : {}),
      },
      chunking: {
        count: chunks.length,
        sizes: chunks.map((c) => c.length),
        preview: chunks.map((c) => (c.length > 80 ? `${c.slice(0, 80)}…` : c)),
      },
      upstreamCallsRequired: chunks.length,
    });
  });
}
