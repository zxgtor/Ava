# Marketplace Redesign Design

## Goal

Rename the settings entry from `Plugin Marketplace` to `Marketplace` and make it a discovery page for both installable plugins and installable skills.

The page should combine items from:

- Claude Code official marketplace: `anthropics/claude-plugins-official/.claude-plugin/marketplace.json`.
- Codex marketplace: `codex-marketplace.com`, accepted as a non-OpenAI community data source.
- Ava local catalog: installed plugins and skills discovered by Ava.

## Information Architecture

The page has two main tabs:

- `Plugin Marketplace`: plugin packages that can contain skills, MCP servers, commands, hooks, or app integrations.
- `Skill Market`: individual skills, including skills expanded from plugin catalogs and standalone skill listings when available.

Each tab supports category grouping, installed state, search, and source filters.

## Marketplace Item Model

Normalize all remote and local data into one view model:

- `id`: stable dedupe key.
- `type`: `plugin` or `skill`.
- `name`, `description`, `author`.
- `category`.
- `source`: `claude`, `codex`, or `ava`.
- `sourceUrl` / `repoUrl`.
- `installUrl`.
- `thumbnailUrl` if provided.
- `thumbnailFallback`: deterministic visual style generated from name/category/source.
- `installedPluginId` when matched to a local plugin.

## Deduplication

Deduplicate by priority:

1. Same normalized repo URL plus subpath.
2. Same normalized item type plus normalized name plus source URL host/path.
3. Same type plus normalized name only, but keep variants if descriptions or install URLs differ.

When duplicates merge, show source badges such as `Claude`, `Codex`, `Ava`.

## UI Behavior

Use the Marketplace Cards direction:

- Top title: `Marketplace`.
- Search input and source/category filters.
- Primary tab row: `Plugin Marketplace`, `Skill Market`.
- Category sections with horizontal card grids.
- Each card shows thumbnail, name, author, source badges, category chips, short description, and action button.
- Action states: `Install`, `Installed`, `Update`, `Unavailable`, `Loading`.

## Data Loading

Backend owns remote catalog loading so the renderer does not directly scrape remote pages.

Initial implementation:

- Add marketplace service functions in the Electron main process.
- Fetch Claude marketplace JSON from GitHub raw URL.
- Fetch Codex marketplace data from available public endpoint or scrape fallback if no JSON endpoint exists.
- Cache successful catalog results locally with a timestamp.
- If remote fetch fails, show cached data and a warning; if no cache exists, show a clear error.

## Install Behavior

Plugin install:

- Use existing `installGit(repoUrl)` path when the marketplace item maps to a Git repo.
- For Claude marketplace relative sources, resolve against the marketplace repo.
- If source cannot be installed directly, show `Unavailable` with an explanation.

Skill install:

- If standalone skill source is a Git path, install/copy into Ava user skills location once supported.
- If skill belongs to a plugin, show `Install plugin` and install the parent plugin.
- If Ava does not yet support standalone skill install, expose UI state but route to plugin install when possible.

## Testing

- Typecheck and build.
- Marketplace service unit/smoke script for catalog normalization and dedupe.
- UI smoke: page renders with mocked plugin and skill items.
- Manual: verify installed state by installing one marketplace plugin and seeing card state update.

## Open Decisions

- Codex marketplace exact machine-readable endpoint must be discovered during implementation. If unavailable, use a conservative scraper or initial static parser with clear error handling.
- Standalone skill installation may require a new Ava skill install path. If too large, first version should list skills and install parent plugins only.
