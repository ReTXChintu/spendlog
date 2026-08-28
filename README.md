# Expense Tracker

Auto-imports transactions from SMS and Gmail, groups them day-by-day, and
auto-categorizes them so you don't have to add anything by hand.

Monorepo:
- `apps/backend` — Node.js + Express + TypeScript + Prisma (SQLite by default)
- `apps/frontend` — React + Vite + TypeScript
- `apps/mobile-app` — Flutter (Android: SMS + Gmail import; iOS: Gmail import only)

## Prerequisites

Nothing is installed on this machine yet. You'll need:
- [Node.js 20+](https://nodejs.org) (includes npm)
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

Then configure each app's environment:

```
cp apps/backend/.env.example apps/backend/.env     # fill in JWT_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
cp apps/frontend/.env.example apps/frontend/.env   # set VITE_GOOGLE_CLIENT_ID and VITE_API_URL
```

Run the database migration and seed the default categories (Food,
Transport, etc.) once:

```
cd apps/backend && npx prisma migrate dev --name init && npm run seed && cd ../..
```

### Google OAuth setup (required for login + Gmail import)

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), create an OAuth 2.0 Client ID (type: Web application).
2. Add authorized redirect URI: `http://localhost:4000/ingestion/email/callback`
3. Add authorized JavaScript origin: `http://localhost:5173`
4. Enable the Gmail API for the project.
5. Copy the Client ID/Secret into `apps/backend/.env`. The frontend also needs the Client ID (see above).
6. For the mobile app's Google Sign-In, see `apps/mobile-app/README.md`.

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

## How ingestion works

- **SMS** (Android only): the app listens for incoming SMS in the background and posts each one to `POST /ingestion/sms`. On first launch it also offers a one-time backfill scan via `POST /ingestion/sms/batch`.
- **Email**: after connecting Gmail (OAuth, read-only scope) from Settings, the backend polls for new bank/UPI alert emails every 15 minutes, and you can trigger an immediate sync from the app.
- Both paths run through the same parser → categorizer → dedup pipeline (`apps/backend/src/parsing/`), so a transaction that shows up in both an SMS and an email alert is only stored once.

Full API surface is documented via the route files under `apps/backend/src/modules/*/*.routes.ts`.
