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
npm ci
cp .env.example .env          # then fill it in

./scripts/generate-certs.sh <your-ip-or-hostname>
# add the printed SSL_CERT_PATH / SSL_KEY_PATH to .env

npm run build:backend
npm run build:frontend

pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

`ecosystem.config.cjs` runs two processes: `spendlog-backend` (compiled
`dist/server.js`) and `spendlog-frontend` (`apps/frontend/server.js`, a
dependency-free static server). Both serve HTTPS when `SSL_CERT_PATH` and
`SSL_KEY_PATH` are set and plain HTTP otherwise, so local development needs
no certificates.

### Google sign-in needs a hostname, not an IP

Google **rejects raw IP addresses as OAuth redirect URIs entirely** — this
is not a matter of adding HTTPS. Only `localhost` and `127.0.0.1` are
exempt, and the host's TLD must be on the
[public suffix list](https://publicsuffix.org/list/). A self-signed
certificate on `https://203.0.113.5` will serve fine but sign-in will fail
with `Invalid Redirect URI`.

To make sign-in work, put a hostname in front of the IP:

- **Free, no registration:** `sslip.io` / `nip.io` resolve
  `203-0-113-5.nip.io` straight to that IP, with no DNS setup.
- **Free, with a record you control:** a DuckDNS subdomain.
- **Cleanest:** any cheap domain.

With a real hostname you can also use Let's Encrypt instead of a
self-signed certificate, which removes the browser warnings entirely.

### Self-signed certificate caveat

Browsers reject a self-signed certificate until it's accepted manually, and
**you must accept it on both origins** — the frontend and the backend. If
only the frontend is accepted, its API calls to the backend are blocked
with no visible prompt, and the app looks broken rather than untrusted.

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
