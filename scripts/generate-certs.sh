#!/usr/bin/env bash
# Thin wrapper kept for the documented command. The implementation lives in
# scripts/ensure-certs.js, which the servers also call at startup so a
# missing certificate is generated automatically.
#
#   ./scripts/generate-certs.sh                 # host from SSL_HOST/FRONTEND_URL
#   ./scripts/generate-certs.sh 203.0.113.5     # explicit host
#   ./scripts/generate-certs.sh 203.0.113.5 --force
set -euo pipefail
exec node "$(dirname "$0")/ensure-certs.js" "$@"
