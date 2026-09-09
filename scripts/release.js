#!/usr/bin/env node
/**
 * Runs release-it with the repo's own conventions applied.
 *
 * All it adds is the token: release-it reads GITHUB_TOKEN from the
 * environment, and this repo keeps every secret in one .env at the root
 * rather than expecting them to be exported by hand. Everything else —
 * the bump, the commit, the tag, the push, the GitHub release — is
 * release-it's, configured in .release-it.json.
 *
 *   npm run release              # patch, with a prompt for each step
 *   npm run release:minor
 *   npm run release -- 1.4.0     # an explicit version
 *   npm run release:dry          # go through the motions, change nothing
 *
 * Publishing the GitHub release is what triggers the deploy workflow; a
 * pushed tag on its own ships nothing.
 */
const { spawnSync } = require("child_process");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

require("dotenv").config({ path: path.join(ROOT, ".env") });

if (!process.env.GITHUB_TOKEN) {
  console.error("GITHUB_TOKEN isn't set, so the GitHub release can't be published.\n");
  console.error("Create a token with the 'repo' and 'workflow' scopes at");
  console.error("  https://github.com/settings/tokens");
  console.error("and add it to the .env at the repo root:");
  console.error("  GITHUB_TOKEN=ghp_...\n");
  console.error("See .env.example.");
  process.exit(1);
}

const result = spawnSync("npx", ["release-it", ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: "inherit",
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
