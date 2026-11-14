#!/usr/bin/env node
// Bumps the plugin version, keeps manifest.json/versions.json in sync, commits, tags, and pushes.
// The pushed tag (vX.Y.Z) triggers .github/workflows/release.yml, which builds the plugin and
// publishes main.js/manifest.json/styles.css as downloadable release assets.
//
// Usage: npm run release:patch | npm run release:minor | npm run release:major

import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";

const bumpArg = process.argv[2];

if (!["patch", "minor", "major"].includes(bumpArg)) {
	console.error("Usage: npm run release:patch | npm run release:minor | npm run release:major");
	process.exit(1);
}

function run(cmd) {
	execSync(cmd, { stdio: "inherit" });
}

// Refuse to run with uncommitted changes so the release commit contains only the version bump.
const status = execSync("git status --porcelain").toString();
if (status.trim().length > 0) {
	console.error("Release aborted: working tree has uncommitted changes. Commit or stash them first.");
	process.exit(1);
}

// Bumps package.json (and package-lock.json) using npm's own semver logic, without committing/tagging yet.
run(`npm version ${bumpArg} --no-git-tag-version`);

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const newVersion = pkg.version;

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
manifest.version = newVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[newVersion] = manifest.minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, "\t") + "\n");

run("git add package.json package-lock.json manifest.json versions.json");
run(`git commit -m "Release v${newVersion}"`);
run(`git tag v${newVersion}`);
run("git push");
run(`git push origin v${newVersion}`);

console.log(`\nReleased v${newVersion}. GitHub Actions will build it and publish the release shortly.`);
