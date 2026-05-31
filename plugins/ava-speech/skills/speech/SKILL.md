---
name: speech
description: Use when the user asks about Ava voice input, speech-to-text, text-to-speech, spoken replies, microphone behavior, or local speech services.
---

# Ava Speech

Ava Speech is one plugin with two separate capabilities:

- `speech.stt`: speech-to-text for microphone input and transcription.
- `speech.tts`: text-to-speech for assistant reply playback and auto-read.

Treat STT and TTS as separate capabilities even though they are packaged as one plugin. This keeps provider/runtime swaps simple: users can replace only the STT or only the TTS backend without changing Ava's UI contract.

Current v1 behavior:

- Desktop UI uses this plugin's enabled state as the feature gate for voice controls.
- The existing `settings.voice` values remain the compatibility storage for local STT/TTS server URLs, voice id, and auto-read.
- Future work should move speech endpoint config and runtime calls into daemon-owned speech APIs.

When explaining or troubleshooting speech:

1. Check whether the Ava Speech plugin is enabled.
2. Check STT and TTS endpoints separately.
3. Explain that microphone input and spoken replies can fail independently.
