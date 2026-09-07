#!/usr/bin/env node
// Ensures a self-signed TLS certificate exists at the paths configured in
// the root .env, generating one if it's missing.
//
//   node scripts/ensure-certs.js            # generate only if absent
//   node scripts/ensure-certs.js --force    # regenerate
//   node scripts/ensure-certs.js 1.2.3.4    # override the host
//
// Both servers call this at startup, so a fresh deployment only needs the
// SSL_* paths set in .env — no separate certificate step. Kept as a single
// standalone script (rather than duplicated in each server) because the
// backend and frontend are different module systems.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DAYS = 3650;
const LOCK_WAIT_MS = 30000;

function readRootEnv() {
  const values = {};
  try {
    for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (match) values[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // No .env — caller falls back to real environment variables.
  }
  return values;
}

const isIpAddress = (host) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host);

/** Blocks the thread. Used only while waiting on another process's lock. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The name the certificate is issued for. SSL_HOST wins; otherwise it's
 * taken from FRONTEND_URL, since that's the address users actually visit.
 */
function resolveHost(env) {
  if (env.SSL_HOST) return env.SSL_HOST;
  try {
    const hostname = new URL(env.FRONTEND_URL ?? "").hostname;
    if (hostname) return hostname;
  } catch {
    // FRONTEND_URL unset or unparseable.
  }
  return "localhost";
}

/**
 * Rejects the two ways these paths are commonly mis-set, both of which
 * otherwise fail deep inside generation with a confusing error: pointing
 * them at a directory, or at the same file. They must name two distinct
 * files, which will be created.
 */
function validatePaths(certPath, keyPath) {
  const example = (dir) =>
    `  SSL_CERT_PATH="${path.join(dir, "spendlog.crt")}"\n  SSL_KEY_PATH="${path.join(dir, "spendlog.key")}"`;

  if (path.resolve(certPath) === path.resolve(keyPath)) {
    throw new Error(
      `SSL_CERT_PATH and SSL_KEY_PATH are the same path:\n  ${certPath}\n\n` +
        `They must name two different files — the certificate and its private key.\n` +
        `If that is meant to be a directory, use:\n${example(certPath)}`
    );
  }

  for (const [label, target] of [
    ["SSL_CERT_PATH", certPath],
    ["SSL_KEY_PATH", keyPath],
  ]) {
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      throw new Error(
        `${label} points at a directory, not a file:\n  ${target}\n\n` +
          `Name the files inside it instead:\n${example(target)}`
      );
    }
  }
}

function generate(certPath, keyPath, host) {
  // Browsers reject a certificate identified only by Common Name, so the
  // host must appear in subjectAltName — as IP: or DNS: depending on kind.
  const alt = isIpAddress(host)
    ? `IP:${host},IP:127.0.0.1,DNS:localhost`
    : `DNS:${host},DNS:localhost,IP:127.0.0.1`;

  // Written to temporary names and renamed into place, so a reader can
  // never observe a half-written certificate.
  const tmpCert = `${certPath}.tmp`;
  const tmpKey = `${keyPath}.tmp`;

  const result = spawnSync(
    "openssl",
    [
      "req", "-x509", "-nodes",
      "-newkey", "rsa:2048",
      "-keyout", tmpKey,
      "-out", tmpCert,
      "-days", String(DAYS),
      "-subj", `/CN=${host}`,
      "-addext", `subjectAltName=${alt}`,
      "-addext", "basicConstraints=critical,CA:FALSE",
      "-addext", "keyUsage=critical,digitalSignature,keyEncipherment",
      "-addext", "extendedKeyUsage=serverAuth",
    ],
    { encoding: "utf8" }
  );

  if (result.error?.code === "ENOENT") {
    throw new Error("openssl is not installed or not on PATH — cannot generate a certificate.");
  }
  if (result.status !== 0) {
    throw new Error(`openssl failed:\n${result.stderr ?? result.stdout ?? "(no output)"}`);
  }

  try {
    fs.renameSync(tmpCert, certPath);
    fs.renameSync(tmpKey, keyPath);
    fs.chmodSync(keyPath, 0o600);
  } catch (err) {
    // Don't leave half a pair behind for the next start to trust.
    for (const leftover of [tmpCert, tmpKey, certPath, keyPath]) {
      try {
        fs.unlinkSync(leftover);
      } catch {
        /* not there */
      }
    }
    throw err;
  }

  return alt;
}

/**
 * Generates the pair if absent. Returns a short status string.
 * Safe to call from several processes at once: the first to create the
 * lock generates, the others wait for the files to appear.
 */
function ensureCerts({ certPath, keyPath, host, force = false, log = console.log } = {}) {
  if (!certPath || !keyPath) return "skipped: SSL_CERT_PATH/SSL_KEY_PATH not set";

  validatePaths(certPath, keyPath);

  const present = () =>
    fs.existsSync(certPath) && fs.existsSync(keyPath) && fs.statSync(certPath).isFile();
  if (present() && !force) return "exists";

  fs.mkdirSync(path.dirname(certPath), { recursive: true });
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });

  const lockPath = `${certPath}.lock`;
  let lock;
  try {
    // Exclusive create: fails if another process already holds it.
    lock = fs.openSync(lockPath, "wx");
  } catch (err) {
    if (err.code !== "EEXIST") throw err;

    // Someone else is generating — wait for them rather than racing.
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (Date.now() < deadline) {
      if (present()) return "generated by another process";
      sleepSync(250);
    }
    // The holder died before finishing; clear the stale lock and retry.
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
    return ensureCerts({ certPath, keyPath, host, force, log });
  }

  try {
    if (present() && !force) return "exists";
    log(`Generating self-signed certificate for ${host} …`);
    const alt = generate(certPath, keyPath, host);
    log(`  ${certPath}`);
    log(`  ${keyPath} (mode 600)`);
    log(`  SANs: ${alt}`);
    return "generated";
  } finally {
    fs.closeSync(lock);
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  }
}

/** Resolves configuration from .env plus real environment variables. */
function resolveConfig(hostOverride) {
  const fileEnv = readRootEnv();
  const setting = (key) => process.env[key] || fileEnv[key] || "";
  return {
    certPath: setting("SSL_CERT_PATH"),
    keyPath: setting("SSL_KEY_PATH"),
    host: hostOverride || resolveHost({ SSL_HOST: setting("SSL_HOST"), FRONTEND_URL: setting("FRONTEND_URL") }),
  };
}

module.exports = { ensureCerts, resolveConfig };

if (require.main === module) {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const hostArg = args.find((a) => !a.startsWith("--"));
  const config = resolveConfig(hostArg);

  if (!config.certPath || !config.keyPath) {
    console.error("SSL_CERT_PATH and SSL_KEY_PATH must be set in the root .env.");
    console.error("Example:");
    console.error('  SSL_CERT_PATH="/opt/var/spendlog/certs/spendlog.crt"');
    console.error('  SSL_KEY_PATH="/opt/var/spendlog/certs/spendlog.key"');
    process.exit(1);
  }

  try {
    const status = ensureCerts({ ...config, force });
    console.log(`Certificate: ${status} (host: ${config.host})`);
    if (status === "exists") console.log("Pass --force to regenerate.");
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
