#!/usr/bin/env bash
# Obtains a real Let's Encrypt certificate so the app is trusted by
# browsers and by Android (which refuses self-signed certificates outright,
# with no way for the user to accept them).
#
#   sudo ./scripts/setup-letsencrypt.sh
#
# Uses the DNS-01 challenge via DuckDNS when DUCKDNS_TOKEN is set, so no
# inbound port needs to be reachable; otherwise falls back to HTTP-01,
# which needs port 80 free and open. Renewal is handled by certbot's own
# timer — the deploy hook below restarts PM2 so the new certificate is
# actually picked up, which is the step usually forgotten.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

get_env() {
  grep -E "^[[:space:]]*$1[[:space:]]*=" "$ROOT/.env" 2>/dev/null |
    head -1 |
    sed -E "s/^[^=]*=//; s/^[\"']//; s/[\"']$//"
}

DOMAIN="$(get_env SSL_HOST)"
LABEL="$(get_env DUCKDNS_DOMAIN)"
TOKEN="$(get_env DUCKDNS_TOKEN)"
EMAIL="$(get_env LETSENCRYPT_EMAIL)"

# Fall back to the DuckDNS label, then to the FRONTEND_URL host.
if [ -z "$DOMAIN" ] && [ -n "$LABEL" ]; then
  DOMAIN="${LABEL%.duckdns.org}.duckdns.org"
fi
if [ -z "$DOMAIN" ]; then
  DOMAIN="$(get_env FRONTEND_URL | sed -E 's#^[a-z]+://##; s#[:/].*$##')"
fi

if [ -z "$DOMAIN" ] || [[ "$DOMAIN" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  cat >&2 <<EOF
A hostname is required — Let's Encrypt will not issue for an IP address,
and neither will Google accept one as an OAuth redirect URI.

Set these in $ROOT/.env:
  DUCKDNS_DOMAIN="yourname"          # from https://www.duckdns.org
  DUCKDNS_TOKEN="<token>"
  LETSENCRYPT_EMAIL="you@example.com"
  SSL_HOST="yourname.duckdns.org"
EOF
  exit 1
fi

if [ -z "$EMAIL" ]; then
  echo "LETSENCRYPT_EMAIL must be set in $ROOT/.env (used for expiry notices)." >&2
  exit 1
fi

if ! command -v certbot > /dev/null 2>&1; then
  cat >&2 <<'EOF'
certbot is not installed. On Debian/Ubuntu:
  sudo apt update && sudo apt install -y certbot
EOF
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this with sudo — certbot writes to /etc/letsencrypt." >&2
  exit 1
fi

echo "Requesting a certificate for $DOMAIN"

# Restart PM2 after every successful issuance and renewal, otherwise the
# running processes keep serving the old certificate until something else
# restarts them.
DEPLOY_HOOK="cd $ROOT && npm run pm2:restart"

if [ -n "$TOKEN" ]; then
  echo "Using the DNS-01 challenge via DuckDNS (no inbound port needed)."
  chmod +x "$ROOT/scripts/duckdns-hook.sh"
  certbot certonly \
    --manual \
    --preferred-challenges dns \
    --manual-auth-hook "$ROOT/scripts/duckdns-hook.sh auth" \
    --manual-cleanup-hook "$ROOT/scripts/duckdns-hook.sh cleanup" \
    --deploy-hook "$DEPLOY_HOOK" \
    --non-interactive --agree-tos -m "$EMAIL" \
    -d "$DOMAIN"
else
  echo "DUCKDNS_TOKEN not set — using the HTTP-01 challenge, which needs port 80 free and open."
  certbot certonly \
    --standalone \
    --deploy-hook "$DEPLOY_HOOK" \
    --non-interactive --agree-tos -m "$EMAIL" \
    -d "$DOMAIN"
fi

LIVE="/etc/letsencrypt/live/$DOMAIN"

cat <<EOF

Certificate issued:
  $LIVE/fullchain.pem
  $LIVE/privkey.pem

Point .env at them (these replace any self-signed pair):
  SSL_CERT_PATH="$LIVE/fullchain.pem"
  SSL_KEY_PATH="$LIVE/privkey.pem"
  SSL_HOST="$DOMAIN"
  FRONTEND_URL="https://$DOMAIN:\${FRONTEND_PORT}"
  GOOGLE_OAUTH_REDIRECT_URI="https://$DOMAIN:\${PORT}/auth/google/callback"

Then in Google Cloud Console, add that same redirect URI to the OAuth
client, and restart:  npm run pm2:restart

certbot renews automatically via its own timer; the deploy hook restarts
PM2 so the renewed certificate is picked up. Check it with:
  sudo certbot renew --dry-run
EOF
