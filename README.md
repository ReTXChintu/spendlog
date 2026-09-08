# SpendLog

_Track every rupee, every day._

Auto-imports transactions from SMS and Gmail, groups them day-by-day, and
auto-categorizes them so you don't have to add anything by hand.

Monorepo:
- `apps/backend` — Node.js + Express + TypeScript + Mongoose (MongoDB)
- `apps/frontend` — React + Vite + TypeScript
- `apps/mobile-app` — Flutter (Android: SMS + Gmail import; iOS: Gmail import only)

## Prerequisites

- [Node.js 20+](https://nodejs.org) (includes npm)
- MongoDB — [Atlas](https://www.mongodb.com/atlas) or a local install
- [Flutter SDK](https://docs.flutter.dev/get-started/install) (for the mobile app)
- A Google Cloud project with an OAuth 2.0 Client ID (for Sign-In and Gmail read access)

## Install everything

From the repo root:

```
npm install
```

This installs `apps/backend` and `apps/frontend` (npm workspaces) and also
runs `flutter pub get` for `apps/mobile-app` via a postinstall script. If
the Flutter SDK isn't on your PATH yet, that step just warns and skips —
install Flutter, then re-run `cd apps/mobile-app && flutter pub get`.

Then configure the environment. There is **one `.env` for the whole
monorepo**, at the repo root — the apps do not have their own:

```
cp .env.example .env
```

Fill in `JWT_SECRET` and `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
How each app reads it:

| App | Mechanism |
| --- | --- |
| backend | `dotenv` with an explicit root path (`apps/backend/src/env.ts`), loaded via `src/db.ts` so scripts and tests get it too |
| frontend | Vite's `envDir` set to the repo root; only `VITE_`-prefixed vars reach browser code |
| mobile | `scripts/dev.js` reads `MOBILE_API_URL` and passes it to `flutter run` as `--dart-define=API_URL=...` |

### Database (MongoDB)

Set `DATABASE_URL` in the root `.env` to your MongoDB connection string,
including the database name.

```
# Atlas
DATABASE_URL="mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/spendlog?retryWrites=true&w=majority"

# Local
DATABASE_URL="mongodb://localhost:27017/spendlog"
```

Mongoose creates collections and indexes on demand, so there is no
migration or schema-push step. Seed the default categories (Food,
Transport, etc.) once:

```
npm run seed --workspace apps/backend
```

### Google OAuth setup (required for login + Gmail import)

Sign-in and Gmail read access are granted in a **single consent screen**,
so there is no separate "connect Gmail" step.

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), create an OAuth 2.0 Client ID (type: Web application).
2. Add authorized redirect URI: `http://localhost:4000/auth/google/callback`
3. Enable the Gmail API for the project.
4. Under OAuth consent screen, add the `.../auth/gmail.readonly` scope, and add yourself as a test user.
5. Copy the Client ID/Secret into the root `.env` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`).
6. For the mobile app's Google Sign-In, see `apps/mobile-app/README.md`.

Because `gmail.readonly` is a restricted scope, Google shows an
"unverified app" warning until the project goes through verification. In
testing mode that's fine for accounts listed as test users — click
*Advanced > Go to SpendLog (unsafe)* to continue.

The browser never loads Google's JavaScript SDK: `/auth/google/start`
redirects to Google, and `/auth/google/callback` redirects back with the
session token in the URL fragment.

## Running everything in dev

From the repo root:

```
npm run dev
```

Starts the backend (`:4000`), the frontend (`:5173`), and `flutter run` for
the mobile app, all together. To target a specific device/emulator for the
Flutter app, pass it through after `--`:

```
npm run dev -- -d emulator-5554
```

(`flutter devices` lists available device ids.) Stopping the command
(Ctrl+C) stops all three. You can also run each app individually with
`npm run dev:backend`, `npm run dev:frontend`, or `npm run dev:mobile`.

## Deploying to a VPS (PM2)

```
git clone <repo> /opt/var/spendlog && cd /opt/var/spendlog
cp .env.example .env          # then fill it in

# set FRONTEND_PORT, SSL_CERT_PATH and SSL_KEY_PATH in .env — the
# certificate itself is generated automatically if it isn't there

npm run deploy                # npm ci + build + start/restart PM2 + save
npm run pm2:persist           # one-time: survive a reboot
```

### Scripts

Every deployment action has an npm script, so CI and manual operation use
the same commands:

| Command | Does |
| --- | --- |
| `npm run deploy` | full deploy: `npm ci`, build both apps, start/restart PM2, save |
| `npm run build` | build backend and frontend |
| `npm run pm2:start` | `startOrRestart` — starts if stopped, restarts if running |
| `npm run pm2:restart` / `pm2:reload` | restart / reload both processes |
| `npm run pm2:stop` / `pm2:delete` | stop / remove them |
| `npm run pm2:status` | process list |
| `npm run pm2:logs` | tail both (`pm2:logs:backend`, `pm2:logs:frontend` for one) |
| `npm run pm2:persist` | install the boot service and snapshot the process list |

All of them pass `--update-env`. PM2 caches a process's environment, so
without it a changed `.env` appears to have no effect on restart.

### Surviving a reboot

`npm run pm2:persist` does both halves of this, which are easy to confuse:

1. `pm2 startup` installs a systemd unit that launches PM2 at boot
2. `pm2 save` snapshots the current process list for that unit to restore

Doing only one leaves nothing running after a reboot. `pm2 startup` needs
root, so when run as a normal user the script prints the exact `sudo …`
command to run once, then asks you to re-run it.

### Configuration

Both processes read the single `.env` at the repo root themselves — values
are not injected through PM2, precisely so that a `.env` edit plus a
restart is enough. The frontend uses:

| Key | Meaning |
| --- | --- |
| `FRONTEND_PORT` | port for the built site (default `5173`) |
| `SSL_CERT_PATH` / `SSL_KEY_PATH` | serve HTTPS when both are set |

Ports below 1024 need privileges. Either grant them once with
`sudo setcap 'cap_net_bind_service=+ep' $(which node)`, or keep
`FRONTEND_PORT` above 1024 and put a reverse proxy in front.

### Google sign-in needs a hostname, not an IP

Google **rejects raw IP addresses as OAuth redirect URIs entirely** — this
is not a matter of adding HTTPS. Only `localhost` and `127.0.0.1` are
exempt, and the host's TLD must be on the
[public suffix list](https://publicsuffix.org/list/).

Android compounds this: since Android 7 apps do not trust self-signed
certificates, and there is no prompt to accept one. A self-signed
certificate therefore breaks the mobile app's API calls outright, not just
the browser experience.

So a deployed instance needs a hostname *and* a CA-issued certificate. Both
are free.

#### DuckDNS + Let's Encrypt

`duckdns.org` is on the public suffix list, so each subdomain gets its own
Let's Encrypt rate limit. `nip.io` and `sslip.io` resolve just as well and
Google accepts them, but they are **not** on the list — every subdomain in
the world shares one exhausted rate-limit bucket, so Let's Encrypt will not
issue and you would be stuck on self-signed.

1. Sign in at [duckdns.org](https://www.duckdns.org), create a subdomain,
   point it at the server's IP, and copy the token from the top of the page.
2. Set in `.env`:

   ```
   DUCKDNS_DOMAIN="yourname"
   DUCKDNS_TOKEN="<token>"
   LETSENCRYPT_EMAIL="you@example.com"
   SSL_HOST="yourname.duckdns.org"
   ```

3. Install certbot (`sudo apt install -y certbot`) and run:

   ```
   sudo ./scripts/setup-letsencrypt.sh
   ```

   It uses the DNS-01 challenge through DuckDNS, so no inbound port has to
   be reachable. Without `DUCKDNS_TOKEN` it falls back to HTTP-01, which
   needs port 80 free and open.

4. Point `.env` at the issued files, and update the URLs:

   ```
   SSL_CERT_PATH="/etc/letsencrypt/live/yourname.duckdns.org/fullchain.pem"
   SSL_KEY_PATH="/etc/letsencrypt/live/yourname.duckdns.org/privkey.pem"
   FRONTEND_URL="https://yourname.duckdns.org:5173"
   GOOGLE_OAUTH_REDIRECT_URI="https://yourname.duckdns.org:4000/auth/google/callback"
   VITE_API_URL="https://yourname.duckdns.org:4000"
   MOBILE_API_URL="https://yourname.duckdns.org:4000"
   ```

5. Add that same redirect URI to the OAuth client in Google Cloud Console,
   then `npm run build && npm run pm2:restart`.

Renewal is handled by certbot's own timer. The deploy hook registered
during setup restarts PM2 afterwards, without which the processes keep
serving the expired certificate from memory. Check with
`sudo certbot renew --dry-run`.

`npm run certs:force` refuses to overwrite a CA-issued certificate, so it
cannot accidentally replace this with a self-signed one.

## Android APK builds

`.github/workflows/build-and-publish-apk.yml` builds a release APK on every
push, then copies it to the VPS at
`/opt/var/spendlog/apps/frontend/public/SpendLog.apk`, where the web app
offers it for download from Settings. The frontend server also serves files
straight out of `public/`, so a newly published APK is live immediately
without a frontend rebuild.

Required repository secrets:

| Secret | Purpose |
| --- | --- |
| `VPS_HOST` | server hostname or IP |
| `VPS_USER` | SSH user |
| `VPS_PORT` | SSH port (optional, defaults to 22) |
| `VPS_SSH_KEY` | private key for that user |
| `MOBILE_API_URL` | backend URL the app is built against |
| `GOOGLE_CLIENT_ID` | web OAuth client id, used as `serverClientId` |

The APK is signed with the debug key (see `android/app/build.gradle.kts`),
which is fine for sideloading but not for the Play Store.

## How ingestion works

- **SMS** (Android only): the app listens for incoming SMS in the background and posts each one to `POST /ingestion/sms`. On first launch it also offers a one-time backfill scan via `POST /ingestion/sms/batch`.
- **Email**: after connecting Gmail (OAuth, read-only scope) from Settings, the backend polls for new bank/UPI alert emails every 15 minutes, and you can trigger an immediate sync from the app.
- Both paths run through the same parser → categorizer → dedup pipeline (`apps/backend/src/parsing/`), so a transaction that shows up in both an SMS and an email alert is only stored once.

Full API surface is documented via the route files under `apps/backend/src/modules/*/*.routes.ts`.
