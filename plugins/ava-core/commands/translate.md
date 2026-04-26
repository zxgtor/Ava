---
description: Translate between Chinese and English
arguments:
  content:
    description: The text to translate
    required: true
  target_lang:
    description: "Target language: English, Chinese, or auto (detect and flip)"
    required: false
    default: auto
---

# Translate

Translate the following text.

Target language: **{{target_lang}}**

- If target is "auto": detect the source language and translate to the other (Chinese ↔ English).
- Preserve the original formatting (bullet points, code blocks, headings).
- Keep technical terms natural in the target language; add the original term in parentheses if it aids clarity.

Text:

{{content}}
