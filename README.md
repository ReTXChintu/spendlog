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

## Backend setup

```
cd apps/backend
npm install
cp .env.example .env      # then fill in JWT_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
npx prisma migrate dev --name init
npm run seed               # populates default categories (Food, Transport, etc.)
npm run dev                 # starts on http://localhost:4000
```

### Google OAuth setup (required for login + Gmail import)

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), create an OAuth 2.0 Client ID (type: Web application).
2. Add authorized redirect URI: `http://localhost:4000/ingestion/email/callback`
3. Add authorized JavaScript origin: `http://localhost:5173`
4. Enable the Gmail API for the project.
5. Copy the Client ID/Secret into `apps/backend/.env`. The frontend also needs the Client ID (see below).

## Frontend setup

```
cd apps/frontend
npm install
cp .env.example .env       # set VITE_GOOGLE_CLIENT_ID and VITE_API_URL
npm run dev                 # starts on http://localhost:5173
```

## Mobile app setup

```
cd apps/mobile-app
flutter pub get
flutter run
```

See `apps/mobile-app/README.md` for Android SMS-permission setup and the Google Sign-In configuration file placement.

## How ingestion works

- **SMS** (Android only): the app listens for incoming SMS in the background and posts each one to `POST /ingestion/sms`. On first launch it also offers a one-time backfill scan via `POST /ingestion/sms/batch`.
- **Email**: after connecting Gmail (OAuth, read-only scope) from Settings, the backend polls for new bank/UPI alert emails every 15 minutes, and you can trigger an immediate sync from the app.
- Both paths run through the same parser → categorizer → dedup pipeline (`apps/backend/src/parsing/`), so a transaction that shows up in both an SMS and an email alert is only stored once.

Full API surface is documented via the route files under `apps/backend/src/modules/*/*.routes.ts`.
