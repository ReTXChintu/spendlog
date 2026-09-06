// PM2 process definitions for the SpendLog VPS deployment.
//
//   npm ci
//   npm run build:backend && npm run build:frontend
//   pm2 start ecosystem.config.cjs
//   pm2 save && pm2 startup
//
// Both processes read their configuration from the single .env at the repo
// root. The backend loads it itself; the frontend's static server is given
// only what it needs, below.
const fs = require("fs");
const path = require("path");

function readRootEnv() {
  const values = {};
  try {
    const contents = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i);
      if (match) values[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // No .env yet — the apps fall back to their own defaults.
  }
  return values;
}

const env = readRootEnv();

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
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "spendlog-frontend",
      cwd: path.join(__dirname, "apps/frontend"),
      script: "server.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
        FRONTEND_PORT: env.FRONTEND_PORT || "5173",
        SSL_CERT_PATH: env.SSL_CERT_PATH || "",
        SSL_KEY_PATH: env.SSL_KEY_PATH || "",
      },
    },
  ],
};
