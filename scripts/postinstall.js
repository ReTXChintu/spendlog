#!/usr/bin/env node
// Runs after `npm install` at the root. npm workspaces already install
// apps/backend and apps/frontend; this adds the Flutter side by running
// `flutter pub get` in apps/mobile-app. Never fails the overall `npm install`
// — if Flutter isn't on PATH yet, it just warns and moves on.
const { spawnSync } = require("child_process");
const path = require("path");

const mobileDir = path.resolve(__dirname, "..", "apps", "mobile-app");
const flutterCmd = process.platform === "win32" ? "flutter.bat" : "flutter";

const result = spawnSync(flutterCmd, ["pub", "get"], { cwd: mobileDir, stdio: "inherit" });

if (result.error || result.status !== 0) {
  console.warn("\n[postinstall] Skipped/failed \"flutter pub get\" in apps/mobile-app.");
  console.warn("[postinstall] Install the Flutter SDK (https://docs.flutter.dev/get-started/install),");
  console.warn("[postinstall] make sure it's on your PATH, then run:");
  console.warn("  cd apps/mobile-app && flutter pub get\n");
}
