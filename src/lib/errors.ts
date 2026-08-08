/**
 * Error types.
 *
 * A compatibility gateway has to lie convincingly about its errors too. An
 * ElevenLabs client parses ElevenLabs-shaped error bodies; an OpenAI client
 * parses OpenAI-shaped ones. Returning a generic body would break error
 * handling in the very apps we are trying to leave untouched, so each route
 * serialises failures in its source vendor's dialect.
 */

export type Dialect = "elevenlabs" | "openai" | "deepgram" | "native";

export class GatewayError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "GatewayError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class UpstreamError extends GatewayError {
  readonly requestId?: string;

  constructor(
    statusCode: number,
    message: string,
    code = "upstream_error",
    requestId?: string,
  ) {
    super(statusCode, code, message);
    this.name = "UpstreamError";
    this.requestId = requestId;
  }
}

export function badRequest(message: string, code = "invalid_request_error") {
  return new GatewayError(400, code, message);
}

export function unauthorized(message = "Invalid or missing credentials.") {
  return new GatewayError(401, "authentication_error", message);
}

export function payloadTooLarge(message: string) {
  return new GatewayError(413, "payload_too_large", message);
}

export function tooManyRequests(message = "Rate limit exceeded.") {
  return new GatewayError(429, "rate_limit_error", message);
}

/** Render an error in the shape the calling client expects. */
export function serialiseError(
  err: GatewayError,
  dialect: Dialect,
): Record<string, unknown> {
  switch (dialect) {
    case "elevenlabs":
      return {
        detail: {
          status: err.code,
          message: err.message,
        },
      };
    case "openai":
      return {
        error: {
          message: err.message,
          type: err.code,
          param: null,
          code: err.code,
        },
      };
    case "deepgram":
      return {
        err_code: err.code,
        err_msg: err.message,
      };
    case "native":
    default:
      return {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
        },
      };
  }
}

/**
 * Normalise anything thrown into a GatewayError.
 *
 * Fastify's own errors (body too large, unsupported media type, malformed
 * JSON) already carry an accurate `statusCode` and `code`. Collapsing those to
 * 500 would tell the caller the gateway broke when in fact their request was
 * rejected — and would page an on-call engineer for what is a client error.
 */
export function toGatewayError(err: unknown): GatewayError {
  if (err instanceof GatewayError) return err;

  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      return new GatewayError(504, "gateway_timeout", "Upstream request timed out.");
    }

    const candidate = err as Error & { statusCode?: unknown; code?: unknown };
    const status =
      typeof candidate.statusCode === "number" &&
      candidate.statusCode >= 400 &&
      candidate.statusCode <= 599
        ? candidate.statusCode
        : null;

    if (status !== null) {
      const code =
        typeof candidate.code === "string" && candidate.code.length > 0
          ? candidate.code
          : status >= 500
            ? "internal_error"
            : "invalid_request_error";
      return new GatewayError(status, code, err.message);
    }

    // A JSON parse failure surfaces as a plain SyntaxError with no status.
    if (err instanceof SyntaxError) {
      return new GatewayError(
        400,
        "invalid_request_error",
        `Malformed JSON body: ${err.message}`,
      );
    }

    return new GatewayError(500, "internal_error", err.message);
  }

  return new GatewayError(500, "internal_error", "An unexpected error occurred.");
}

/**
 * Make a string safe to place in an HTTP header value.
 *
 * Header values are latin1. A caller-supplied voice id containing Devanagari
 * or an emoji makes Node throw when the header is written, which turns a
 * cosmetic warning into a 500 — a remote crash triggered by ordinary input in
 * the very languages this gateway exists to serve. CR and LF are stripped
 * first, since those would allow response header injection.
 */
export function sanitiseHeaderValue(value: string, maxLength = 1800): string {
  let out = "";
  for (const char of value) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp === 0x0d || cp === 0x0a || cp === 0x09) {
      out += " ";
    } else if (cp < 0x20 || cp === 0x7f) {
      continue; // other control characters
    } else if (cp > 0xff) {
      out += "?"; // outside latin1
    } else {
      out += char;
    }
    if (out.length >= maxLength) break;
  }
  return out.slice(0, maxLength).trim();
}
