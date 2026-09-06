#!/usr/bin/env bash
# Generates a self-signed TLS certificate for the backend and frontend.
#
#   ./scripts/generate-certs.sh 203.0.113.5
#   ./scripts/generate-certs.sh spendlog.example.com
#
# The host argument goes into subjectAltName, which browsers require —
# a certificate with only a Common Name is rejected outright. IP hosts are
# added as IP: entries and hostnames as DNS: entries, since they are
# validated differently.
set -euo pipefail

# Git Bash / MSYS on Windows rewrites arguments that look like paths, which
# corrupts openssl's "/CN=..." subject into a Windows path. Exclude just
# that argument — the file paths below still need converting. No effect on
# Linux.
export MSYS2_ARG_CONV_EXCL="/CN="

HOST="${1:-}"
if [ -z "$HOST" ]; then
  echo "usage: $0 <ip-address-or-hostname>" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/certs"
DAYS=3650

mkdir -p "$OUT"

if [[ "$HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  ALT="IP:$HOST,IP:127.0.0.1,DNS:localhost"
else
  ALT="DNS:$HOST,DNS:localhost,IP:127.0.0.1"
fi

openssl req -x509 -nodes -newkey rsa:2048 \
  -keyout "$OUT/spendlog.key" \
  -out "$OUT/spendlog.crt" \
  -days "$DAYS" \
  -subj "/CN=$HOST" \
  -addext "subjectAltName=$ALT" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth"

chmod 600 "$OUT/spendlog.key"

echo
echo "Wrote:"
echo "  $OUT/spendlog.crt"
echo "  $OUT/spendlog.key   (mode 600)"
echo
echo "Add to the .env at the repo root:"
echo "  SSL_CERT_PATH=\"$OUT/spendlog.crt\""
echo "  SSL_KEY_PATH=\"$OUT/spendlog.key\""
echo
echo "Certificate SANs: $ALT"
echo
echo "NOTE: browsers will warn on a self-signed certificate. You must open"
echo "BOTH origins once and accept the warning — the frontend's API calls to"
echo "the backend fail silently otherwise, because the browser blocks"
echo "requests to an untrusted certificate with no visible prompt."
