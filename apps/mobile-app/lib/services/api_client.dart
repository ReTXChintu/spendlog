import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

// A real device can't reach "localhost" on your dev machine — point this at
// your machine's LAN IP, or pass --dart-define=API_URL=http://192.168.x.x:4000.
const String _baseUrl = String.fromEnvironment('API_URL', defaultValue: 'http://10.0.2.2:4000');
const String _tokenKey = 'expense_tracker_token';

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
  }

  static Future<void> clearToken() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_tokenKey);
  }

  Future<Map<String, String>> _headers() async {
    final token = await getToken();
    return {
      'Content-Type': 'application/json',
      if (token != null) 'Authorization': 'Bearer $token',
    };
  }

  dynamic _decode(http.Response res) {
    if (res.statusCode == 401) {
      clearToken();
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

  Future<void> delete(String path) async {
    final res = await http.delete(Uri.parse('$_baseUrl$path'), headers: await _headers());
    _decode(res);
  }
}
