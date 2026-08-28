import 'package:google_sign_in/google_sign_in.dart';
import 'api_client.dart';

class AuthService {
  AuthService._();
  static final AuthService instance = AuthService._();

  final GoogleSignIn _googleSignIn = GoogleSignIn(scopes: ['email']);

  Future<bool> isLoggedIn() async => (await ApiClient.getToken()) != null;

  /// Signs in with Google, exchanges the ID token with our backend for a
  /// session JWT, and stores it. Returns true on success.
  Future<bool> signIn() async {
    final account = await _googleSignIn.signIn();
    if (account == null) return false; // user cancelled

    final auth = await account.authentication;
    final idToken = auth.idToken;
    if (idToken == null) return false;

    final result = await ApiClient.instance.post('/auth/google', {'idToken': idToken});
    final token = result['token'] as String;
    await ApiClient.setToken(token);
    return true;
  }

  Future<void> signOut() async {
    await _googleSignIn.signOut();
    await ApiClient.clearToken();
  }
}
