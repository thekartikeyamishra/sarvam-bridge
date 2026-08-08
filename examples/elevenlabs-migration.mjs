/**
 * ElevenLabs -> Sarvam, with zero application changes.
 *
 * The only edit to a real codebase is the baseURL. Everything else — the SDK,
 * the method call, the response handling — is untouched. Note especially that
 * `fs.writeFileSync(audio)` still works, because the bridge returns raw audio
 * bytes rather than Sarvam's base64 JSON.
 *
 *   npm i elevenlabs
 *   node examples/elevenlabs-migration.mjs
 */
import { writeFileSync } from "node:fs";

const BRIDGE = process.env.BRIDGE_URL ?? "http://localhost:8080";

// ── Before ────────────────────────────────────────────────────────────────
// const client = new ElevenLabs({ apiKey: process.env.ELEVENLABS_API_KEY });
//
// ── After ─────────────────────────────────────────────────────────────────
// const client = new ElevenLabs({
//   apiKey: "unused",
//   environment: BRIDGE,        // <- the entire migration
// });

// Shown here with plain fetch so the example runs without installing an SDK.
const response = await fetch(`${BRIDGE}/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM`, {
  method: "POST",
  headers: {
    "xi-api-key": "any-value-the-bridge-holds-the-real-key",
    "content-type": "application/json",
  },
  body: JSON.stringify({
    text: "नमस्ते! आपका स्वागत है। यह Sarvam पर चल रहा है।",
    model_id: "eleven_multilingual_v2",
    voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.0 },
  }),
});

if (!response.ok) {
  console.error("Failed:", response.status, await response.text());
  process.exit(1);
}

// Raw bytes, exactly as ElevenLabs returns them. No base64 decode step.
const audio = Buffer.from(await response.arrayBuffer());
writeFileSync("output.wav", audio);

console.log("Wrote output.wav —", audio.length, "bytes");
console.log("Speaker chosen :", response.headers.get("x-sarvam-bridge-speaker"));
console.log("Language        :", response.headers.get("x-sarvam-bridge-language"));
console.log("Warnings        :", response.headers.get("x-sarvam-bridge-warnings") ?? "none");
