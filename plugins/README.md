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
`ava-speech/` groups voice input and spoken replies as one bundled Speech plugin
with separate `speech.stt` and `speech.tts` capabilities.

## Add-on catalog sources

Custom Add-ons sources are JSON URLs with this shape:

```json
{
  "items": [
    {
      "type": "plugin",
      "name": "Example Plugin",
      "description": "What this add-on provides.",
      "author": "Example",
      "category": "coding",
      "repoUrl": "https://github.com/example/ava-plugin.git"
    }
  ]
}
```

Supported item types are `plugin`, `skill`, and `mcp`. `installUrl` may be used
instead of `repoUrl`; currently installable items must point to a Git repository.
