import 'package:google_sign_in/google_sign_in.dart';
import 'api_client.dart';

class AuthService {
  AuthService._();
  static final AuthService instance = AuthService._();

  // Gmail read access is requested in the same consent step as sign-in, so
  // there's no separate "connect Gmail" prompt later. serverClientId must
  // be the *web* OAuth client id — the backend exchanges serverAuthCode
  // with that client's secret to obtain a refresh token.
  final GoogleSignIn _googleSignIn = GoogleSignIn(
    scopes: const [
      'email',
      'profile',
      'https://www.googleapis.com/auth/gmail.readonly',
    ],
    serverClientId: const String.fromEnvironment('GOOGLE_WEB_CLIENT_ID'),
  );

  Future<bool> isLoggedIn() async => (await ApiClient.getToken()) != null;

  /// Signs in with Google and exchanges the result with our backend for a
  /// session JWT. Returns true on success, false if the user cancelled.
  Future<bool> signIn() async {
    final account = await _googleSignIn.signIn();
    if (account == null) return false; // user cancelled

    // Preferred: an auth code the backend can exchange for a refresh token,
    // which is what makes unattended email import possible. Falls back to
    // the ID token (identity only) if no code came back.
    final serverAuthCode = account.serverAuthCode;
    final body = <String, dynamic>{};

    if (serverAuthCode != null) {
      body['serverAuthCode'] = serverAuthCode;
    } else {
      final auth = await account.authentication;
      final idToken = auth.idToken;
      if (idToken == null) return false;
      body['idToken'] = idToken;
    }

    final result = await ApiClient.instance.post('/auth/google', body);
    await ApiClient.setToken(result['token'] as String);
    return true;
  }

  Future<void> signOut() async {
    await _googleSignIn.signOut();
    await ApiClient.clearToken();
  }
}
