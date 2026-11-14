> ⚠️ **Disclaimer:** This is purely vibecoded (made almost entirely with AI). I made this for personal use to sync my own Obsidian notes. While I tried to eliminate potential problems and unhandled edge cases, I can make no guarantees on the reliability of the plugin or the safety of your data. This repo is only public so I can make use of GitHub releases.

# HF Sync

Sync your Obsidian vault with a git remote (pull, commit, push) with a single click.

## Features and functionality

- **One-click sync** — a ribbon icon, a command, and a "Sync now" button in settings all trigger the same full sync: commit any local changes, pull/rebase the latest changes from the remote, then push.
  - Commits happen *before* pulling, so your edits are always safely recorded locally before the working tree is touched by a pull/rebase.
- **Granular commands**, available from the command palette:
  - `Sync vault (pull, commit, push)` — full sync.
  - `Pull changes from remote` — pull/rebase only.
  - `Commit and push changes` — commit and push only.
- **Status bar indicator** (optional) showing the current state: `Idle`, `Pulling...`, `Committing...`, `Pushing...`, or `Error`. Refreshes automatically after file saves and after every sync.
- **Pull on startup** (optional) — automatically pulls the latest remote changes when Obsidian launches.
- **Safe by design**:
  - Refuses to sync if the vault has an unresolved git conflict (in-progress rebase/merge, or unmerged files) left over from a previous operation — never commits conflict-marker text as if it were real note content.
  - A single operation lock prevents overlapping git invocations from racing each other.
  - Automatically rolls back to the last known-good commit if a commit step fails.
  - If a pull/rebase fails, attempts to cleanly abort and restore your previous state, and tells you honestly if that wasn't possible.
  - If a push fails (e.g. no network), your commit is still safe locally and will be retried on the next sync — it does not undo your commit.
  - Skips empty commits and unnecessary pushes when there's nothing to sync ("already up to date").
  - Git runs with a timeout and with interactive credential prompts disabled, so a misconfigured remote can't hang or silently wait for input.
- **Settings**:
  - **Git executable path** — point at a specific `git` binary if it's not on your system `PATH`.
  - **Pull on startup** — toggle automatic pull when Obsidian opens.
  - **Show status bar item** — toggle the status bar indicator.
  - **Check for updates** — downloads the latest published release's pre-built files from GitHub and installs them, then attempts to reload the plugin automatically (see [Releasing](#releasing) below for how updates get published). If the automatic reload doesn't fully take effect (rare, but possible depending on your Obsidian version), a manual restart of Obsidian will finish applying the update.
- Desktop-only plugin (relies on the local git CLI and filesystem access).

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) (v20+ recommended) and npm.
- `git` installed and available on your `PATH` (or configurable via the plugin's "Git executable path" setting).

### Setup

```bash
npm install
```

### Build

```bash
npm run dev     # builds in watch mode, with inline sourcemaps
npm run build   # type-checks (tsc -noEmit) and produces a production build
```

Both commands bundle `main.ts` into `dist/hf-sync/main.js` and copy `manifest.json` (and `styles.css`, if present) alongside it. The contents of `dist/hf-sync/` are exactly what gets copied into `<vault>/.obsidian/plugins/hf-sync/`.

### Installing a dev build into a vault

Copy (or symlink) the `dist/hf-sync/` folder into your vault's `.obsidian/plugins/` directory:

```bash
cp -r dist/hf-sync /path/to/your/vault/.obsidian/plugins/
```

Then enable "HF Sync" in Obsidian's Community Plugins settings, and reload/toggle it after each rebuild to pick up changes.

## Releasing

Releases are automated via [`.github/workflows/release.yml`](.github/workflows/release.yml): pushing a tag like `v1.0.1` builds the plugin and publishes `main.js`/`manifest.json`/`styles.css` as downloadable assets on a GitHub Release. That release is what the in-app "Check for updates" button downloads from.

To cut a release, run one of:

```bash
npm run release:patch   # 1.0.0 -> 1.0.1 (bug fixes)
npm run release:minor   # 1.0.0 -> 1.1.0 (new features)
npm run release:major   # 1.0.0 -> 2.0.0 (breaking changes)
```

These follow [semantic versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`):

- **Patch** (`1.0.0` → `1.0.1`) — bug fixes and small internal changes only. Nothing about how you use the plugin changes.
- **Minor** (`1.0.0` → `1.1.0`) — new features or settings added, but existing functionality still works the same way. Backwards-compatible.
- **Major** (`1.0.0` → `2.0.0`) — breaking changes: something existing users rely on changes or is removed (e.g. a setting is renamed/removed, or behavior changes in a way that could surprise someone upgrading).

Each of these commands ([`scripts/release.mjs`](scripts/release.mjs)):

1. Aborts if the working tree has uncommitted changes.
2. Bumps `package.json`/`package-lock.json` using npm's semver logic.
3. Syncs the new version into `manifest.json` and `versions.json`.
4. Commits the change as `Release vX.Y.Z`.
5. Creates tag `vX.Y.Z` and pushes the commit and tag to `origin`.
6. The pushed tag triggers the GitHub Actions workflow, which builds and publishes the release automatically.

**One-time setup required for releases to work:** in the GitHub repo, go to **Settings → Actions → General → Workflow permissions** and select **"Read and write permissions"**, so the release workflow is allowed to publish releases using the repo's built-in token.
