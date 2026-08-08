# sarvam-bridge

**Point an existing ElevenLabs, OpenAI Audio or Deepgram application at Sarvam AI. Change one line. Ship.**

```diff
- const client = new ElevenLabs({ apiKey: process.env.ELEVENLABS_API_KEY });
+ const client = new ElevenLabs({ apiKey: "unused", environment: "http://localhost:8080" });
```

That's the migration. No SDK swap, no response-handling rewrite, no base64 decode step, no chunking logic, no language-code plumbing. The bridge speaks each vendor's dialect on the front and Sarvam on the back.

---

## Why this exists

Sarvam's documentation is unusually candid about where migrations go wrong. The ElevenLabs text-to-speech migration guide ends with a **"Common mistakes"** section listing five distinct bugs, and calls one of them *"the single most common migration bug."*

That list is a specification for a piece of missing infrastructure. Every one of those five failure modes is mechanical, and every one of them disappears if something sits between the application and the API:

| Documented migration mistake | How the bridge removes it |
|---|---|
| Writing the JSON response directly as an audio file | Returns raw audio bytes, decoding Sarvam's base64 `audios` array server-side |
| Forgetting the required `language_code` | Resolves it from an explicit param, then Unicode script detection, then a default |
| Tuning `pace`/`pitch` instead of choosing a better speaker | Maps voices using Sarvam's own published per-language CER guidance |
| Sending `pitch`/`loudness` to `bulbul:v3`, where they silently no-op | Drops them and emits a visible warning header |
| Exceeding the per-model character limit | Chunks at Indic sentence boundaries, then re-joins the audio correctly |

Sarvam maintains four hand-written migration guides (ElevenLabs, Cartesia, Deepgram, Gemini). Each one asks a developer to read a table and edit their code. **Switching cost is the bottleneck.** This removes it.

---

## Quick start

**Requires Node 20+.** Built and tested on Node 22.22.

```bash
npm install
cp .env.example .env          # add your SARVAM_API_KEY
npm run dev
```

Then, without a Sarvam key or any network call, see exactly what the bridge would do:

```bash
curl -X POST localhost:8080/v1/bridge/explain \
  -H 'content-type: application/json' \
  -d '{"text":"வணக்கம், இது ஒரு சோதனை.","voice":"21m00Tcm4TlvDq8ikWAM"}'
```

```json
{
  "script":   { "language": "ta-IN", "confidence": 1, "mixed": false },
  "language": { "resolved": "ta-IN", "source": "detected" },
  "voice":    { "requested": "21m00Tcm4TlvDq8ikWAM", "resolved": "priya", "source": "known-vendor-id" },
  "chunking": { "count": 1, "sizes": [23] },
  "upstreamCallsRequired": 1
}
```

Tamil detected from the script alone. Rachel's ElevenLabs voice ID mapped to `priya` — which is the female speaker Sarvam themselves recommend for Tamil, not an arbitrary pick.

```bash
npm run build && npm start     # production
docker compose up --build      # or containerised
```

---

## Supported surface

**ElevenLabs**
```
POST /v1/text-to-speech/:voice_id          → raw audio bytes
POST /v1/text-to-speech/:voice_id/stream   → progressive audio
GET  /v1/voices                            → ElevenLabs-shaped catalogue of Sarvam speakers
GET  /v1/voices/:voice_id
GET  /v1/models
```

**OpenAI Audio**
```
POST /v1/audio/speech           → raw audio bytes
POST /v1/audio/transcriptions   → { text } | text | srt | vtt | verbose_json
POST /v1/audio/translations     → Sarvam's translate mode
```

**Deepgram**
```
POST /v1/listen   → results.channels[0].alternatives[0].transcript
```

**Operations**
```
GET  /healthz  /readyz  /metrics
POST /v1/bridge/explain    → dry-run translation, costs nothing
```

