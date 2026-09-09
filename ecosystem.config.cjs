// PM2 process definitions for the SpendLog VPS deployment.
//
//   npm ci
//   npm run build
//   npm run pm2:start      # start or restart both processes
//   npm run pm2:persist    # survive a reboot (prints a one-time sudo step)
//
// Both processes read their own configuration from the single .env at the
// repo root, rather than having values injected here. PM2 caches a
// process's environment, so injected values go stale until a restart with
// --update-env; reading the file directly avoids that trap entirely.
const path = require("path");

module.exports = {
  apps: [
    {
      name: "spendlog-backend",
      cwd: path.join(__dirname, "apps/backend"),
      // Compiled output rather than tsx, so production isn't transpiling
      // on every start. Run `npm run build:backend` first.
      script: "dist/server.js",
      instances: 1,
      // Mongoose holds a connection pool and the Gmail sync runs on an
      // interval, so a single instance avoids duplicate scheduled syncs.
      exec_mode: "fork",
      autorestart: true,
      // max_restarts only counts starts that failed to stay up for
      // min_uptime. Without min_uptime set, a process that dies after a
      // couple of seconds still counts as a successful start, the counter
      // resets, and a fatal misconfiguration restarts forever instead of
      // stopping — filling the logs and hiding the actual error.
      min_uptime: "10s",
      max_restarts: 10,
      restart_delay: 2000,
      max_memory_restart: "500M",
      time: true,
      env: { NODE_ENV: "production" },
    },
    {
      name: "spendlog-frontend",
      cwd: path.join(__dirname, "apps/frontend"),
      script: "server.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      // max_restarts only counts starts that failed to stay up for
      // min_uptime. Without min_uptime set, a process that dies after a
      // couple of seconds still counts as a successful start, the counter
      // resets, and a fatal misconfiguration restarts forever instead of
      // stopping — filling the logs and hiding the actual error.
      min_uptime: "10s",
      max_restarts: 10,
      restart_delay: 2000,
      max_memory_restart: "300M",
      time: true,
      env: { NODE_ENV: "production" },
    },
  ],
};
