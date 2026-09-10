# Signing the Android app

Every SpendLog release has to be signed with the **same** certificate,
forever. Two things depend on it:

- **Google Sign-In.** Google identifies the app by its package name paired
  with the SHA-1 of its signing certificate. That pair is registered once as
  an Android OAuth client; an APK signed with anything else is rejected with
  `ApiException: 10` (`DEVELOPER_ERROR`), which the app surfaces as *"Google
  rejected this build's signature"*.
- **Updates.** Android refuses to install an APK over one signed by a
  different key. A phone would have to uninstall SpendLog — losing its
  stored session — before every update.

Flutter's generated project signs release builds with the *debug* key, which
is whatever `~/.android/debug.keystore` the build machine happens to hold. A
CI runner creates that file fresh on every run, so every build came out with
a different certificate. That is why sign-in failed in the published APK.

## One-time setup

### 1. Create the keystore

Keep the generated file. If it is lost, no future build can update an
installed SpendLog, and the OAuth client has to be re-registered.

```bash
keytool -genkeypair -v \
  -keystore spendlog-release.jks \
  -storetype PKCS12 \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -alias spendlog
```

It asks for a password and a name; the name is only shown in certificate
details. Use the same password for the store and the key — the tooling below
assumes that, and Google never sees either.

### 2. Read its SHA-1

```bash
keytool -list -v -keystore spendlog-release.jks -alias spendlog | grep SHA1
```

### 3. Register it with Google

In the [Google Cloud console](https://console.cloud.google.com/apis/credentials),
in the same project as the existing web client:

**Create credentials → OAuth client ID → Android**

- **Package name** — the `applicationId` in
  `apps/mobile-app/android/app/build.gradle.kts`
- **SHA-1 certificate fingerprint** — from step 2

No client id from this goes into the app. Its only job is to tell Google
that this package, signed with this certificate, is allowed to sign in. The
app keeps using the *web* client id (`GOOGLE_WEB_CLIENT_ID`), because the
backend exchanges the returned auth code with that client's secret.

### 4. Add the CI secrets

`base64 -w0 spendlog-release.jks` (on macOS: `base64 -i spendlog-release.jks`)
gives the value for the first one. In **Settings → Secrets and variables →
Actions**:

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | the base64 of `spendlog-release.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | the store password |
| `ANDROID_KEY_ALIAS` | `spendlog` |
| `ANDROID_KEY_PASSWORD` | the key password |

The release workflow fails early if any of these — or `MOBILE_API_URL` and
`GOOGLE_CLIENT_ID` — are missing, rather than publishing an APK that cannot
sign in.

## Building a signed release locally

Gradle reads the same four values from the environment:

```bash
ANDROID_KEYSTORE_PATH=/path/to/spendlog-release.jks \
ANDROID_KEYSTORE_PASSWORD=... \
ANDROID_KEY_ALIAS=spendlog \
ANDROID_KEY_PASSWORD=... \
flutter build apk --release
```

Without them the build still works and falls back to the debug key, with a
warning. That build is fine for checking layout on a device, but sign-in
will not work in it.

## Checking what an APK is signed with

`keytool -printcert -jarfile` reads only v1 (JAR) signatures, and these APKs
are signed with scheme v2/v3 only, so it reports *"Not a signed jar file"*.
Use `apksigner` from the Android SDK build-tools:

```bash
apksigner verify --print-certs app-release.apk
```

The release workflow prints this for every build, so the SHA-1 of any
published APK can be read out of its job log.
