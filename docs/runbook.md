# Running SpendLog

Everything needed to get a release out and keep the deployed app healthy.
Signing specifics live in [android-signing.md](android-signing.md).

## Where things run

| Piece | Where | Started by |
| --- | --- | --- |
| Backend (Express) | VPS, loopback only | PM2, `spendlog-backend` |
| Frontend (static + `/api` proxy) | VPS, public HTTPS port | PM2, `spendlog-frontend` |
| Android app | Sideloaded from `/SpendLog.apk` | — |
| Database | MongoDB Atlas | — |

The frontend is the only thing listening publicly. It serves the built site
and proxies `/api` to the backend on loopback, so one port carries both and
Traefik's 80/443 stay untouched.

---

## Part 1 — one-time setup

Sign-in cannot work until this is done. Everything here happens once.

### 1. Create the release keystore

On your machine, somewhere outside the repo:

```bash
keytool -genkeypair -v \
  -keystore spendlog-release.jks \
  -storetype PKCS12 \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -alias spendlog
```

It asks for a password (twice), then name/organisation fields — those only
appear in certificate details, so anything reasonable is fine — then a
final `yes`. Use the same password for the store and the key.

**Back this file up somewhere you will still have in five years.** If it is
lost, no future build can update an installed SpendLog: every phone has to
uninstall and sign in again, and the OAuth client below has to be
registered a second time.

### 2. Read its SHA-1

```bash
keytool -list -v -keystore spendlog-release.jks -alias spendlog | grep SHA1
```

Keep that line; step 3 needs it.

### 3. Register the Android OAuth client

In the [Google Cloud console](https://console.cloud.google.com/apis/credentials),
**in the same project as the existing web client**:

*APIs & Services → Credentials → Create credentials → OAuth client ID → Android*

- **Name** — anything, e.g. `SpendLog Android`
- **Package name** — `io.github.retxchintu.spendlog`
- **SHA-1 certificate fingerprint** — from step 2

Create it and close the dialog. Nothing from it goes into the app: its only
job is telling Google that this package, signed with this certificate, may
sign in. The app keeps using the **web** client id, because the backend
exchanges the returned auth code with that client's secret.

### 4. Add the signing secrets to GitHub

Get the keystore as one line of base64:

```bash
base64 -w0 spendlog-release.jks > keystore.b64   # macOS: base64 -i spendlog-release.jks
```

Then *Settings → Secrets and variables → Actions → New repository secret*:

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | the contents of `keystore.b64` |
| `ANDROID_KEYSTORE_PASSWORD` | the password from step 1 |
| `ANDROID_KEY_ALIAS` | `spendlog` |
| `ANDROID_KEY_PASSWORD` | the password from step 1 |

Delete `keystore.b64` afterwards. Keep the `.jks`.

### 5. Confirm the other secrets exist

The same page should already have these. The release now fails fast if any
are missing, but it is quicker to check than to watch a build fail:

| Secret | Value |
| --- | --- |
| `MOBILE_API_URL` | `https://spend-log.duckdns.org:50002/api` — the public URL **including `/api`** |
| `GOOGLE_CLIENT_ID` | the **web** OAuth client id |
| `VPS_HOST` | server hostname |
| `VPS_USER` | ssh user |
| `VPS_PORT` | ssh port |
| `VPS_SSH_KEY` | private deploy key |

`MOBILE_API_URL` matters twice over: the app talks to it, and it derives
the APK download URL from it by dropping the `/api` suffix.

---

## Part 2 — cutting a release

This is the whole loop, every time.

```bash
git push                 # the release commit goes on top of what's pushed
npm run release:patch    # or release:minor / release:major
```

`release` bumps one version across the root, both npm workspaces,
`pubspec.yaml` (with the Android build number), and `version.dart`;
refreshes the lockfile; commits; tags; pushes; then **opens your browser**
on GitHub's new-release page with the tag, title and changelog filled in.

**Press "Publish release".** Nothing deploys until you do — the workflow
triggers on a published release, not on a pushed tag.

To check what it would do without doing it: `npm run release:dry`.

### What the workflow then does

1. Checks the tag matches `package.json`, and that every secret is set
2. Builds the APK, signed with your keystore
3. Prints the APK's certificate SHA-1 in the log
4. Attaches the APK to the GitHub release
5. Copies the APK to the VPS at `apps/frontend/public/SpendLog.apk`
6. Moves `main` to that tag on the VPS, `npm ci`, `npm run build`, restarts PM2
7. Prints the deployed version

Watch it with `gh run watch`, or the Actions tab.

The APK is copied **before** the build on purpose: `npm run build` copies
`public/` into `dist/`, so the new download goes live in the same pass.

### If it fails

Re-run without cutting another version: *Actions → Release → Run workflow*
and give it the tag, e.g. `v0.1.4`. That path skips only the
attach-APK-to-release step; the VPS still gets both the APK and the deploy.

---

## Part 3 — installing on the phone

The package name changed from Flutter's placeholder, so Android treats the
new build as a different app.

1. **Uninstall the existing SpendLog** (once — only for this next release)
2. Download `https://spend-log.duckdns.org:50002/SpendLog.apk`, or the APK
   attached to the GitHub release
3. Install it and sign in

After this, releases install over each other normally, because the signing
key stops changing. The app checks `/version` on startup and offers the
download when the server is ahead.

---

## Part 4 — keeping it running

### Checking on it

All from `/opt/var/spendlog` on the VPS:

```bash
npm run pm2:status            # both processes should be "online"
npm run pm2:logs              # both, last 100 lines
npm run pm2:logs:backend      # just the backend
curl -sk https://localhost:50002/api/health   # {"ok":true,"version":"..."}
```

The version the server reports and the version in the app's Settings should
match after a deploy.

### Surviving a reboot

PM2 only restarts processes on boot if both of these have been done:

```bash
npm run pm2:persist   # writes the systemd unit (needs sudo, prints what to run)
npm run pm2:save      # snapshots the current process list
```

`pm2:save` has to be re-run after adding or removing a process. The deploy
runs it every time, so this stays current on its own.

### The TLS certificate

Let's Encrypt via DNS-01 against DuckDNS, set up by
`scripts/setup-letsencrypt.sh`. Certbot's systemd timer renews it, and
`scripts/certbot-deploy-hook.sh` restarts PM2 so the new certificate is
picked up. Nothing to do — but to confirm it is still armed:

```bash
sudo certbot renew --dry-run
systemctl list-timers | grep certbot
```

Certificates last 90 days and renew at 30 days remaining.

### Working on the server by hand

The repo there stays on `main`, but `main` is moved to the released tag
rather than to whatever is at the head of the branch — so the server runs
exactly what was released, even if main has since moved on.

That means `git status` will often say *behind origin/main*, which is
correct and not a problem: those commits have not been released yet. A
`git pull --ff-only` fast-forwards to them if you really want the
unreleased code, and the next release puts it back on a tag.

### What will eventually need attention

- **The keystore** — back it up; everything Android depends on it
- **MongoDB Atlas** — a free-tier cluster pauses after inactivity
- **DuckDNS** — the token does not expire, but the subdomain lapses if
  nothing updates it for a long stretch
- **Google OAuth consent screen** — an app left in "Testing" expires its
  refresh tokens every 7 days, which silently breaks Gmail import.
  Publishing the app to "In production" stops that.

---

## Where the current state is

- Server runs whatever the last **successful** deploy built
- `npm run pm2:status` on the VPS is the authority on what is live
- `/api/health` returns the deployed version
- Settings in either app shows the version it is running
