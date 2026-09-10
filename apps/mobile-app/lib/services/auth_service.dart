import 'package:flutter/services.dart';
import 'package:google_sign_in/google_sign_in.dart';
import '../config.dart';
import 'api_client.dart';

/// A sign-in failure with something worth showing the user. The platform
/// errors underneath are codes like "sign_in_failed ... ApiException: 10",
/// which say nothing about what to actually do.
class SignInException implements Exception {
  final String message;
  SignInException(this.message);

  @override
  String toString() => message;
}

class AuthService {
  AuthService._();
  static final AuthService instance = AuthService._();

  // Gmail read access is requested in the same consent step as sign-in, so
  // there's no separate "connect Gmail" prompt later. serverClientId is the
  // *web* OAuth client id; see config.dart.
  final GoogleSignIn _googleSignIn = GoogleSignIn(
    scopes: const [
      'email',
      'profile',
      'https://www.googleapis.com/auth/gmail.readonly',
    ],
    serverClientId: googleWebClientId,
  );

  Future<bool> isLoggedIn() async => (await ApiClient.getToken()) != null;

  /// Signs in with Google and exchanges the result with our backend for a
  /// session JWT. Returns true on success, false if the user cancelled.
  Future<bool> signIn() async {
    if (googleWebClientId == null) {
      throw SignInException(
        'This build has no Google client id in it, so it cannot sign in. '
        'It was built without GOOGLE_WEB_CLIENT_ID set.',
      );
    }

    final GoogleSignInAccount? account;
    try {
      account = await _googleSignIn.signIn();
    } on PlatformException catch (e) {
      throw SignInException(_describePlatformError(e));
    }
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

    try {
      final result = await ApiClient.instance.post('/auth/google', body);
      await ApiClient.setToken(result['token'] as String);
    } catch (e) {
      throw SignInException('Google accepted the sign-in but $apiBaseUrl did not: $e');
    }
    return true;
  }

  /// Turns the Play Services error codes into something a person can act on.
  String _describePlatformError(PlatformException e) {
    final detail = '${e.message ?? ''} ${e.details ?? ''}';

    // ApiException 10 is DEVELOPER_ERROR: the certificate this APK is
    // signed with, paired with its package name, is not registered as an
    // Android OAuth client in the Google Cloud project.
    if (detail.contains('10:') || detail.contains('ApiException: 10')) {
      return "Google rejected this build's signature. Its signing certificate "
          'and package name have to be registered as an Android OAuth client.';
    }
    if (detail.contains('12501')) return 'Sign-in was cancelled.';
    if (detail.contains('7:') || detail.contains('NETWORK_ERROR')) {
      return 'No connection to Google. Check your internet and try again.';
    }
    return 'Google sign-in failed: ${e.code} ${e.message ?? ''}'.trim();
  }

  Future<void> signOut() async {
    await _googleSignIn.signOut();
    await ApiClient.clearToken();
  }
}
