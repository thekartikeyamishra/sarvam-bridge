import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { AppContext } from "../context.js";
import {
  sanitiseHeaderValue,
  serialiseError,
  toGatewayError,
  tooManyRequests,
  unauthorized,
  type Dialect,
} from "../lib/errors.js";

/**
 * Cross-cutting request handling shared by every vendor dialect.
 */

/**
 * Extract the caller's credential from whichever header their SDK sends.
 *
 * Note what happens to this value: it is used for rate-limit bucketing and,
 * optionally, gateway authentication. It is never forwarded upstream. The
 * Sarvam key lives only in the gateway's environment, which means application
 * code and client devices never hold it, and rotating it does not require
 * redeploying anything downstream. That separation is most of the security
 * argument for running a bridge at all.
 */
export function extractClientCredential(req: FastifyRequest): string {
  const headers = req.headers;
  const xi = headers["xi-api-key"];
  if (typeof xi === "string" && xi.length > 0) return xi;

  const auth = headers["authorization"];
  if (typeof auth === "string" && auth.length > 0) {
    const match = /^(?:bearer|token)\s+(.+)$/i.exec(auth.trim());
    return match?.[1] ?? auth.trim();
  }

  const apiKey = headers["api-key"];
  if (typeof apiKey === "string" && apiKey.length > 0) return apiKey;

  return "";
}

/** Constant-time comparison, to keep token checks free of timing signal. */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  let diff = 0;
  for (let i = 0; i < ha.length; i += 1) {
    diff |= (ha[i] as number) ^ (hb[i] as number);
  }
  return diff === 0;
}

/** Stable, non-reversible bucket key. Raw credentials never reach logs. */
function bucketKey(credential: string, ip: string): string {
  const basis = credential || `ip:${ip}`;
  return createHash("sha256").update(basis).digest("hex").slice(0, 32);
}

export interface GuardResult {
  readonly credential: string;
  readonly bucket: string;
}

/**
 * Authenticate (if configured) and rate limit. Throws a GatewayError that the
 * dialect-aware error handler will render in the caller's expected shape.
 */
export function guard(ctx: AppContext, req: FastifyRequest, reply: FastifyReply): GuardResult {
  const credential = extractClientCredential(req);
  const expected = ctx.config.GATEWAY_AUTH_TOKEN;

  if (expected.length > 0 && !safeEqual(credential, expected)) {
    ctx.metrics.increment("sarvam_bridge_auth_failures_total");
    throw unauthorized(
      "Missing or invalid gateway credential. Send it as xi-api-key or Authorization: Bearer.",
    );
  }

  const bucket = bucketKey(credential, req.ip);
  const verdict = ctx.limiter.consume(bucket);
  reply.header("x-ratelimit-remaining", String(verdict.remaining));

  if (!verdict.allowed) {
    ctx.metrics.increment("sarvam_bridge_rate_limited_total");
    reply.header("retry-after", String(verdict.retryAfter));
    throw tooManyRequests(
      `Rate limit exceeded. Retry in ${verdict.retryAfter}s.`,
    );
  }

  return { credential, bucket };
}

/**
 * Surface non-fatal compatibility notes without breaking the response
 * contract. A migrating team needs to know that `stability` was ignored, but
 * putting that in the body would corrupt an audio stream — so it goes in a
 * header their SDK will quietly ignore and their logs will happily capture.
 */
export function attachWarnings(reply: FastifyReply, warnings: readonly string[]): void {
  if (warnings.length === 0) return;
  // Warnings can quote caller-supplied values, so they are sanitised to latin1
  // and stripped of CR/LF before touching a header.
  const joined = sanitiseHeaderValue(warnings.join(" | "));
  if (joined.length > 0) reply.header("x-sarvam-bridge-warnings", joined);
}

/** Set a header whose value may derive from caller input. */
export function safeHeader(
  reply: FastifyReply,
  name: string,
  value: string,
): void {
  const clean = sanitiseHeaderValue(value, 200);
  if (clean.length > 0) reply.header(name, clean);
}

/** Wrap a handler so every failure is rendered in the caller's dialect. */
export function withDialect<T>(
  ctx: AppContext,
  dialect: Dialect,
  route: string,
  handler: (req: FastifyRequest, reply: FastifyReply) => Promise<T>,
) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<T | void> => {
    const startedAt = process.hrtime.bigint();
    try {
      const result = await handler(req, reply);
      ctx.metrics.increment("sarvam_bridge_requests_total", {
        route,
        dialect,
        outcome: "success",
      });
      return result;
    } catch (err) {
      const gatewayError = toGatewayError(err);
      ctx.metrics.increment("sarvam_bridge_requests_total", {
        route,
        dialect,
        outcome: "error",
      });
      ctx.metrics.increment("sarvam_bridge_errors_total", {
        route,
        code: gatewayError.code,
        status: String(gatewayError.statusCode),
      });

      req.log.warn(
        {
          route,
          dialect,
          status: gatewayError.statusCode,
          code: gatewayError.code,
          err: gatewayError.message,
        },
        "request failed",
      );

      await reply
        .status(gatewayError.statusCode)
        .type("application/json")
        .send(serialiseError(gatewayError, dialect));
      return;
    } finally {
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      ctx.metrics.observe("sarvam_bridge_request_duration_seconds", seconds, {
        route,
      });
    }
  };
}
