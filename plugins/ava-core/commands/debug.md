---
description: Analyze an error message and suggest fixes
arguments:
  error:
    description: The error message or stack trace
    required: true
  context:
    description: Additional context (language, framework, what you were doing)
    required: false
---

# Debug

Analyze the following error and help me fix it.

Error:
```
{{error}}
```

{{context}}

Structure your response as:

1. **What happened**: Plain-language explanation of the error.
2. **Root cause**: The most likely reason this error occurred.
3. **Fix**: Step-by-step instructions to resolve it, with code if applicable.
4. **Prevention**: How to avoid this error in the future.
