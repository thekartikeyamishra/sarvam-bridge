#!/usr/bin/env bash
# Quick tour of the bridge with curl. Assumes it is running on :8080.
set -euo pipefail
BRIDGE="${BRIDGE_URL:-http://localhost:8080}"

echo "── What would this request become? (free, no upstream call) ──"
curl -s -X POST "$BRIDGE/v1/bridge/explain" \
  -H 'content-type: application/json' \
  -d '{"text":"ਸਤ ਸ੍ਰੀ ਅਕਾਲ, ਤੁਸੀਂ ਕਿਵੇਂ ਹੋ?","voice":"21m00Tcm4TlvDq8ikWAM"}' | jq .

echo "── ElevenLabs-shaped TTS (writes hello.wav) ──"
curl -s -X POST "$BRIDGE/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM" \
  -H 'xi-api-key: unused' -H 'content-type: application/json' \
  -d '{"text":"नमस्ते दुनिया"}' -D headers.txt -o hello.wav
grep -i 'x-sarvam-bridge' headers.txt || true
file hello.wav || ls -la hello.wav

echo "── OpenAI-shaped transcription ──"
curl -s -X POST "$BRIDGE/v1/audio/transcriptions" \
  -F file=@hello.wav -F model=whisper-1 | jq .

echo "── Deepgram-shaped transcription ──"
curl -s -X POST "$BRIDGE/v1/listen" \
  -H 'content-type: audio/wav' --data-binary @hello.wav | jq '.results.channels[0].alternatives[0].transcript'

echo "── Metrics ──"
curl -s "$BRIDGE/metrics" | grep -E 'cache|requests_total' | head
