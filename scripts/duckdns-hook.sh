#!/usr/bin/env bash
# certbot DNS-01 hook for a DuckDNS subdomain.
#
#   duckdns-hook.sh auth      publishes the challenge TXT record
#   duckdns-hook.sh cleanup   clears it
#
# certbot records this path in the renewal config, so it must stay put —
# hence a committed script that reads the token from .env at run time,
# rather than a temporary file written during setup.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:-auth}"

# Reads one key from the root .env without sourcing it (values can contain
# characters the shell would otherwise interpret).
get_env() {
  grep -E "^[[:space:]]*$1[[:space:]]*=" "$ROOT/.env" 2>/dev/null |
    head -1 |
    sed -E "s/^[^=]*=//; s/^[\"']//; s/[\"']$//"
}

LABEL="$(get_env DUCKDNS_DOMAIN)"
TOKEN="$(get_env DUCKDNS_TOKEN)"
WAIT="$(get_env DUCKDNS_PROPAGATION_SECONDS)"
WAIT="${WAIT:-30}"

# Accept either "myapp" or "myapp.duckdns.org".
LABEL="${LABEL%.duckdns.org}"

if [ -z "$LABEL" ] || [ -z "$TOKEN" ]; then
  echo "DUCKDNS_DOMAIN and DUCKDNS_TOKEN must be set in $ROOT/.env" >&2
  exit 1
fi

# DuckDNS attaches the TXT to _acme-challenge.<label>.duckdns.org itself,
# which is exactly the name Let's Encrypt looks up.
if [ "$MODE" = "cleanup" ]; then
  curl -fsS "https://www.duckdns.org/update?domains=${LABEL}&token=${TOKEN}&txt=removed&clear=true" > /dev/null
  exit 0
fi

response="$(curl -fsS "https://www.duckdns.org/update?domains=${LABEL}&token=${TOKEN}&txt=${CERTBOT_VALIDATION}")"
if [ "$response" != "OK" ]; then
  echo "DuckDNS rejected the update (response: ${response:-empty}). Check DUCKDNS_DOMAIN and DUCKDNS_TOKEN." >&2
  exit 1
fi

# Let's Encrypt queries the authoritative nameservers immediately after the
# hook returns, so give the record time to appear before yielding.
sleep "$WAIT"
