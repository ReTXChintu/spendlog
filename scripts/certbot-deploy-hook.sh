#!/usr/bin/env bash
# Run by certbot after a certificate is issued or renewed.
#
# Node holds the certificate in memory, so without a restart the processes
# keep serving the old one until something else happens to restart them —
# which, three months later, means serving an expired certificate.
#
# This is a real script rather than an inline command because certbot
# validates that a deploy hook is an executable on PATH: an inline
# "cd … && npm run …" fails with "Unable to find deploy-hook command cd".
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Renewals run from certbot's systemd timer with a minimal environment, so
# a node installed through nvm is not on PATH — npm and pm2 would be
# missing exactly when this matters, months from now and unattended.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" > /dev/null 2>&1 || true
fi

if command -v npm > /dev/null 2>&1; then
  npm run pm2:restart
elif command -v pm2 > /dev/null 2>&1; then
  pm2 restart ecosystem.config.cjs --update-env
else
  echo "certbot deploy hook: neither npm nor pm2 is on PATH." >&2
  echo "The certificate was renewed, but the app is still serving the old one." >&2
  echo "Restart it manually:  cd $ROOT && npm run pm2:restart" >&2
  exit 1
fi

echo "certbot deploy hook: restarted PM2 so the renewed certificate is in use."
