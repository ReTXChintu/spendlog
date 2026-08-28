#!/usr/bin/env node
// `npm run dev` — starts the backend, frontend, and Flutter app together.
// Pass a device through to Flutter with: npm run dev -- -d <device name>
const { spawn } = require("child_process");
const path = require("path");

const args = process.argv.slice(2);
let device = null;
for (let i = 0; i < args.length; i++) {
  if ((args[i] === "-d" || args[i] === "--device") && args[i + 1]) {
    device = args[i + 1];
  }
}

const root = path.resolve(__dirname, "..");
const isWin = process.platform === "win32";
const npmCmd = isWin ? "npm.cmd" : "npm";
const flutterCmd = isWin ? "flutter.bat" : "flutter";

const children = [];

function run(name, command, cmdArgs, cwd) {
  const child = spawn(command, cmdArgs, { cwd, stdio: "inherit" });
  children.push(child);
  child.on("exit", (code) => {
    console.log(`[${name}] exited with code ${code}`);
  });
  child.on("error", (err) => {
    console.error(`[${name}] failed to start: ${err.message}`);
  });
  return child;
}

run("backend", npmCmd, ["run", "dev", "--workspace", "apps/backend"], root);
run("frontend", npmCmd, ["run", "dev", "--workspace", "apps/frontend"], root);

const flutterArgs = device ? ["run", "-d", device] : ["run"];
run("mobile", flutterCmd, flutterArgs, path.join(root, "apps", "mobile-app"));

function shutdown() {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
