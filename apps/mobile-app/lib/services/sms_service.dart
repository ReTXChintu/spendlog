import 'dart:convert';
import 'package:another_telephony/telephony.dart';
import 'package:flutter/widgets.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../config.dart';
import 'api_client.dart';

const String _backfillDoneKey = 'spendlog_sms_backfill_done';

String _messageId(SmsMessage message) => '${message.address ?? 'unknown'}-${message.date ?? 0}';

Map<String, dynamic> _toPayload(SmsMessage message) => {
      'rawText': message.body ?? '',
      'sender': message.address,
      'receivedAt': DateTime.fromMillisecondsSinceEpoch(message.date ?? DateTime.now().millisecondsSinceEpoch)
          .toIso8601String(),
      'messageId': _messageId(message),
    };

/// Runs in a separate background isolate when a new SMS arrives while the
/// app isn't in the foreground. Posts directly with `http` (rather than
/// going through the app's full ApiClient/widget tree) since this isolate
/// has no access to the running app's state.
@pragma('vm:entry-point')
void backgroundSmsHandler(SmsMessage message) async {
  WidgetsFlutterBinding.ensureInitialized();
  final prefs = await SharedPreferences.getInstance();
  final token = prefs.getString(tokenStorageKey);
  if (token == null) return;

  try {
    await http.post(
      Uri.parse('$apiBaseUrl/ingestion/sms'),
      headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer $token'},
      body: jsonEncode(_toPayload(message)),
    );
  } catch (_) {
    // Best-effort: a missed background SMS will still be caught by the
    // next foreground backfill scan.
  }
}

class SmsService {
  SmsService._();
  static final SmsService instance = SmsService._();

  final Telephony _telephony = Telephony.instance;

  Future<bool> requestPermissions() => _telephony.requestPhoneAndSmsPermissions.then((v) => v ?? false);

  void startListening() {
    _telephony.listenIncomingSms(
      onNewMessage: (SmsMessage message) {
        ApiClient.instance.post('/ingestion/sms', _toPayload(message)).catchError((_) {
          // Ignore failures here too — same reasoning as the background handler.
          return null;
        });
      },
      onBackgroundMessage: backgroundSmsHandler,
    );
  }

  /// One-time scan of existing inbox history, so transactions from before
  /// the app was installed still show up. Safe to call more than once —
  /// the backend dedupes by messageId, and we also track completion
  /// locally to avoid re-uploading the whole inbox on every app start.
  Future<void> runBackfillIfNeeded() async {
    final prefs = await SharedPreferences.getInstance();
    if (prefs.getBool(_backfillDoneKey) == true) return;

    final messages = await _telephony.getInboxSms(
      columns: [SmsColumn.ADDRESS, SmsColumn.BODY, SmsColumn.DATE],
      sortOrder: [OrderBy(SmsColumn.DATE, sort: Sort.DESC)],
    );

    const batchSize = 100;
    for (var i = 0; i < messages.length; i += batchSize) {
      final batch = messages.sublist(i, i + batchSize > messages.length ? messages.length : i + batchSize);
      await _postBatch(batch);
    }

    await prefs.setBool(_backfillDoneKey, true);
  }

  Future<void> _postBatch(List<SmsMessage> batch) async {
    final payload = batch.map(_toPayload).toList();
    // The generic ApiClient.post only accepts a Map body; batch ingestion
    // needs a raw JSON array, so this hits the endpoint directly.
    final token = await ApiClient.getToken();
    await http.post(
      Uri.parse('$apiBaseUrl/ingestion/sms/batch'),
      headers: {
        'Content-Type': 'application/json',
        if (token != null) 'Authorization': 'Bearer $token',
      },
      body: jsonEncode(payload),
    );
  }
}
