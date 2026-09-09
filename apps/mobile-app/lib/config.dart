// Backend base URL. Supplied by `npm run dev` from MOBILE_API_URL in the
// repo-root .env as a --dart-define; the default covers running the app
// directly with `flutter run` (10.0.2.2 is the Android emulator's alias for
// the host machine's localhost — a physical device needs the LAN IP).
const String apiBaseUrl = String.fromEnvironment(
  'API_URL',
  defaultValue: 'http://10.0.2.2:4000',
);

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
