import 'dart:convert';
import 'package:http/http.dart' as http;
import '../config.dart';
import 'credential_store.dart';

const String _baseUrl = apiBaseUrl;

class ApiException implements Exception {
  final int statusCode;
  final String message;

  /// The decoded error body, when there was one, for the few replies that
  /// say more than a sentence - a debit card's passbook refusal names the
  /// bank account to open instead.
  final Object? body;
  ApiException(this.statusCode, this.message, [this.body]);

  @override
  String toString() => 'ApiException($statusCode): $message';
}

class ApiClient {
  ApiClient._();
  static final ApiClient instance = ApiClient._();

  static CredentialStore get _store => CredentialStore.instance;

  static Future<String?> getToken() => _store.ownerToken();

  static Future<void> setToken(String token) async {
    await _store.write(tokenStorageKey, token);
    // One person per phone at a time: an owner signing in ends any kid's.
    await clearKidSession();
  }

  static Future<void> clearToken() => _store.delete(tokenStorageKey);

  /// Called once when a kid's session is refused (the parent reset the
  /// password, or removed the login), so the app can go back to sign-in.
  static void Function()? onKidSessionEnded;

  static Future<String?> getKidToken() => _store.read(CredentialStore.kidTokenKey);

  static Future<void> setKidSession(String token) async {
    await clearToken();
    await _store.write(CredentialStore.kidTokenKey, token);
    await _store.write(CredentialStore.roleKey, 'kid');
  }

  static Future<void> clearKidSession() async {
    await _store.delete(CredentialStore.kidTokenKey);
    await _store.delete(CredentialStore.roleKey);
  }

  /// Whether this phone is signed in as a kid. Owner-only start-up work
  /// (SMS, reminders, Gmail, notifications) checks this before running.
  static Future<bool> isKidSession() async {
    return await _store.read(CredentialStore.roleKey) == 'kid' && await getKidToken() != null;
  }

  Future<Map<String, String>> _headers() async {
    final token = await getKidToken() ?? await getToken();
    return {
      'Content-Type': 'application/json',
      // The server only lets kids sign in from the phone app; harmless for owners.
      'x-spendlog-client': 'mobile',
      if (token != null) 'Authorization': 'Bearer $token',
    };
  }

  dynamic _decode(http.Response res) {
    final path = res.request?.url.path ?? '';
    // A 401 from kid sign-in is a wrong password, and one from owner
    // sign-in a token that did not check out - neither is an ended
    // session, so they fall through to show the server's own message.
    if (res.statusCode == 401 && !path.endsWith('/kid/login') && !path.endsWith('/auth/oidc/mobile')) {
      if (path.contains('/kid/')) {
        clearKidSession();
        final ended = onKidSessionEnded;
        onKidSessionEnded = null; // once, however many calls were in flight
        ended?.call();
      } else {
        clearToken();
      }
      throw ApiException(401, 'Session expired');
    }
    if (res.statusCode >= 400) {
      String message = res.reasonPhrase ?? 'Request failed';
      Object? body;
      try {
        body = jsonDecode(res.body);
        final error = (body as Map)['error'];
        message = (error is Map ? _validationMessage(error) : error?.toString()) ?? message;
      } catch (_) {}
      throw ApiException(res.statusCode, message, body);
    }
    if (res.body.isEmpty) return null;
    return jsonDecode(res.body);
  }

  /// The first sentence out of a rejected body's `{formErrors, fieldErrors}`
  /// (zod's flattened shape), rather than the map printed as text.
  static String? _validationMessage(Map error) {
    final form = error['formErrors'];
    if (form is List && form.isNotEmpty) return form.first.toString();
    final fields = error['fieldErrors'];
    if (fields is Map) {
      for (final entry in fields.entries) {
        final messages = entry.value;
        if (messages is List && messages.isNotEmpty) return '${entry.key}: ${messages.first}';
      }
    }
    return null;
  }

  Future<dynamic> get(String path) async {
    final res = await http.get(Uri.parse('$_baseUrl$path'), headers: await _headers());
    return _decode(res);
  }

  Future<dynamic> post(String path, [Map<String, dynamic>? body]) async {
    final res = await http.post(
      Uri.parse('$_baseUrl$path'),
      headers: await _headers(),
      body: body != null ? jsonEncode(body) : null,
    );
    return _decode(res);
  }

  Future<dynamic> patch(String path, [Map<String, dynamic>? body]) async {
    final res = await http.patch(
      Uri.parse('$_baseUrl$path'),
      headers: await _headers(),
      body: body != null ? jsonEncode(body) : null,
    );
    return _decode(res);
  }

  Future<dynamic> put(String path, [Map<String, dynamic>? body]) async {
    final res = await http.put(
      Uri.parse('$_baseUrl$path'),
      headers: await _headers(),
      body: body != null ? jsonEncode(body) : null,
    );
    return _decode(res);
  }

  /// A body is rare on a delete, but forgetting stored card details is a
  /// change the PIN has to cover, and the PIN travels in the body.
  Future<void> delete(String path, [Map<String, dynamic>? body]) async {
    final res = await http.delete(
      Uri.parse('$_baseUrl$path'),
      headers: await _headers(),
      body: body != null ? jsonEncode(body) : null,
    );
    _decode(res);
  }

  /// A file, rather than JSON.
  ///
  /// The session is a bearer token, so a statement PDF cannot simply be
  /// handed to a browser: it would arrive without one and be turned away.
  /// The bytes come back here and are written somewhere the system viewer
  /// can reach.
  Future<List<int>> bytes(String path) async {
    final token = await getToken();
    final res = await http.get(
      Uri.parse('$_baseUrl$path'),
      headers: {
        'x-spendlog-client': 'mobile',
        if (token != null) 'Authorization': 'Bearer $token',
      },
    );

    if (res.statusCode == 401) {
      clearToken();
      throw ApiException(401, 'Session expired');
    }
    if (res.statusCode >= 400) {
      String message = res.reasonPhrase ?? 'Request failed';
      try {
        message = (jsonDecode(res.body) as Map)['error']?.toString() ?? message;
      } catch (_) {}
      throw ApiException(res.statusCode, message);
    }

    return res.bodyBytes;
  }
}
