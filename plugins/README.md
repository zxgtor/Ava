# plugins/

First-party plugins shipped **inside** the Ava repo.

These are committed to git. Contrast with `user-plugins/` at the repo root, which is
for plugins the user installs at runtime (that folder is gitignored).

Each plugin here follows the Cowork-compatible layout:

```
plugins/<name>/
  .claude-plugin/plugin.json
  .mcp.json              (optional)
  skills/<skill>/SKILL.md (optional)
  commands/<cmd>.md       (optional)
```

`ava-core/` is reserved for the default built-in plugin (populated in P3/P6).