Chat completions are deliberately absent: Sarvam already exposes an OpenAI-compatible `/chat/completions`, so proxying it would add a hop and buy nothing.

---

## The parts that are more than plumbing

**Script-aware language detection.** `language_code` is required by Sarvam and never sent by ElevenLabs, OpenAI or Deepgram clients. The bridge counts codepoints per Unicode block and resolves the dominant Indic script, so a mostly-Tamil string with one stray Devanagari character still resolves to Tamil. Code-mixed input is flagged. Odia is mapped to Sarvam's non-standard `od-IN`, which ISO-639 calls `or` — a migrating client sending `or` would otherwise get a 400.

**Voice selection using published quality data.** Sarvam scores speakers by Critical Error Rate and names the best per language. That guidance is encoded: `mani` for Punjabi male, `ratan` for English, `priya`/`ishita` for female across most languages. `varun` is excluded from automatic selection despite an excellent CER, because Sarvam flags it as a dramatic villain voice unsuitable as a neutral default. Speaker sets are also **not interchangeable between `bulbul:v2` and `bulbul:v3`** — the bridge validates and remaps across generations while preserving gender.

**Grapheme-safe Indic chunking.** Splitting a string by code unit can separate a consonant from its matra, producing visible garbage and audibly wrong speech. Hard splits go through `Intl.Segmenter` at grapheme granularity. Sentence splitting understands the danda (`।`) and double danda (`॥`), not just `.`.

**Correct audio re-assembly.** Chunked input means one WAV back per chunk. `Buffer.concat` on whole WAV files leaves 44-byte headers embedded mid-stream, which decoders render as clicks. The bridge parses each RIFF container, extracts the PCM, and emits one correct header. Frame-based codecs pass through untouched.

---

## Cost, security and scale

**Cost.** IVR menus, collection scripts and tutor prompts synthesise the *same strings* thousands of times a day, each one billable and each one returning byte-identical audio. A bounded LRU cache with a byte budget removes that spend entirely. Cache keys are built from the *resolved* upstream parameters, so two callers arriving in different vendor dialects that normalise to the same Sarvam call share one entry.

The cache alone only handles *sequential* duplicates. A burst — a broadcast goes out and 300 callers hit the same menu prompt within one second — all miss the cache before any of them populates it. Single-flight coalescing collapses those into **one** upstream call whose result every waiter shares. Measured: 100 simultaneous identical requests, cache disabled, produce exactly 1 upstream call. The same mechanism deduplicates repeated chunks *within* a single long request. Hit ratio and coalescing counts are exported to Prometheus.

**Security.** The Sarvam key lives only in the gateway's environment. Client applications and devices never hold it, and rotating it requires no downstream redeploy. Inbound credentials are used for rate-limit bucketing and optional gateway auth, are compared in constant time, are hashed before they touch a log line, and are **never forwarded upstream** (there is a test asserting exactly this). Runs unprivileged in a read-only container with `no-new-privileges`.

`X-Forwarded-*` headers are **not** trusted by default. `req.ip` is a rate-limit bucketing key, so trusting forwarded headers from arbitrary callers would let one forge a fresh identity per request and bypass the limiter entirely. Set `TRUST_PROXY` to an explicit list of your proxy addresses when you deploy behind a load balancer. Dependencies are audited clean (`npm audit --omit=dev` → 0 vulnerabilities).

**Scale.** The process is stateless, so scaling is more replicas. Upstream calls are bounded by a semaphore so a traffic spike cannot stampede Sarvam into rate-limiting you. Retries use full jitter rather than fixed backoff, because synchronised retries from many workers are what turn a brief 429 into an outage. Liveness and readiness are separate endpoints: conflating them means a bad minute at Sarvam causes your orchestrator to start killing healthy pods.

---

## Honest limitations

