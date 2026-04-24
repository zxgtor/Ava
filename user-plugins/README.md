# user-plugins/

Runtime plugin install directory.

Contents are **gitignored** — only this README and `.gitkeep` are tracked. Ava's
plugin manager (P3+) will drop installed plugins here, one folder per plugin.

Expected layout for each installed plugin:

```
user-plugins/<plugin-id>/
  .claude-plugin/plugin.json
  .mcp.json
  skills/…
  commands/…
```

> ⚠️ This location is inside the project tree (`D:\Apps\Ava\user-plugins\`).
> If Ava is ever packaged for distribution, this should move to `%APPDATA%\Ava\plugins\`.
