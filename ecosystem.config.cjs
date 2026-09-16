// PM2 process definitions for the SpendLog VPS deployment.
//
//   npm ci
//   npm run build
//   npm run pm2:start      # start or restart every process
//   npm run pm2:persist    # survive a reboot (prints a one-time sudo step)
//
// Two processes, or three: the vision model joins them only where the .env
// says where to find it and the files are actually there. See
// docs/coupon-reading.md.
//
// Both processes read their own configuration from the single .env at the
// repo root, rather than having values injected here. PM2 caches a
// process's environment, so injected values go stale until a restart with
// --update-env; reading the file directly avoids that trap entirely.
const fs = require("fs");
const path = require("path");

/**
 * The handful of .env values this file needs, read without dotenv.
 *
 * dotenv is a backend dependency that npm happens to hoist to the root,
 * so requiring it here works today and would stop working the day npm
 * nested it instead - and this is the file that starts production, so a
 * missing module would take down all of it rather than one feature. Five
 * lines of parsing is the cheaper risk.
 *
 * Only the values that decide whether the model is part of this
 * deployment. Everything else each process reads for itself, which is
 * what keeps PM2's cached environment from going stale.
 */
function fromEnvFile(name) {
  if (process.env[name]) return process.env[name];

  try {
    const line = fs
      .readFileSync(path.join(__dirname, ".env"), "utf8")
      .split("\n")
      .map((row) => row.trim())
      .find((row) => row.startsWith(`${name}=`));

    // Quotes are optional in a .env and the file has them on some values
    // and not others, so both spellings have to read the same.
    return line ? line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "") : "";
  } catch {
    // No .env at all is a normal state for a checkout nobody has
    // configured yet, and it means no model rather than no deployment.
    return "";
  }
}

/**
 * The vision model, as a process PM2 owns.
 *
 * Returns nothing at all unless the deployment is set up for one, so a
 * server without a model starts two processes and says nothing about a
 * third. That matters more than it looks: `pm2 startOrRestart` on a config
 * naming a binary that is not there leaves a permanently errored process
 * in the list, and it is the sort of thing you stop noticing.
 *
 * The port comes from VISION_BASE_URL, so there is one place that says
 * where the model listens rather than two that have to agree.
 */
function visionApp() {
  const baseUrl = fromEnvFile("VISION_BASE_URL");
  const bin = fromEnvFile("VISION_SERVER_BIN");
  const model = fromEnvFile("VISION_MODEL_PATH");
  const mmproj = fromEnvFile("VISION_MMPROJ_PATH");

  if (!baseUrl || !bin || !model || !mmproj) return [];
  if (!fs.existsSync(bin) || !fs.existsSync(model)) return [];

  const port = new URL(baseUrl).port || "8081";

  return [
    {
      name: "spendlog-vision",
      script: bin,
      // Loopback, always. The model has no authentication of its own, and
      // anything that can reach it can ask it anything.
      args: [
        "--model", model,
        // Without this the server starts happily and then refuses every
        // image, which is a confusing way to learn you forgot it.
        "--mmproj", mmproj,
        "--host", "127.0.0.1",
        "--port", port,
        // Short of every core on purpose, so Mongo, Node and the web
        // server keep one each. Those are what you notice slowing down.
        "--threads", fromEnvFile("VISION_THREADS") || "6",
        "--ctx-size", fromEnvFile("VISION_CTX_SIZE") || "4096",
      ],
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      min_uptime: "30s",
      max_restarts: 5,
      restart_delay: 5000,
      // Deliberately absent: a 3B model holds three and a half gigabytes
      // by design, and a memory ceiling here would restart it forever.
      time: true,
    },
  ];
}

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
    ...visionApp(),
  ],
};
