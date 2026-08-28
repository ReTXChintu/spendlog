#!/usr/bin/env node
// Runs after `npm install` at the root. npm workspaces already install
// apps/backend and apps/frontend; this adds the Flutter side by running
// `flutter pub get` in apps/mobile-app. Never fails the overall `npm install`
// — if Flutter isn't on PATH yet, it just warns and moves on.
const { spawnSync } = require("child_process");
const path = require("path");

const mobileDir = path.resolve(__dirname, "..", "apps", "mobile-app");

// shell: true resolves the flutter.bat/flutter shim on Windows without
// needing to guess the extension (also matches scripts/dev.js). Passed as
// a single command-line string, not shell:true + an args array, to avoid
// Node's DEP0190 unsafe-concatenation warning.
const result = spawnSync("flutter pub get", { cwd: mobileDir, stdio: "inherit", shell: true });

if (result.error || result.status !== 0) {
  console.warn("\n[postinstall] Skipped/failed \"flutter pub get\" in apps/mobile-app.");
  console.warn("[postinstall] Install the Flutter SDK (https://docs.flutter.dev/get-started/install),");
  console.warn("[postinstall] make sure it's on your PATH, then run:");
  console.warn("  cd apps/mobile-app && flutter pub get\n");
}
