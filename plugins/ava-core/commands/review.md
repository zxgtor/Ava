---
description: Review code for bugs, style, and improvements
arguments:
  code:
    description: The code to review
    required: true
  focus:
    description: "Review focus: bugs, performance, style, security, or all"
    required: false
    default: all
---

# Code Review

Review the following code with focus on: **{{focus}}**.

Structure your review as:

1. **Summary**: One-sentence assessment of the code quality.
2. **Issues**: List each problem with severity (🔴 critical / 🟡 warning / 🔵 suggestion).
3. **Improvements**: Concrete suggestions with example code where helpful.
4. **Good Practices**: Note anything done well (keep reviews balanced).

```
{{code}}
```
