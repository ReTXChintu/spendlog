// A --dart-define that is present but empty is not the same as one that
// was never passed: String.fromEnvironment returns the empty string and
// defaultValue never applies. CI expands an unset secret to exactly that,
// so every define here is checked for emptiness rather than trusted.
const String _apiUrlDefine = String.fromEnvironment('API_URL');
const String _googleClientIdDefine = String.fromEnvironment('GOOGLE_WEB_CLIENT_ID');

// Backend base URL. Supplied by `npm run dev` from MOBILE_API_URL in the
// repo-root .env as a --dart-define; the default covers running the app
// directly with `flutter run` (10.0.2.2 is the Android emulator's alias for
// the host machine's localhost — a physical device needs the LAN IP).
const String apiBaseUrl =
    _apiUrlDefine.length == 0 ? 'http://10.0.2.2:4000' : _apiUrlDefine;

/// The *web* OAuth client id. The backend exchanges the auth code Google
/// returns using that client's secret, which is what yields a refresh token.
/// null when it wasn't built in, so sign-in can say so instead of failing
/// with an opaque platform error.
const String? googleWebClientId =
    _googleClientIdDefine.length == 0 ? null : _googleClientIdDefine;

// Key used for the stored session JWT in SharedPreferences. Declared here
// because the background SMS isolate reads it without going through
// ApiClient.
const String tokenStorageKey = 'spendlog_token';

/// Where the published APK can be downloaded.
///
/// The web app serves it next to itself and the mobile app reaches that
/// same host through its /api proxy, so the download URL is the API base
/// with the proxy path dropped. Set APK_URL at build time to override.
const String _apkUrlOverride = String.fromEnvironment('APK_URL');

String get apkDownloadUrl {
  if (_apkUrlOverride.isNotEmpty) return _apkUrlOverride;

  var base = apiBaseUrl;
  if (base.endsWith('/')) base = base.substring(0, base.length - 1);
  if (base.endsWith('/api')) base = base.substring(0, base.length - 4);
  return '$base/SpendLog.apk';
}
