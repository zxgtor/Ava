---
description: Rewrite text with a specific tone
arguments:
  content:
    description: The text to rewrite
    required: true
  tone:
    description: "Desired tone: professional, casual, concise, formal, or friendly"
    required: false
    default: professional
---

# Rewrite

Rewrite the following text with a **{{tone}}** tone.

Rules:
- Preserve the original meaning completely.
- Fix grammar and spelling errors.
- Improve clarity and flow.
- Keep the same language as the original text.

Text:

{{content}}
