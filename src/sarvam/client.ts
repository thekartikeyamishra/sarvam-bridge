import { UpstreamError } from "../lib/errors.js";

/**
 * Sarvam API client.
 *
 * Deliberately built on the Node 22 global fetch rather than an HTTP library:
 * one less dependency sitting next to a production API key, and Node's built-in
 * pooling is sufficient at this tier.
 *
 * Three behaviours make this safe to run unattended:
 *
 * - Bounded concurrency. Without it, a burst of long inputs fans out into
 *   hundreds of simultaneous upstream calls, which trips Sarvam's rate limit
 *   and turns a slow request into a failed one.
 * - Timeouts on every call, so a hung upstream cannot pin a worker forever.
 * - Retries with full jitter on the transient classes only (429/5xx/network).
 *   4xx other than 429 are caller errors and are surfaced immediately rather
 *   than retried, which would just burn quota.
 */

export interface SarvamClientOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly concurrency: number;
  readonly fetchImpl?: typeof fetch;
}

export interface TtsParams {
  readonly text: string;
  readonly language_code: string;
  readonly speaker?: string;
  readonly model: string;
  readonly pace?: number;
  readonly pitch?: number;
  readonly loudness?: number;
  readonly speech_sample_rate?: number;
  readonly output_audio_codec?: string;
  readonly enable_preprocessing?: boolean;
}

export interface TtsResponse {
  readonly request_id?: string;
  readonly audios: string[];
}

export interface SttParams {
  readonly audio: Buffer;
  readonly filename: string;
  readonly contentType: string;
  readonly model: string;
  readonly languageCode?: string | undefined;
  readonly mode?: string | undefined;
}