- **No word-level timestamps.** Sarvam's synchronous REST endpoint returns a transcript without timings, so `srt`/`vtt`/`verbose_json` emit a single cue spanning the clip. Fabricated segment boundaries would look right and be wrong. Applications needing real segmentation should use Sarvam's Batch API, which supports diarisation.
- **No confidence scores.** Deepgram responses report `1.0` rather than an invented value.
- **Streaming is chunk-progressive, not token-progressive.** It uses Sarvam's synchronous endpoint per chunk and writes each as it lands. Sarvam's native WebSocket TTS would give lower time-to-first-audio; that's the natural next step.
- **No URL ingestion** on `/v1/listen`. Send bytes.
- **`stability`, `similarity_boost`, `style`, `use_speaker_boost` and `instructions` have no Sarvam equivalent** and are reported via `x-sarvam-bridge-warnings` rather than silently dropped. Set `STRICT_COMPAT=true` to make them hard errors in CI.
- The built-in ElevenLabs voice-ID map covers well-known stock voices only. Voice IDs are opaque and account-specific — use `VOICE_MAP` for anything real.

---

## Testing

```bash
npm run typecheck   # strict TS, noUncheckedIndexedAccess
npm test            # 168 tests, ~14s
npm run build
node scripts/smoke.mjs http://localhost:8080
```

Everything runs against a stubbed upstream, so no network or API key is needed.

| Suite | What it covers |
|---|---|
| `routes` | Vendor dialect fidelity — bytes not JSON, error shapes, credential isolation |
| `adversarial` | Header injection, malformed bodies, hostile text, upstream misbehaviour |
| `property` | ~12,000 generated inputs asserting invariants over chunking, language, voice, audio |
| `stress` | Concurrency ceilings, semaphore leak detection, memory bounds under churn |
| `matrix` | Every language, codec, sample rate, model and voice combination |
| `chunk`/`audio`/`cache`/`ratelimit`/`config`/`voices`/`languages` | Unit level |

**Bugs this suite caught and fixed**, all of which would have reached production:

- A voice id containing non-ASCII (Devanagari, emoji) crashed the process on header write — a remote crash triggered by ordinary input in the languages this gateway exists to serve.
- Framework errors (oversized body, malformed JSON, unsupported media type) were collapsed to 500 instead of 413/400/415, which would have paged an on-call engineer for client errors.
- A long run of orphan combining marks parses as a *single* grapheme cluster, so the chunker emitted it whole and blew past Sarvam's character ceiling — a guaranteed 422.
- Sentence splitting broke a grapheme cluster when a danda was followed by a combining mark.

**Load results** (compiled build, real HTTP, concurrency 100):

- 2,000 requests: 100% success, p50 150ms, p99 518ms
- 1,500 adversarial and malformed requests: **zero 5xx** — every rejection a clean 400/404
- Sustained 2,800 requests: RSS plateaus at ~118MB, flat across rounds

---

## Configuration

Every option is environment-driven and validated at boot — a misconfigured deployment fails immediately rather than at the first user request. See `.env.example`. The ones that matter most:

| Variable | Default | Why you'd change it |
|---|---|---|
| `SARVAM_API_KEY` | *(required)* | The only secret |
| `GATEWAY_AUTH_TOKEN` | *(empty)* | Require a client credential; rotate independently of the Sarvam key |
| `CACHE_MAX_BYTES` | 256 MB | Resident-set ceiling for cached audio |
| `UPSTREAM_CONCURRENCY` | 8 | Parallel calls to Sarvam |
| `VOICE_MAP` | *(empty)* | Explicit `{"vendor_id":"sarvam_speaker"}` mapping |
| `TRUST_PROXY` | *(off)* | Set to your proxy IPs/CIDRs when behind a load balancer |
| `STRICT_COMPAT` | false | Fail on unmappable params instead of warning |

---

## Licence

MIT.

Not affiliated with or endorsed by Sarvam AI, ElevenLabs, OpenAI or Deepgram. API shapes were implemented against public documentation as of August 2026.
