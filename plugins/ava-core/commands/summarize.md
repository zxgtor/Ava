---
description: Extract key points from text
arguments:
  content:
    description: The text to summarize
    required: true
  style:
    description: "Output style: bullet, paragraph, or tldr"
    required: false
    default: bullet
---

# Summarize

Summarize the following content using the "{{style}}" style:

- **bullet**: A concise bullet-point list of key takeaways.
- **paragraph**: A brief paragraph capturing the essence.
- **tldr**: A single sentence TL;DR.

Content:

{{content}}
