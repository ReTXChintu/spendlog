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
