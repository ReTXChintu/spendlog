// A --dart-define that is present but empty is not the same as one that
// was never passed: String.fromEnvironment returns the empty string and
// defaultValue never applies. CI expands an unset secret to exactly that,
// so every define here is checked for emptiness rather than trusted.
const String _apiUrlDefine = String.fromEnvironment('API_URL');
const String _oidcIssuerDefine = String.fromEnvironment('OIDC_ISSUER');

// Backend base URL. Supplied by `npm run dev` from MOBILE_API_URL in the
// repo-root .env as a --dart-define; the default covers running the app
// directly with `flutter run` (10.0.2.2 is the Android emulator's alias for
// the host machine's localhost — a physical device needs the LAN IP).
const String apiBaseUrl =
    _apiUrlDefine.length == 0 ? 'http://10.0.2.2:4000' : _apiUrlDefine;

/// The identity server SpendLog, Trippin and InFrame share - the only way
/// an owner signs in. Built in with --dart-define=OIDC_ISSUER=...; CI passes
/// the OIDC_ISSUER repository secret and `npm run dev` the value in the
/// repo-root .env. Must be exactly the issuer the server's discovery
/// document names, with no trailing slash.
const String oidcIssuer =
    _oidcIssuerDefine.length == 0 ? 'https://pass-port.duckdns.org:50011' : _oidcIssuerDefine;

/// The phone app's client at the identity server: public, PKCE only.
const String oidcClientId = 'spendlog-mobile';

/// Where the identity server sends the browser back to. The scheme is the
/// app id, registered with AppAuth through `appAuthRedirectScheme` in
/// android/app/build.gradle.kts; the two have to agree.
const String oidcRedirectUri = 'io.github.retxchintu.spendlog:/oauth2redirect';

const List<String> oidcScopes = ['openid', 'email', 'profile', 'offline_access'];

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