export interface SttResponse {
  readonly request_id?: string;
  readonly transcript: string;
  readonly language_code?: string | null;
  readonly diarized_transcript?: unknown;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Minimal counting semaphore. */
class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active += 1;
    return () => this.release();
  }

  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SarvamClient {
  private readonly opts: SarvamClientOptions;
  private readonly semaphore: Semaphore;
  private readonly doFetch: typeof fetch;

  constructor(opts: SarvamClientOptions) {
    this.opts = opts;
    this.semaphore = new Semaphore(opts.concurrency);
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  private url(path: string): string {
    return `${this.opts.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  /**
   * Compute backoff for attempt N. Full jitter (random between 0 and the
   * exponential ceiling) rather than fixed backoff, because synchronised
   * retries from many workers are what turn a brief 429 into an outage.
   */
  private backoffMs(attempt: number, retryAfterHeader: string | null): number {
    if (retryAfterHeader) {
      const seconds = Number.parseFloat(retryAfterHeader);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1000, 20_000);
      }
    }
    const ceiling = Math.min(250 * 2 ** attempt, 8_000);
    return Math.random() * ceiling;
  }

  /**
   * Perform one attempt while holding a semaphore slot. The slot is always
   * released before any backoff sleep, so waiting retries never occupy
   * concurrency that a fresh request could use.
   */
  private async attemptOnce(
    path: string,
    init: RequestInit,
  ): Promise<{ ok: true; response: Response } | { ok: false; error: unknown }> {
    const release = await this.semaphore.acquire();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const response = await this.doFetch(this.url(path), {
        ...init,
        signal: controller.signal,
        headers: {
          "api-subscription-key": this.opts.apiKey,
          "user-agent": "sarvam-bridge/1.0",
          ...(init.headers ?? {}),
        },
      });
      return { ok: true, response };
    } catch (error) {
      return { ok: false, error };
    } finally {
      clearTimeout(timer);
      release();
    }
  }

  private async request(
    path: string,
    init: RequestInit,
    attempt = 0,
  ): Promise<Response> {
    const result = await this.attemptOnce(path, init);

    if (result.ok) {
      const { response } = result;
      if (
        RETRYABLE_STATUS.has(response.status) &&
        attempt < this.opts.maxRetries
      ) {
        const wait = this.backoffMs(attempt, response.headers.get("retry-after"));
        // Drain the body so the socket returns to the pool.
        try {
          await response.arrayBuffer();
        } catch {
          /* ignore */
        }
        await sleep(wait);
        return this.request(path, init, attempt + 1);
      }
      return response;
    }

    const err = result.error;
    const isAbort = err instanceof Error && err.name === "AbortError";

    if (attempt < this.opts.maxRetries && !isAbort) {
      await sleep(this.backoffMs(attempt, null));
      return this.request(path, init, attempt + 1);
    }
    if (isAbort) {
      throw new UpstreamError(
        504,
        `Sarvam request timed out after ${this.opts.timeoutMs}ms.`,
        "gateway_timeout",
      );
    }
    throw new UpstreamError(
      502,
      `Could not reach Sarvam: ${err instanceof Error ? err.message : String(err)}`,
      "upstream_unreachable",
    );
  }

  private async parseFailure(response: Response): Promise<never> {
    let message = `Sarvam returned ${response.status}`;
    let code = "upstream_error";
    let requestId: string | undefined;

    try {
      const body: unknown = await response.json();
      if (typeof body === "object" && body !== null) {
        const record = body as Record<string, unknown>;
        const error = record["error"];
        if (typeof error === "object" && error !== null) {
          const e = error as Record<string, unknown>;
          if (typeof e["message"] === "string") message = e["message"];
          if (typeof e["code"] === "string") code = e["code"];
          if (typeof e["request_id"] === "string") requestId = e["request_id"];
        } else if (typeof record["message"] === "string") {
          message = record["message"];
        }
      }
    } catch {
      /* non-JSON body; keep the generic message */
    }

    // 403 upstream means *our* key is bad. Surfacing that as 403 to the caller
    // would make them think their credentials are wrong, so it maps to 502.
    const status = response.status === 403 ? 502 : response.status;
    if (response.status === 403) {
      message = `Sarvam rejected the gateway's API key (403). Check SARVAM_API_KEY. Upstream said: ${message}`;
    }
    throw new UpstreamError(status, message, code, requestId);
  }

  async textToSpeech(params: TtsParams): Promise<TtsResponse> {
    const body: Record<string, unknown> = {
      text: params.text,
      language_code: params.language_code,
      model: params.model,
    };
    if (params.speaker) body["speaker"] = params.speaker;
    if (params.pace !== undefined) body["pace"] = params.pace;
    if (params.pitch !== undefined) body["pitch"] = params.pitch;
    if (params.loudness !== undefined) body["loudness"] = params.loudness;
    if (params.speech_sample_rate !== undefined) {
      body["speech_sample_rate"] = params.speech_sample_rate;
    }
    if (params.output_audio_codec) {
      body["output_audio_codec"] = params.output_audio_codec;
    }
    if (params.enable_preprocessing !== undefined) {
      body["enable_preprocessing"] = params.enable_preprocessing;
    }

    const response = await this.request("/text-to-speech", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) await this.parseFailure(response);

    const json = (await response.json()) as TtsResponse;
    if (!Array.isArray(json.audios) || json.audios.length === 0) {
      throw new UpstreamError(
        502,
        "Sarvam returned no audio for this request.",
        "empty_response",
      );
    }
    return json;
  }

  async speechToText(params: SttParams): Promise<SttResponse> {
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(params.audio)], { type: params.contentType }),
      params.filename,
    );
    form.append("model", params.model);
    if (params.languageCode) form.append("language_code", params.languageCode);
    if (params.mode) form.append("mode", params.mode);

    const response = await this.request("/speech-to-text", {
      method: "POST",
      body: form,
    });

    if (!response.ok) await this.parseFailure(response);

    const json = (await response.json()) as SttResponse;
    return { ...json, transcript: json.transcript ?? "" };
  }
}
