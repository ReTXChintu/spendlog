import '../models/kid_models.dart';
import '../models/models.dart';
import 'api_client.dart';

/// Everything a kid's login can do, over the `/kid` routes. A kid's token
/// is refused everywhere else on the server, so nothing in the kid screens
/// calls any other endpoint.
class KidService {
  KidService._();
  static final KidService instance = KidService._();

  final ApiClient _api = ApiClient.instance;

  /// Signs in and stores the session. Throws [ApiException] with the
  /// server's own wording ("That email and password don't match.").
  Future<KidLogin> signIn(String email, String password) async {
    final result = await _api.post('/kid/login', {'email': email.trim(), 'password': password});
    final login = KidLogin.fromJson(result as Map<String, dynamic>);
    await ApiClient.setKidSession(login.token);
    return login;
  }

  Future<void> signOut() => ApiClient.clearKidSession();

  Future<KidProfile> me() async =>
      KidProfile.fromJson(await _api.get('/kid/me') as Map<String, dynamic>);

  Future<UserMonths> months() async =>
      UserMonths.fromJson(await _api.get('/kid/months') as Map<String, dynamic>);

  Future<KidTransactionPage> transactions({
    String? accountId,
    String? from,
    String? to,
    String? before,
    int days = 7,
  }) async {
    final query = <String, String>{
      if (accountId != null) 'accountId': accountId,
      if (from != null && from.isNotEmpty) 'from': from,
      if (to != null && to.isNotEmpty) 'to': to,
      if (before != null) 'before': before,
      'days': '$days',
    };
    final path = Uri(path: '/kid/transactions', queryParameters: query).toString();
    return KidTransactionPage.fromJson(await _api.get(path) as Map<String, dynamic>);
  }

  Future<Transaction> addTransaction(Map<String, dynamic> body) async =>
      Transaction.fromJson(await _api.post('/kid/transactions', body) as Map<String, dynamic>);

  Future<Transaction> updateTransaction(String id, Map<String, dynamic> body) async =>
      Transaction.fromJson(await _api.patch('/kid/transactions/$id', body) as Map<String, dynamic>);

  Future<List<Category>> categories() async => (await _api.get('/kid/categories') as List<dynamic>)
      .map((c) => Category.fromJson(c as Map<String, dynamic>))
      .toList();

  Future<List<MerchantPreset>> presets() async => (await _api.get('/kid/presets') as List<dynamic>)
      .map((p) => MerchantPreset.fromJson(p as Map<String, dynamic>))
      .toList();

  Future<MerchantPreset> addPreset(String merchant, String? categoryId) async => MerchantPreset.fromJson(
      await _api.post('/kid/presets', {'merchant': merchant, 'categoryId': categoryId}) as Map<String, dynamic>);

  Future<void> presetUsed(String id) async => _api.post('/kid/presets/$id/used');

  Future<void> deletePreset(String id) => _api.delete('/kid/presets/$id');

  Future<KidAnalytics> analytics({String? accountId, String? month}) async {
    final query = <String, String>{
      if (accountId != null) 'accountId': accountId,
      if (month != null && month.isNotEmpty) 'month': month,
    };
    final path = Uri(path: '/kid/analytics', queryParameters: query.isEmpty ? null : query).toString();
    return KidAnalytics.fromJson(await _api.get(path) as Map<String, dynamic>);
  }

  /// The server ends every other session and hands this phone a new token,
  /// which has to be kept or the next request is turned away.
  Future<void> changePassword(String current, String next) async {
    final result = await _api.post('/kid/password', {'currentPassword': current, 'newPassword': next});
    await ApiClient.setKidSession((result as Map<String, dynamic>)['token'] as String);
  }

  /// Asks the parent's phone to read new messages (at most once in ten
  /// minutes, the server decides).
  Future<KidRefreshResult> refresh() async =>
      KidRefreshResult.fromJson(await _api.post('/kid/refresh') as Map<String, dynamic>);
}
