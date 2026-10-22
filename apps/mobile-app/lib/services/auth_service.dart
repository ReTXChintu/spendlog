import 'package:flutter/services.dart';
import 'package:flutter_appauth/flutter_appauth.dart';
import '../config.dart';
import 'api_client.dart';
import 'credential_store.dart';

/// A sign-in failure with something worth showing the user. The platform
/// errors underneath are codes and stack traces, which say nothing about
/// what to actually do.
class SignInException implements Exception {
  final String message;
  SignInException(this.message);

  @override
  String toString() => message;
}

/// The identity server, as far as the app needs it. Behind an interface so
/// tests can stand in for the browser tab AppAuth opens.
abstract class OidcAuthenticator {
  /// Runs the login and returns the ID token, or null if the person
  /// backed out. Throws [SignInException] for anything else.
  Future<String?> signIn();

  /// Ends the session at the identity server too.
  Future<void> endSession(String idTokenHint);
}

/// The real one: AppAuth in a Custom Tab, with PKCE, as the public
/// spendlog-mobile client. AppAuth does the code exchange itself and
/// checks the ID token's nonce; the backend checks the rest.
class AppAuthAuthenticator implements OidcAuthenticator {
  const AppAuthAuthenticator([this._appAuth = const FlutterAppAuth()]);

  final FlutterAppAuth _appAuth;

  // Plain http only for a local identity server in development.
  bool get _insecure => oidcIssuer.startsWith('http://');

  @override
  Future<String?> signIn() async {
    final AuthorizationTokenResponse response;
    try {
      response = await _appAuth.authorizeAndExchangeCode(AuthorizationTokenRequest(
        oidcClientId,
        oidcRedirectUri,
        issuer: oidcIssuer,
        scopes: oidcScopes,
        allowInsecureConnections: _insecure,
      ));
    } on FlutterAppAuthUserCancelledException {
      return null;
    } on PlatformException catch (e) {
      throw SignInException(_describe(e));
    }

    final idToken = response.idToken;
    if (idToken == null || idToken.isEmpty) {
      throw SignInException('The sign-in service did not say who you are. Please try again.');
    }
    return idToken;
  }

  @override
  Future<void> endSession(String idTokenHint) async {
    await _appAuth.endSession(EndSessionRequest(
      idTokenHint: idTokenHint,
      postLogoutRedirectUrl: oidcRedirectUri,
      issuer: oidcIssuer,
      allowInsecureConnections: _insecure,
    ));
  }

  String _describe(PlatformException e) {
    final detail = '${e.code} ${e.message ?? ''} ${e.details ?? ''}'.toLowerCase();
    if (detail.contains('network') || detail.contains('unable to resolve') || detail.contains('timeout')) {
      return "Couldn't reach the sign-in service. Check your internet and try again.";
    }
    if (detail.contains('discovery')) {
      return "The sign-in service at $oidcIssuer isn't answering. Try again in a minute.";
    }
    return 'Sign-in failed: ${e.message ?? e.code}'.trim();
  }
}

class AuthService {
  AuthService._();
  static final AuthService instance = AuthService._();

  /// Swapped in tests; the real one opens a browser tab.
  OidcAuthenticator authenticator = const AppAuthAuthenticator();

  Future<bool> isLoggedIn() async => (await ApiClient.getToken()) != null;

  /// Signs in at the identity server and trades its ID token with our
  /// backend for a SpendLog session. Returns true on success, false if the
  /// person cancelled.
  Future<bool> signIn() async {
    final idToken = await authenticator.signIn();
    if (idToken == null) return false;

    final Map<String, dynamic> result;
    try {
      result = await ApiClient.instance.post('/auth/oidc/mobile', {'idToken': idToken}) as Map<String, dynamic>;
    } on ApiException catch (e) {
      // 403 is SpendLog saying exactly why (a kid's email, an unverified
      // one); anything else is worth naming the server for, since this
      // app is sideloaded and there is no console to check.
      throw SignInException(
        e.statusCode == 403 ? e.message : 'You signed in, but SpendLog at $apiBaseUrl did not accept it: ${e.message}',
      );
    } catch (_) {
      throw SignInException("Couldn't reach SpendLog at $apiBaseUrl. Check your internet and try again.");
    }

    await ApiClient.setToken(result['token'] as String);
    await CredentialStore.instance.write(CredentialStore.idTokenKey, idToken);
    return true;
  }

  /// Signs this phone out, and the identity server too where it can. The
  /// phone is signed out first and regardless: failing to reach the
  /// identity server must never leave somebody stuck signed in.
  Future<void> signOut() async {
    final store = CredentialStore.instance;
    final idToken = await store.read(CredentialStore.idTokenKey);
    await store.delete(CredentialStore.idTokenKey);
    await ApiClient.clearToken();

    if (idToken == null) return;
    try {
      await authenticator.endSession(idToken);
    } catch (_) {
      // Local state is already gone; that is what signing out has to mean.
    }
  }
}
