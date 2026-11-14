import { App, FileSystemAdapter, Notice, Plugin, PluginSettingTab, requestUrl, Setting } from "obsidian";
import { execFile } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const GITHUB_REPO = "bcbays/ObsidianHFSync";
const GITHUB_API_LATEST_RELEASE = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const UPDATE_ASSET_NAMES = ["main.js", "manifest.json", "styles.css"] as const;

interface LatestRelease {
	version: string;
	assets: Partial<Record<(typeof UPDATE_ASSET_NAMES)[number], string>>;
}

interface HFSyncSettings {
	gitPath: string;
	pullOnStartup: boolean;
	showStatusBarItem: boolean;
}

const DEFAULT_SETTINGS: HFSyncSettings = {
	gitPath: "git",
	pullOnStartup: false,
	showStatusBarItem: true,
};

export default class HFSyncPlugin extends Plugin {
	settings!: HFSyncSettings;
	statusBarItem: HTMLElement | null = null;
	/** True while a pull, commit/push, or full sync is running; guards against overlapping git invocations. */
	private busy = false;
	private refreshingStatus = false;
	private statusRefreshTimer: number | null = null;
	/** True while a self-update check/download is in progress; guards against overlapping update attempts. */
	private updating = false;
	/** Set once "Check for updates" finds a newer release; cleared once that update is applied (or a fresh check is run). */
	pendingUpdate: LatestRelease | null = null;

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new HFSyncSettingTab(this.app, this));

		if (this.settings.showStatusBarItem) {
			this.statusBarItem = this.addStatusBarItem();
			this.setStatus("Idle");
		}

		this.addRibbonIcon("refresh-cw", "HF Sync: sync vault", () => {
			void this.sync();
		});

		this.addCommand({
			id: "hf-sync-sync",
			name: "Sync vault (pull, commit, push)",
			callback: () => void this.sync(),
		});

		this.addCommand({
			id: "hf-sync-pull",
			name: "Pull changes from remote",
			callback: () => void this.pull(false),
		});

		this.addCommand({
			id: "hf-sync-commit-push",
			name: "Commit and push changes",
			callback: () => void this.commitAndPush(false),
		});

		this.registerEvent(
			this.app.vault.on("modify", () => {
				this.scheduleStatusRefresh();
			})
		);

		this.app.workspace.onLayoutReady(() => {
			if (this.settings.pullOnStartup) {
				void this.pull(true);
			} else {
				void this.refreshSyncStatus();
			}
		});
	}

	onunload() {
		if (this.statusRefreshTimer !== null) {
			window.clearTimeout(this.statusRefreshTimer);
			this.statusRefreshTimer = null;
		}
	}

	async loadSettings() {
		const loaded = ((await this.loadData()) ?? {}) as Partial<HFSyncSettings>;
		this.settings = {
			gitPath: typeof loaded.gitPath === "string" && loaded.gitPath.trim().length > 0 ? loaded.gitPath : DEFAULT_SETTINGS.gitPath,
			pullOnStartup: typeof loaded.pullOnStartup === "boolean" ? loaded.pullOnStartup : DEFAULT_SETTINGS.pullOnStartup,
			showStatusBarItem:
				typeof loaded.showStatusBarItem === "boolean" ? loaded.showStatusBarItem : DEFAULT_SETTINGS.showStatusBarItem,
		};
		// Persist the sanitized settings immediately so any unknown/stale keys left over from an older
		// version are pruned from disk right away, instead of lingering until the next user-triggered save.
		if (JSON.stringify(loaded) !== JSON.stringify(this.settings)) {
			await this.saveSettings();
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	refreshStatusBarVisibility() {
		if (this.settings.showStatusBarItem && !this.statusBarItem) {
			this.statusBarItem = this.addStatusBarItem();
			this.setStatus("Idle");
		} else if (!this.settings.showStatusBarItem && this.statusBarItem) {
			this.statusBarItem.remove();
			this.statusBarItem = null;
		}
	}

	private setStatus(text: string) {
		this.statusBarItem?.setText(`HF Sync: ${text}`);
	}

	/** Debounces status refreshes triggered by file saves so we don't fetch on every keystroke-driven autosave. */
	private scheduleStatusRefresh(delayMs = 15000): void {
		if (this.statusRefreshTimer !== null) {
			window.clearTimeout(this.statusRefreshTimer);
		}
		this.statusRefreshTimer = window.setTimeout(() => {
			this.statusRefreshTimer = null;
			void this.refreshSyncStatus();
		}, delayMs);
	}

	/** Read-only check (git fetch + rev-list/status) that updates the status bar with pull/push/synced state. */
	async refreshSyncStatus(): Promise<void> {
		if (!this.statusBarItem || this.busy || this.refreshingStatus) return;
		let basePath: string;
		try {
			basePath = this.getVaultBasePath();
		} catch {
			return;
		}
		if (!this.isGitRepo(basePath)) return;

		this.refreshingStatus = true;
		try {
			try {
				await this.runGit(["fetch"], basePath);
			} catch {
				return; // offline or fetch failed; keep showing the last known status
			}

			const { behind, ahead } = await this.getAheadBehindCounts(basePath);

			let dirtyCount = 0;
			try {
				const status = await this.runGit(["status", "--porcelain"], basePath);
				dirtyCount = status.length > 0 ? status.split("\n").filter((line) => line.trim().length > 0).length : 0;
			} catch {
				// ignore
			}

			this.renderSyncStatus(behind, ahead + dirtyCount);
		} finally {
			this.refreshingStatus = false;
		}
	}

	private renderSyncStatus(behind: number, pushCount: number): void {
		if (!this.statusBarItem) return;
		if (behind > 0 && pushCount > 0) {
			this.statusBarItem.setText(`HF Sync: \u2195 ${behind}\u2193 ${pushCount}\u2191`);
		} else if (behind > 0) {
			this.statusBarItem.setText(`HF Sync: \u2193 ${behind} to pull`);
		} else if (pushCount > 0) {
			this.statusBarItem.setText(`HF Sync: \u2191 ${pushCount} to push`);
		} else {
			this.statusBarItem.setText("HF Sync: \u2713 Synced");
		}
	}

	private getVaultBasePath(): string {
		const adapter = this.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) {
			return adapter.getBasePath();
		}
		throw new Error("HF Sync only works on the desktop app.");
	}

	private isGitRepo(basePath: string): boolean {
		return existsSync(join(basePath, ".git"));
	}

	private async runGit(args: string[], cwd: string): Promise<string> {
		try {
			const { stdout } = await execFileAsync(this.settings.gitPath, args, {
				cwd,
				maxBuffer: 10 * 1024 * 1024,
				timeout: GIT_TIMEOUT_MS,
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			});
			return stdout.trim();
		} catch (err: unknown) {
			const message = this.extractErrorMessage(err);
			throw new Error(message);
		}
	}

	private extractErrorMessage(err: unknown): string {
		if (err && typeof err === "object") {
			const e = err as { stderr?: unknown; message?: unknown; killed?: unknown };
			if (e.killed) {
				return "git command timed out";
			}
			if (typeof e.stderr === "string" && e.stderr.trim().length > 0) {
				return e.stderr.trim();
			}
			if (typeof e.message === "string") {
				return e.message;
			}
		}
		return "Unknown git error";
	}

	/** Returns commit counts relative to the upstream branch. `hasUpstream` is false if no upstream is configured. */
	private async getAheadBehindCounts(basePath: string): Promise<{ behind: number; ahead: number; hasUpstream: boolean }> {
		try {
			const counts = await this.runGit(["rev-list", "--left-right", "--count", "@{u}...HEAD"], basePath);
			const [behindStr, aheadStr] = counts.split(/\s+/);
			return {
				behind: parseInt(behindStr, 10) || 0,
				ahead: parseInt(aheadStr, 10) || 0,
				hasUpstream: true,
			};
		} catch {
			return { behind: 0, ahead: 0, hasUpstream: false };
		}
	}

	/** Classifies a raw git error message into a short, human-readable category. */
	private classifyGitError(message: string): string {
		const lower = message.toLowerCase();
		if (lower.includes("conflict")) return "Merge conflict";
		if (lower.includes("non-fast-forward") || lower.includes("rejected")) return "Push rejected (remote has new changes)";
		if (
			lower.includes("could not resolve host") ||
			lower.includes("could not read from remote") ||
			lower.includes("network is unreachable") ||
			lower.includes("timed out") ||
			lower.includes("timeout")
		)
			return "Network error";
		if (
			lower.includes("permission denied") ||
			lower.includes("authentication failed") ||
			lower.includes("could not read username") ||
			lower.includes("could not read password")
		)
			return "Authentication error";
		if (lower.includes("not a git repository")) return "Not a git repository";
		if (lower.includes("enoent")) return "Git executable not found";
		return "Git error";
	}

	/** Best-effort abort of an in-progress rebase or merge, restoring the pre-pull state (including any autostash). Returns true if something was actually aborted. */
	private async safeAbortRebase(basePath: string): Promise<boolean> {
		try {
			await this.runGit(["rebase", "--abort"], basePath);
			return true;
		} catch {
			// not in a rebase, fall through to check for an in-progress merge
		}
		try {
			await this.runGit(["merge", "--abort"], basePath);
			return true;
		} catch {
			return false;
		}
	}

	/** Best-effort reset back to a known-good commit, undoing any staging/commit made during a failed sync step. */
	private async safeResetTo(headSha: string, basePath: string): Promise<void> {
		if (!headSha) return;
		try {
			await this.runGit(["reset", "--mixed", headSha], basePath);
		} catch {
			// best effort; nothing more we can do automatically
		}
	}

	/**
	 * Detects a git state that must be resolved manually before HF Sync can safely proceed: an in-progress
	 * rebase/merge, or unmerged ("conflicted") paths left behind by a previous operation (e.g. a failed
	 * autostash re-apply after a pull). Committing or rebasing on top of this state risks baking conflict
	 * markers into your notes, so every entry point checks this first and refuses to continue if it's true.
	 */
	private async hasUnresolvedGitState(basePath: string): Promise<boolean> {
		if (existsSync(join(basePath, ".git", "rebase-merge"))) return true;
		if (existsSync(join(basePath, ".git", "rebase-apply"))) return true;
		if (existsSync(join(basePath, ".git", "MERGE_HEAD"))) return true;
		try {
			const status = await this.runGit(["status", "--porcelain"], basePath);
			return status.split("\n").some((line) => /^(UU|AA|DD|AU|UA|UD|DU)\s/.test(line));
		} catch {
			return false;
		}
	}

	/** Resolves the vault path and verifies it's a usable, conflict-free git repo. Shows a Notice and returns null if not. */
	private async preflightCheck(): Promise<string | null> {
		let basePath: string;
		try {
			basePath = this.getVaultBasePath();
		} catch (err) {
			new Notice(`HF Sync: ${(err as Error).message}`);
			return null;
		}
		if (!this.isGitRepo(basePath)) {
			new Notice("HF Sync: this vault is not a git repository.");
			return null;
		}
		if (await this.hasUnresolvedGitState(basePath)) {
			new Notice(
				"HF Sync: this vault has an unresolved git conflict from a previous operation. Open a terminal in your vault and resolve it manually (check 'git status') before syncing again."
			);
			return null;
		}
		return basePath;
	}

	/** Pulls the latest changes from the remote, rebasing local commits on top. Guards against overlapping git operations. */
	async pull(silent: boolean): Promise<void> {
		if (this.busy) {
			new Notice("HF Sync: another operation is already in progress.");
			return;
		}
		this.busy = true;
		try {
			const basePath = await this.preflightCheck();
			if (!basePath) return;
			await this.pullInternal(basePath, silent);
		} finally {
			this.busy = false;
			void this.refreshSyncStatus();
		}
	}

	/** Runs the actual pull/rebase. Caller is responsible for the busy guard and pre-flight checks. */
	private async pullInternal(basePath: string, silent: boolean): Promise<void> {
		this.setStatus("Pulling...");
		try {
			await this.runGit(["pull", "--rebase", "--autostash"], basePath);
			this.setStatus("Idle");
			if (!silent) {
				new Notice("HF Sync: pulled latest changes.");
			}
		} catch (err) {
			const aborted = await this.safeAbortRebase(basePath);
			this.setStatus("Error");
			const message = (err as Error).message;
			const errorType = this.classifyGitError(message);
			if (aborted) {
				new Notice(`HF Sync: pull failed (${errorType}). Sync cancelled, vault restored to its previous state.\n${message}`);
			} else {
				new Notice(
					`HF Sync: pull failed (${errorType}) and could not be automatically reverted. Your edits should still be recoverable \u2014 check 'git status' and 'git stash list' in your vault folder. HF Sync will refuse to sync again until this is resolved manually.\n${message}`
				);
			}
			throw err;
		}
	}

	/** Stages all changes, commits if needed, and pushes to the remote. Guards against overlapping git operations. */
	async commitAndPush(silent: boolean): Promise<boolean> {
		if (this.busy) {
			new Notice("HF Sync: another operation is already in progress.");
			return false;
		}
		this.busy = true;
		try {
			const basePath = await this.preflightCheck();
			if (!basePath) return false;
			const committed = await this.commitInternal(basePath, silent);
			return await this.pushInternal(basePath, committed, silent);
		} finally {
			this.busy = false;
			void this.refreshSyncStatus();
		}
	}

	/**
	 * Stages and commits local changes, if any. Only ever touches git's index/history \u2014 never rewrites the
	 * working-tree file contents \u2014 so this step can't corrupt or delete note content on disk.
	 */
	private async commitInternal(basePath: string, silent: boolean): Promise<boolean> {
		this.setStatus("Committing...");
		let preCommitHead = "";
		try {
			preCommitHead = await this.runGit(["rev-parse", "HEAD"], basePath);
		} catch {
			// repo has no commits yet; nothing to roll back to
		}
		try {
			await this.runGit(["add", "-A"], basePath);
			const status = await this.runGit(["status", "--porcelain"], basePath);
			if (status.length === 0) {
				return false;
			}
			const message = `Vault sync: ${new Date().toISOString()}`;
			await this.runGit(["commit", "-m", message], basePath);
			return true;
		} catch (err) {
			await this.safeResetTo(preCommitHead, basePath);
			this.setStatus("Error");
			const message = (err as Error).message;
			const errorType = this.classifyGitError(message);
			new Notice(`HF Sync: commit failed (${errorType}). Sync cancelled, vault restored to its previous state.\n${message}`);
			throw err;
		}
	}

	/** Pushes to the remote if there's a reason to (a fresh commit, or pre-existing unpushed commits). */
	private async pushInternal(basePath: string, alreadyCommitted: boolean, silent: boolean): Promise<boolean> {
		let needsPush = alreadyCommitted;
		if (!needsPush) {
			const { ahead, hasUpstream } = await this.getAheadBehindCounts(basePath);
			needsPush = hasUpstream ? ahead > 0 : true; // unknown upstream state; attempt push to be safe
		}

		if (!needsPush) {
			this.setStatus("Idle");
			if (!silent) {
				new Notice("HF Sync: already up to date, nothing to sync.");
			}
			return false;
		}

		this.setStatus("Pushing...");
		try {
			await this.runGit(["push"], basePath);
		} catch (err) {
			this.setStatus("Error");
			const message = (err as Error).message;
			const errorType = this.classifyGitError(message);
			new Notice(
				`HF Sync: push failed (${errorType}). Your changes are committed locally and safe, but not yet on the remote \u2014 HF Sync will retry on the next sync.\n${message}`
			);
			throw err;
		}

		this.setStatus("Idle");
		if (!silent) {
			new Notice("HF Sync: changes committed and pushed.");
		}
		return true;
	}

	/**
	 * Full sync: commits local changes first (so they're safely recorded before touching the working tree),
	 * then pulls/rebases on top of the remote, then pushes. Committing before pulling means a pull conflict
	 * is always a normal, cleanly-abortable mid-rebase conflict \u2014 never a post-rebase stash conflict that
	 * could leave conflict markers sitting inside your notes.
	 */
	async sync(): Promise<void> {
		if (this.busy) {
			new Notice("HF Sync: another operation is already in progress.");
			return;
		}
		this.busy = true;
		try {
			const basePath = await this.preflightCheck();
			if (!basePath) return;
			const committed = await this.commitInternal(basePath, true);
			await this.pullInternal(basePath, true);
			const pushed = await this.pushInternal(basePath, committed, true);
			this.setStatus("Idle");
			new Notice(pushed ? "HF Sync: vault synced." : "HF Sync: already up to date, nothing to sync.");
		} catch (err) {
			// errors already surfaced via Notice in commitInternal()/pullInternal()/pushInternal()
			console.error("HF Sync error", err);
		} finally {
			this.busy = false;
			void this.refreshSyncStatus();
		}
	}

	/**
	 * Checks GitHub for a newer published release. If one is found, its metadata is stored in
	 * `pendingUpdate` (for the settings UI to offer an "Update and reload" button) rather than being
	 * installed immediately \u2014 installing only happens when `applyPendingUpdate()` is explicitly called.
	 */
	async checkForUpdate(notifyIfUpToDate: boolean): Promise<void> {
		if (this.updating) {
			new Notice("HF Sync: an update is already in progress.");
			return;
		}
		this.updating = true;
		try {
			this.pendingUpdate = null;
			const release = await this.fetchLatestRelease();
			if (!release) return;
			if (!this.isNewerVersion(release.version, this.manifest.version)) {
				if (notifyIfUpToDate) {
					new Notice(`HF Sync: already up to date (v${this.manifest.version}).`);
				}
				return;
			}
			this.pendingUpdate = release;
			new Notice(`HF Sync: v${release.version} is available. Click "Update and reload" to install it.`);
		} finally {
			this.updating = false;
		}
	}

	/**
	 * Downloads and installs the release found by the last `checkForUpdate()` call, then restarts Obsidian.
	 * Never clones or builds from source \u2014 only the already-reviewed, already-built files attached to a
	 * tagged release are ever fetched or executed.
	 */
	async applyPendingUpdate(): Promise<void> {
		if (this.updating) {
			new Notice("HF Sync: an update is already in progress.");
			return;
		}
		const release = this.pendingUpdate;
		if (!release) {
			new Notice("HF Sync: no update to install. Check for updates first.");
			return;
		}
		this.updating = true;
		try {
			new Notice(`HF Sync: downloading update v${release.version}...`);
			await this.downloadAndApplyUpdate(release);
			this.pendingUpdate = null;
		} finally {
			this.updating = false;
		}
	}

	/** Fetches the latest release's asset URLs and version from GitHub. Returns null (with a Notice) on failure. */
	private async fetchLatestRelease(): Promise<LatestRelease | null> {
		try {
			const releaseResponse = await requestUrl({
				url: GITHUB_API_LATEST_RELEASE,
				headers: { Accept: "application/vnd.github+json", "User-Agent": "ObsidianHFSync-UpdateChecker" },
			});
			const body = releaseResponse.json as { assets?: { name: string; browser_download_url: string }[] };
			const assets: LatestRelease["assets"] = {};
			for (const asset of body.assets ?? []) {
				if ((UPDATE_ASSET_NAMES as readonly string[]).includes(asset.name)) {
					assets[asset.name as (typeof UPDATE_ASSET_NAMES)[number]] = asset.browser_download_url;
				}
			}
			if (!assets["main.js"] || !assets["manifest.json"]) {
				new Notice("HF Sync: latest release is missing required files (main.js/manifest.json).");
				return null;
			}
			const manifestResponse = await requestUrl({ url: assets["manifest.json"] as string });
			const manifest = manifestResponse.json as { version?: string };
			if (!manifest.version) {
				new Notice("HF Sync: could not read a version from the latest release's manifest.json.");
				return null;
			}
			return { version: manifest.version, assets };
		} catch (err) {
			new Notice(`HF Sync: failed to check for updates.\n${(err as Error).message}`);
			return null;
		}
	}

	private isNewerVersion(remote: string, local: string): boolean {
		const parse = (v: string) => v.split(".").map((n) => parseInt(n, 10) || 0);
		const [remoteMajor, remoteMinor, remotePatch] = parse(remote);
		const [localMajor, localMinor, localPatch] = parse(local);
		if (remoteMajor !== localMajor) return remoteMajor > localMajor;
		if (remoteMinor !== localMinor) return remoteMinor > localMinor;
		return remotePatch > localPatch;
	}

	/** Downloads each released asset and writes it into this plugin's own folder, rolling back on any failure. */
	private async downloadAndApplyUpdate(release: LatestRelease): Promise<void> {
		const adapter = this.app.vault.adapter;
		const pluginDir = `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
		const names = UPDATE_ASSET_NAMES.filter((name) => release.assets[name]);

		// Back up the current file contents in memory so a failed/partial download can be rolled back cleanly.
		const backups = new Map<string, string>();
		for (const name of names) {
			const path = `${pluginDir}/${name}`;
			if (await adapter.exists(path)) {
				backups.set(name, await adapter.read(path));
			}
		}

		try {
			for (const name of names) {
				const assetUrl = release.assets[name] as string;
				const response = await requestUrl({ url: assetUrl });
				await adapter.write(`${pluginDir}/${name}`, response.text);
			}
			new Notice(`HF Sync: updated to v${release.version}. Restarting Obsidian...`);
			await this.reloadSelf();
		} catch (err) {
			for (const [name, content] of backups) {
				try {
					await adapter.write(`${pluginDir}/${name}`, content);
				} catch {
					// best effort; nothing more we can do automatically
				}
			}
			new Notice(`HF Sync: update failed and was rolled back.\n${(err as Error).message}`);
		}
	}

	/** Restarts the Obsidian app window so the newly written plugin files are loaded completely fresh. */
	private async reloadSelf(): Promise<void> {
		try {
			// Obsidian's built-in "Reload app without saving" command reloads the whole renderer window,
			// which is far more reliable than trying to hot-swap just this plugin (Node's require() cache
			// and in-memory references to the old plugin instance make partial reloads error-prone).
			const commands = (this.app as unknown as { commands: { executeCommandById: (id: string) => boolean } }).commands;
			const reloaded = commands.executeCommandById("app:reload");
			if (!reloaded) {
				throw new Error("app:reload command unavailable");
			}
		} catch {
			new Notice("HF Sync: update installed. Please restart Obsidian to finish applying it.");
		}
	}
}

class HFSyncSettingTab extends PluginSettingTab {
	plugin: HFSyncPlugin;

	constructor(app: App, plugin: HFSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "HF Sync settings" });

		new Setting(containerEl)
			.setName("Git executable path")
			.setDesc("Path to the git executable. Use the full path if 'git' is not on your PATH (common on macOS).")
			.addText((text) =>
				text
					.setPlaceholder("git")
					.setValue(this.plugin.settings.gitPath)
					.onChange(async (value) => {
						this.plugin.settings.gitPath = value.trim() || "git";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Pull on startup")
			.setDesc("Automatically pull the latest changes when Obsidian starts.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.pullOnStartup).onChange(async (value) => {
					this.plugin.settings.pullOnStartup = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Show status bar item")
			.setDesc("Show the current sync status in the status bar.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showStatusBarItem).onChange(async (value) => {
					this.plugin.settings.showStatusBarItem = value;
					await this.plugin.saveSettings();
					this.plugin.refreshStatusBarVisibility();
				})
			);

		new Setting(containerEl)
			.setName("Sync now")
			.setDesc("Manually trigger a pull, commit, and push.")
			.addButton((button) =>
				button
					.setButtonText("Sync now")
					.setCta()
					.onClick(() => void this.plugin.sync())
			);

		containerEl.createEl("h2", { text: "Updates" });

		new Setting(containerEl)
			.setName("Current version")
			.setDesc(`v${this.plugin.manifest.version}`);

		new Setting(containerEl)
			.setName("Check for updates")
			.setDesc("Checks GitHub for a newer published release. Does not clone or build from source.")
			.addButton((button) =>
				button.setButtonText("Check for updates").onClick(async () => {
					await this.plugin.checkForUpdate(true);
					this.display();
				})
			);

		if (this.plugin.pendingUpdate) {
			new Setting(containerEl)
				.setName("Update available")
				.setDesc(
					`v${this.plugin.pendingUpdate.version} is ready to install. This downloads the release's pre-built files, replaces this plugin's files, and restarts Obsidian to apply them.`
				)
				.addButton((button) =>
					button
						.setButtonText("Update and reload")
						.setCta()
						.onClick(() => void this.plugin.applyPendingUpdate())
				);
		}
	}
}
