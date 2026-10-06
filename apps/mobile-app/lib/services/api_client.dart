import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../config.dart';

const String _baseUrl = apiBaseUrl;
const String _tokenKey = tokenStorageKey;

class ApiException implements Exception {
  final int statusCode;
  final String message;
  ApiException(this.statusCode, this.message);

  @override
  String toString() => 'ApiException($statusCode): $message';
}

class ApiClient {
  ApiClient._();
  static final ApiClient instance = ApiClient._();

  static Future<String?> getToken() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_tokenKey);
  }

  static Future<void> setToken(String token) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_tokenKey, token);
    // One person per phone at a time: an owner signing in ends any kid's.
    await prefs.remove(_kidTokenKey);
    await prefs.remove(_roleKey);
  }

  static Future<void> clearToken() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_tokenKey);
  }

  // A kid's session lives under its own key, not tokenStorageKey: the
  // background SMS and reminder isolates read that key directly, so a kid's
  // phone leaves them with no token and nothing to send.
  static const _kidTokenKey = 'spendlog_kid_token';
  static const _roleKey = 'spendlog_role';

  /// Called once when a kid's session is refused (the parent reset the
  /// password, or removed the login), so the app can go back to sign-in.
  static void Function()? onKidSessionEnded;

  static Future<String?> getKidToken() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_kidTokenKey);
  }

  static Future<void> setKidSession(String token) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_tokenKey);
    await prefs.setString(_kidTokenKey, token);
    await prefs.setString(_roleKey, 'kid');
  }

  static Future<void> clearKidSession() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_kidTokenKey);
    await prefs.remove(_roleKey);
  }

  /// Whether this phone is signed in as a kid. Owner-only start-up work
  /// (SMS, reminders, Gmail, notifications) checks this before running.
  static Future<bool> isKidSession() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_roleKey) == 'kid' && prefs.getString(_kidTokenKey) != null;
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
    // A 401 from kid sign-in is a wrong password, not an ended session,
    // so it falls through to show the server's own message.
    if (res.statusCode == 401 && !path.endsWith('/kid/login')) {
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
      try {
        final body = jsonDecode(res.body);
        message = body['error']?.toString() ?? message;
      } catch (_) {}
      throw ApiException(res.statusCode, message);
    }
    if (res.body.isEmpty) return null;
    return jsonDecode(res.body);
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
