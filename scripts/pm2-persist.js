#!/usr/bin/env node
// Makes the PM2 processes survive a reboot.
//
// Two things are needed and they're easy to conflate:
//   1. `pm2 startup` installs a systemd unit that runs PM2 at boot
//   2. `pm2 save`    snapshots the current process list for it to restore
//
// Doing only (2) — or only (1) — leaves nothing running after a reboot,
// which is the usual reason processes have to be started by hand again.
//
// `pm2 startup` cannot install the unit without root, so when run as an
// unprivileged user it only prints the command to run. This script runs it
// directly when possible and otherwise surfaces that command clearly
// instead of letting it scroll past.
const { execFileSync, spawnSync } = require("child_process");

function pm2(args, opts = {}) {
  return spawnSync("pm2", args, { encoding: "utf8", shell: true, ...opts });
}

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

console.log("> pm2 startup");
const startup = pm2(["startup"]);
const output = `${startup.stdout ?? ""}${startup.stderr ?? ""}`;
process.stdout.write(output);

// When not root, PM2 prints the privileged command rather than running it.
const sudoCommand = output
  .split(/\r?\n/)
  .map((line) => line.trim())
  .find((line) => line.startsWith("sudo env PATH="));

if (sudoCommand && !isRoot) {
  console.log("\n" + "-".repeat(72));
  console.log("PM2 needs root to install its boot service. Run this once:\n");
  console.log(`  ${sudoCommand}\n`);
  console.log("Then re-run:  npm run pm2:persist");
  console.log("-".repeat(72));
  process.exitCode = 1;
  return;
}

if (sudoCommand && isRoot) {
  // Already root: run it directly, dropping the redundant sudo.
  const command = sudoCommand.replace(/^sudo\s+/, "");
  console.log(`\n> ${command}`);
  execFileSync(command, { stdio: "inherit", shell: true });
}

console.log("\n> pm2 save");
const save = pm2(["save"], { stdio: "inherit" });
if (save.status !== 0) {
  console.error("pm2 save failed — the process list was not snapshotted.");
  process.exitCode = save.status ?? 1;
  return;
}

console.log("\nPM2 will now restore these processes on boot.");
console.log("Verify with:  systemctl status pm2-$USER   (after a reboot: pm2 status)");
