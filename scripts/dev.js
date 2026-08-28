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
const children = [];

// shell: true is required on Windows to resolve .cmd/.bat shims (npm,
// flutter) — spawning them directly without a shell throws EINVAL on
// recent Node versions. commandLine is passed as a single pre-built string
// (rather than shell:true + an args array) to avoid Node's DEP0190
// unsafe-concatenation warning; it also makes a missing command (e.g.
// Flutter not installed yet) surface as a normal non-zero exit instead of
// crashing this whole script.
function run(name, commandLine, cwd) {
  let child;
  try {
    child = spawn(commandLine, { cwd, stdio: "inherit", shell: true });
  } catch (err) {
    console.error(`[${name}] failed to start: ${err.message}`);
    return null;
  }
  children.push(child);
  child.on("exit", (code) => {
    console.log(`[${name}] exited with code ${code}`);
  });
  child.on("error", (err) => {
    console.error(`[${name}] failed to start: ${err.message}`);
  });
  return child;
}

run("backend", "npm run dev --workspace apps/backend", root);
run("frontend", "npm run dev --workspace apps/frontend", root);

const deviceFlag = device ? ` -d ${JSON.stringify(device)}` : "";
run("mobile", `flutter run${deviceFlag}`, path.join(root, "apps", "mobile-app"));

function shutdown() {
  for (const child of children) {
    if (child && !child.killed) child.kill();
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
