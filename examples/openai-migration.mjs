/**
 * OpenAI Audio -> Sarvam, with zero application changes.
 *
 *   const openai = new OpenAI({ baseURL: "http://localhost:8080/v1" });
 *
 * That one line is the migration. Both TTS and Whisper transcription then run
 * on Sarvam while your code keeps its existing shapes.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";

const BRIDGE = process.env.BRIDGE_URL ?? "http://localhost:8080";

// ── Text to speech: returns bytes, same as OpenAI ─────────────────────────
const speech = await fetch(`${BRIDGE}/v1/audio/speech`, {
  method: "POST",
  headers: { authorization: "Bearer unused", "content-type": "application/json" },
  body: JSON.stringify({
    model: "tts-1",
    input: "வணக்கம்! இது Sarvam மூலம் இயங்குகிறது.",
    voice: "onyx",
    response_format: "wav",
  }),
});

const audio = Buffer.from(await speech.arrayBuffer());
writeFileSync("speech.wav", audio);
console.log("TTS  ->", audio.length, "bytes, speaker:",
  speech.headers.get("x-sarvam-bridge-speaker"));

// ── Transcription: returns { text }, same as Whisper ──────────────────────
if (existsSync("speech.wav")) {
  const form = new FormData();
  form.append("file", new Blob([readFileSync("speech.wav")], { type: "audio/wav" }), "speech.wav");
  form.append("model", "whisper-1");

  const stt = await fetch(`${BRIDGE}/v1/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: "Bearer unused" },
    body: form,
  });

  console.log("STT  ->", await stt.json());
}
