import 'dart:convert';
import 'package:another_telephony/telephony.dart';
import 'package:flutter/widgets.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../config.dart';
import 'api_client.dart';

const String _backfillDoneKey = 'spendlog_sms_backfill_done';
const String _permissionGrantedKey = 'spendlog_sms_permission_granted';
const String _lastSyncKey = 'spendlog_sms_last_sync';

/// How far back a manual sync looks when it has nothing better to go on.
/// Only reached if the stored timestamp is missing, since the first-run
/// backfill already covers everything older.
const Duration _defaultSyncWindow = Duration(days: 30);

/// What a manual sync did, so Settings can say something specific rather
/// than just "done".
class SmsSyncResult {
  final int scanned;
  final int created;
  final int duplicates;
  final int ignored;

  const SmsSyncResult({
    required this.scanned,
    required this.created,
    required this.duplicates,
    required this.ignored,
  });

  /// Messages that were already known — the normal case when the automatic
  /// capture is working.
  bool get foundNothingNew => created == 0;
}

String _messageId(SmsMessage message) => '${message.address ?? 'unknown'}-${message.date ?? 0}';

/// Whether there is anything worth sending. An inbox holds plenty that is
/// not a bank alert, and an empty body cannot be parsed into anything.
bool _isSendable(SmsMessage message) => (message.body ?? '').trim().isNotEmpty;

Map<String, dynamic> _toPayload(SmsMessage message) => {
      'rawText': message.body ?? '',
      if (message.address != null) 'sender': message.address,
      // .toUtc() matters: fromMillisecondsSinceEpoch returns a *local*
      // DateTime, and Dart omits the timezone when serialising one, so the
      // server had no way to know what instant was meant.
      'receivedAt': DateTime.fromMillisecondsSinceEpoch(message.date ?? DateTime.now().millisecondsSinceEpoch)
          .toUtc()
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
  if (!_isSendable(message)) return;

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

  Future<bool> requestPermissions() async {
    final granted = await _telephony.requestPhoneAndSmsPermissions ?? false;
    // Remembered so Settings can show the status without re-prompting.
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_permissionGrantedKey, granted);
    return granted;
  }

  /// Whether SMS access was granted, for the Settings status pill. Reads the
  /// remembered answer rather than asking, so opening Settings never triggers
  /// a system dialog.
  Future<bool> hasPermission() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getBool(_permissionGrantedKey) ?? false;
  }

  void startListening() {
    _telephony.listenIncomingSms(
      onNewMessage: (SmsMessage message) {
        if (!_isSendable(message)) return;
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

    final messages = (await _telephony.getInboxSms(
      columns: [SmsColumn.ADDRESS, SmsColumn.BODY, SmsColumn.DATE],
      sortOrder: [OrderBy(SmsColumn.DATE, sort: Sort.DESC)],
    ))
        .where(_isSendable)
        .toList();

    // Only flagged as done once every batch has landed. It used to be set
    // regardless, so a first run that failed was never retried and the
    // whole history was lost with it.
    const batchSize = 100;
    for (var i = 0; i < messages.length; i += batchSize) {
      final batch = messages.sublist(i, i + batchSize > messages.length ? messages.length : i + batchSize);
      await _postBatch(batch);
    }

    await prefs.setBool(_backfillDoneKey, true);
    // The whole inbox has just been covered, so a later manual sync only
    // has to look at what arrives from here on.
    await prefs.setInt(_lastSyncKey, DateTime.now().millisecondsSinceEpoch);
  }

  /// When the last manual sync finished, for the Settings card.
  Future<DateTime?> lastSyncedAt() async {
    final prefs = await SharedPreferences.getInstance();
    final millis = prefs.getInt(_lastSyncKey);
    return millis == null ? null : DateTime.fromMillisecondsSinceEpoch(millis);
  }

  /// Re-reads recent messages and uploads them, for when the automatic
  /// capture missed something — the phone was off, the app was killed
  /// mid-delivery, or the request failed while offline.
  ///
  /// Only messages since the last sync are read, so this stays quick on a
  /// busy inbox. Re-uploading is harmless anyway: the backend dedupes on
  /// messageId, which is why this can be pressed as often as you like.
  Future<SmsSyncResult> syncNow() async {
    final prefs = await SharedPreferences.getInstance();
    final since = prefs.getInt(_lastSyncKey) ??
        DateTime.now().subtract(_defaultSyncWindow).millisecondsSinceEpoch;

    final messages = await _telephony.getInboxSms(
      columns: [SmsColumn.ADDRESS, SmsColumn.BODY, SmsColumn.DATE],
      // A little overlap rather than an exact boundary, so a message that
      // arrived during the previous sync cannot fall between two windows.
      filter: SmsFilter.where(SmsColumn.DATE)
          .greaterThan((since - const Duration(minutes: 5).inMilliseconds).toString()),
      sortOrder: [OrderBy(SmsColumn.DATE, sort: Sort.DESC)],
    );
    final sendable = messages.where(_isSendable).toList();

    var created = 0;
    var duplicates = 0;
    var ignored = 0;

    const batchSize = 100;
    for (var i = 0; i < sendable.length; i += batchSize) {
      final end = i + batchSize > sendable.length ? sendable.length : i + batchSize;
      final counts = await _postBatch(sendable.sublist(i, end));
      created += counts.created;
      duplicates += counts.duplicates;
      ignored += counts.ignored;
    }

    // Only recorded on success, so a failed sync re-covers the same window
    // next time instead of skipping past it.
    await prefs.setInt(_lastSyncKey, DateTime.now().millisecondsSinceEpoch);

    return SmsSyncResult(
      scanned: sendable.length,
      created: created,
      duplicates: duplicates,
      ignored: ignored,
    );
  }

  Future<SmsSyncResult> _postBatch(List<SmsMessage> batch) async {
    if (batch.isEmpty) {
      return const SmsSyncResult(scanned: 0, created: 0, duplicates: 0, ignored: 0);
    }

    final payload = batch.map(_toPayload).toList();
    // The generic ApiClient.post only accepts a Map body; batch ingestion
    // needs a raw JSON array, so this hits the endpoint directly.
    final token = await ApiClient.getToken();
    final res = await http.post(
      Uri.parse('$apiBaseUrl/ingestion/sms/batch'),
      headers: {
        'Content-Type': 'application/json',
        if (token != null) 'Authorization': 'Bearer $token',
      },
      body: jsonEncode(payload),
    );

    if (res.statusCode >= 400) {
      throw Exception('The server rejected the batch (${res.statusCode}).');
    }

    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return SmsSyncResult(
      scanned: batch.length,
      created: body['created'] as int? ?? 0,
      duplicates: body['duplicates'] as int? ?? 0,
      ignored: body['ignored'] as int? ?? 0,
    );
  }
}
