import 'dart:convert';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
// 10 years is the small build of the database. Only one zone is ever
// looked up and it is parsed on the way to the first frame, so the full
// 1.9MB of every zone back to 1900 is not worth the startup cost.
import 'package:timezone/data/latest_10y.dart' as tz_data;
import 'package:timezone/timezone.dart' as tz;
import 'package:workmanager/workmanager.dart';
import '../config.dart';

const String _dailyEnabledKey = 'spendlog_reminder_daily';
const String _nagEnabledKey = 'spendlog_reminder_nag';
const String _billsEnabledKey = 'spendlog_reminder_bills';

/// The bills already told about, so a bill is announced once rather than
/// every half hour until it is paid.
const String _billsSeenKey = 'spendlog_reminder_bills_seen';

const String _nagTask = 'spendlog-review-nag';

/// Notification ids. Fixed so that re-scheduling replaces rather than piles up.
const int _dailyNotificationId = 1;
const int _nagNotificationId = 2;
const int _billNotificationId = 3;

/// The hours the nagging runs between.
const int _nagFromHour = 6;
const int _nagUntilHour = 22;

/// One notification id per half-hour slot, from 06:00 to 22:00. Fixed and
/// contiguous so the whole day can be armed and cancelled as a block.
const int _nagSlotBaseId = 100;

/// When the background task last managed to run, so "it is not working"
/// can be answered with a time instead of a shrug.
const String _nagLastRunKey = 'spendlog_reminder_nag_last_run';

/// Reminders to go back over yesterday's payments.
///
/// The midnight nudge is a fixed time, so the notification plugin
/// schedules it once and forgets. The follow-ups have a condition attached
/// — only while something is still uncategorised — which is why they were
/// a background task asking the server every half hour.
///
/// That did not fire. WorkManager's periodic work is advisory on Android:
/// Doze defers it, and most OEM battery managers stop it outright once the
/// app has been in the background for a while. The midnight reminder kept
/// working throughout, because an alarm is not the same machinery.
///
/// So the follow-ups are alarms now too — one per half-hour slot, repeating
/// daily — and the condition moved to where it can actually be evaluated:
/// the app arms the day's slots when it sees something uncategorised and
/// cancels them when it sees nothing. Since categorising happens in the
/// app, the nagging stops within a moment of the work being done. The
/// background task is still registered and still preferred when it runs,
/// because it can be precise about the count; it is no longer relied on.
class ReminderService {
  ReminderService._();
  static final ReminderService instance = ReminderService._();

  final FlutterLocalNotificationsPlugin _plugin = FlutterLocalNotificationsPlugin();
  bool _ready = false;

  Future<void> init() async {
    if (_ready) return;

    tz_data.initializeTimeZones();
    // Fixed rather than read from the device: every date in SpendLog is
    // IST, and a reminder about "yesterday" has to mean the same day the
    // ledger does.
    tz.setLocalLocation(tz.getLocation('Asia/Kolkata'));

    await _plugin.initialize(
      settings: const InitializationSettings(
        android: AndroidInitializationSettings('@mipmap/ic_launcher'),
      ),
    );

    await Workmanager().initialize(reminderTaskDispatcher);
    _ready = true;
  }

  /// Below Android 13 this reports whether notifications are switched on
  /// for the app rather than prompting, which is the answer that matters
  /// either way: can a reminder actually appear.
  Future<bool> requestPermission() async {
    await init();
    try {
      final android = _plugin
          .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
      return await android?.requestNotificationsPermission() ?? false;
    } catch (_) {
      // Another request is already in flight; treat it as a no for now.
      return false;
    }
  }

  Future<bool> dailyEnabled() async =>
      (await SharedPreferences.getInstance()).getBool(_dailyEnabledKey) ?? false;

  Future<bool> nagEnabled() async =>
      (await SharedPreferences.getInstance()).getBool(_nagEnabledKey) ?? false;

  /// The midnight nudge: yesterday is over, go and label it.
  ///
  /// Returns whether it is actually armed — false means the permission was
  /// refused, so the caller should not leave a switch showing "on".
  Future<bool> setDailyEnabled(bool enabled) async {
    await init();
    final prefs = await SharedPreferences.getInstance();

    if (!enabled) {
      await prefs.setBool(_dailyEnabledKey, false);
      await _plugin.cancel(id: _dailyNotificationId);
      return false;
    }

    if (!await requestPermission()) {
      await prefs.setBool(_dailyEnabledKey, false);
      return false;
    }
    await prefs.setBool(_dailyEnabledKey, true);

    await _plugin.zonedSchedule(
      id: _dailyNotificationId,
      title: 'Yesterday is done',
      body: 'Add the notes and categories while you still remember what they were.',
      scheduledDate: _nextMidnight(),
      notificationDetails: const NotificationDetails(
        android: AndroidNotificationDetails(
          'spendlog-daily',
          'Daily reminder',
          channelDescription: 'A nudge at midnight to go back over the day just finished.',
          importance: Importance.defaultImportance,
        ),
      ),
      // Inexact on purpose: an exact alarm needs a permission Android 12
      // makes people grant by hand, and a reminder that lands at ten past
      // midnight is the same reminder.
      androidScheduleMode: AndroidScheduleMode.inexactAllowWhileIdle,
      matchDateTimeComponents: DateTimeComponents.time,
    );
    return true;
  }

  /// The follow-ups, which only fire while there is something left to do.
  Future<bool> setNagEnabled(bool enabled) async {
    await init();
    final prefs = await SharedPreferences.getInstance();

    if (!enabled) {
      await prefs.setBool(_nagEnabledKey, false);
      await _plugin.cancel(id: _nagNotificationId);
      await _disarmSlots();
      await _rescheduleBackgroundTask();
      return false;
    }

    if (!await requestPermission()) {
      await prefs.setBool(_nagEnabledKey, false);
      return false;
    }
    await prefs.setBool(_nagEnabledKey, true);
    await _rescheduleBackgroundTask();
    return true;
  }

  /// Arm or disarm the day's follow-ups from a count the app already has.
  ///
  /// Called wherever the number of uncategorised payments becomes known —
  /// which is every time the dashboard loads, so in practice every time
  /// the app is opened or pulled to refresh. That is what keeps the
  /// nagging honest without a background task: the moment the last one is
  /// categorised, the app is by definition open, and the rest of the day's
  /// slots come off.
  Future<void> updateFollowUps(int uncategorised) async {
    final prefs = await SharedPreferences.getInstance();
    if (!(prefs.getBool(_nagEnabledKey) ?? false)) return;

    await init();

    if (uncategorised == 0) {
      await _plugin.cancel(id: _nagNotificationId);
      await _disarmSlots();
      return;
    }

    await _armSlots();
  }

  /// Every half hour from 06:00 to 22:00, repeating daily.
  ///
  /// No count in the wording. It is fixed at the moment of arming and
  /// would be stale the moment anything was categorised, and a reminder
  /// that says the wrong number is worse than one that says none.
  Future<void> _armSlots() async {
    for (final (index, slot) in _slots().indexed) {
      await _plugin.zonedSchedule(
        id: _nagSlotBaseId + index,
        title: 'Yesterday still needs categories',
        body: 'They stay uncategorised until you say what they were.',
        scheduledDate: slot,
        notificationDetails: const NotificationDetails(
          android: AndroidNotificationDetails(
            'spendlog-review',
            'Still to categorise',
            channelDescription:
                'Repeats through the day while yesterday still has uncategorised payments.',
            importance: Importance.defaultImportance,
          ),
        ),
        androidScheduleMode: AndroidScheduleMode.inexactAllowWhileIdle,
        matchDateTimeComponents: DateTimeComponents.time,
      );
    }
  }

  Future<void> _disarmSlots() async {
    for (var index = 0; index < _slotCount; index += 1) {
      await _plugin.cancel(id: _nagSlotBaseId + index);
    }
  }

  /// When the background task last ran, for the settings screen to show.
  /// Null means it has never managed to - which is the answer on a phone
  /// whose battery manager stops it, and worth saying out loud.
  Future<DateTime?> followUpsLastRan() async {
    final raw = (await SharedPreferences.getInstance()).getString(_nagLastRunKey);
    return raw == null ? null : DateTime.tryParse(raw);
  }

  Future<bool> billsEnabled() async =>
      (await SharedPreferences.getInstance()).getBool(_billsEnabledKey) ?? false;

  /// Said once per statement, so it shares the half-hourly task the
  /// follow-ups already use rather than scheduling one of its own.
  Future<bool> setBillsEnabled(bool enabled) async {
    await init();
    final prefs = await SharedPreferences.getInstance();

    if (!enabled) {
      await prefs.setBool(_billsEnabledKey, false);
      await _plugin.cancel(id: _billNotificationId);
      await _rescheduleBackgroundTask();
      return false;
    }

    if (!await requestPermission()) {
      await prefs.setBool(_billsEnabledKey, false);
      return false;
    }
    await prefs.setBool(_billsEnabledKey, true);
    await _rescheduleBackgroundTask();
    return true;
  }

  /// The one periodic task both background reminders run off. Registered
  /// while either wants it and cancelled once neither does, so nothing
  /// wakes up to ask questions nobody is listening for.
  Future<void> _rescheduleBackgroundTask() async {
    final prefs = await SharedPreferences.getInstance();
    final wanted = (prefs.getBool(_nagEnabledKey) ?? false) || (prefs.getBool(_billsEnabledKey) ?? false);

    await Workmanager().cancelByUniqueName(_nagTask);
    if (!wanted) return;

    await Workmanager().registerPeriodicTask(
      _nagTask,
      _nagTask,
      frequency: const Duration(minutes: 30),
      existingWorkPolicy: ExistingPeriodicWorkPolicy.replace,
      constraints: Constraints(networkType: NetworkType.connected),
    );
  }

  /// How many half-hour slots there are between the two hours.
  static int get _slotCount => (_nagUntilHour - _nagFromHour) * 2 + 1;

  /// The next occurrence of each slot. Each repeats daily from there, so
  /// one that has already gone past today is scheduled for tomorrow and
  /// then keeps its place.
  static Iterable<tz.TZDateTime> _slots() sync* {
    final now = tz.TZDateTime.now(tz.local);

    for (var index = 0; index < _slotCount; index += 1) {
      final hour = _nagFromHour + index ~/ 2;
      final minute = index.isEven ? 0 : 30;

      final today = tz.TZDateTime(tz.local, now.year, now.month, now.day, hour, minute);
      yield today.isAfter(now) ? today : today.add(const Duration(days: 1));
    }
  }

  static tz.TZDateTime _nextMidnight() {
    final now = tz.TZDateTime.now(tz.local);
    final todayMidnight = tz.TZDateTime(tz.local, now.year, now.month, now.day);
    return todayMidnight.isAfter(now) ? todayMidnight : todayMidnight.add(const Duration(days: 1));
  }
}

/// Runs in its own isolate, so it shares nothing with the app and has to
/// fetch what it needs itself.
@pragma('vm:entry-point')
void reminderTaskDispatcher() {
  Workmanager().executeTask((task, _) async {
    if (task != _nagTask) return true;

    // Both run off the one periodic task rather than two: waking twice as
    // often to ask two questions costs the same battery and twice the
    // scheduling.
    final unfiled = await _remindIfAnythingIsUnfiled();
    final bills = await _tellAboutNewBills();
    return unfiled && bills;
  });
}

Future<bool> _remindIfAnythingIsUnfiled() async {
  final prefs = await SharedPreferences.getInstance();
  if (!(prefs.getBool(_nagEnabledKey) ?? false)) return true;

  final token = prefs.getString(tokenStorageKey);
  if (token == null) return true;

  final now = DateTime.now().toUtc().add(const Duration(hours: 5, minutes: 30));
  // Quiet until the morning. There is no upper bound because none is
  // needed: at midnight "yesterday" becomes the day before, which nobody
  // is being asked about, so this stops on its own overnight.
  if (now.hour < _nagFromHour) return true;

  try {
    final response = await http.get(
      Uri.parse('$apiBaseUrl/transactions/review'),
      headers: {'Authorization': 'Bearer $token'},
    ).timeout(const Duration(seconds: 10));
    if (response.statusCode != 200) return true;

    final body = jsonDecode(response.body) as Map<String, dynamic>;
    await prefs.setString(_nagLastRunKey, DateTime.now().toIso8601String());

    final count = body['uncategorized'] as int? ?? 0;
    if (count == 0) {
      // Nothing left, so take the last reminder off the shade rather than
      // leaving a stale one sitting there - and with it the rest of the
      // day's slots, which would otherwise keep asking.
      await FlutterLocalNotificationsPlugin().cancel(id: _nagNotificationId);
      for (var index = 0; index < ReminderService._slotCount; index += 1) {
        await FlutterLocalNotificationsPlugin().cancel(id: _nagSlotBaseId + index);
      }
      return true;
    }

    final plugin = FlutterLocalNotificationsPlugin();
    await plugin.initialize(
      settings: const InitializationSettings(
        android: AndroidInitializationSettings('@mipmap/ic_launcher'),
      ),
    );
    await plugin.show(
      id: _nagNotificationId,
      title: '$count from yesterday still ${count == 1 ? 'needs' : 'need'} a category',
      body: 'They stay uncategorised until you say what they were.',
      notificationDetails: const NotificationDetails(
        android: AndroidNotificationDetails(
          'spendlog-review',
          'Still to categorise',
          channelDescription:
              'Repeats through the day while yesterday still has uncategorised payments.',
          importance: Importance.defaultImportance,
        ),
      ),
    );
  } catch (_) {
    // Offline, or the server is down. Nothing worth waking anyone for.
  }

  return true;
}

/// Tell someone a bill has been read, once.
///
/// A statement is the first moment the app can know what a bill actually
/// is, rather than estimating it from the transactions it happened to see -
/// so it is the moment worth saying so, and saying so once. The ids already
/// announced are remembered, because a reminder that repeats every half
/// hour until the bill is paid is not a reminder, it is a nuisance, and the
/// dashboard already carries it for as long as it is owed.
Future<bool> _tellAboutNewBills() async {
  final prefs = await SharedPreferences.getInstance();
  if (!(prefs.getBool(_billsEnabledKey) ?? false)) return true;

  final token = prefs.getString(tokenStorageKey);
  if (token == null) return true;

  try {
    final response = await http.get(
      Uri.parse('$apiBaseUrl/statements/bills'),
      headers: {'Authorization': 'Bearer $token'},
    ).timeout(const Duration(seconds: 10));
    if (response.statusCode != 200) return true;

    final bills = (jsonDecode(response.body) as List<dynamic>)
        .cast<Map<String, dynamic>>()
        .where((bill) => bill['isPaid'] != true)
        .toList();

    final seen = prefs.getStringList(_billsSeenKey) ?? <String>[];
    final fresh = bills.where((bill) => !seen.contains(bill['statementId'] as String)).toList();

    // Kept to the bills that still exist, so the list cannot grow for ever
    // and a statement read again is announced again.
    await prefs.setStringList(
      _billsSeenKey,
      bills.map((bill) => bill['statementId'] as String).toList(),
    );

    if (fresh.isEmpty) return true;

    final bill = fresh.first;
    final amount = ((bill['totalDueMinor'] as int? ?? 0) / 100).round();
    final card = bill['cardName'] as String? ?? 'a card';
    final days = bill['daysUntilDue'] as int?;

    final plugin = FlutterLocalNotificationsPlugin();
    await plugin.initialize(
      settings: const InitializationSettings(
        android: AndroidInitializationSettings('@mipmap/ic_launcher'),
      ),
    );
    await plugin.show(
      id: _billNotificationId,
      title: fresh.length == 1
          ? '$card bill: ₹$amount'
          : '${fresh.length} card bills have arrived',
      body: fresh.length == 1
          ? (days == null
              ? 'Read from the statement that just came in.'
              : days < 0
                  ? 'It was due ${days.abs()} days ago.'
                  : days == 0
                      ? 'It is due today.'
                      : 'Due in $days days.')
          : 'Read from the statements that just came in.',
      notificationDetails: const NotificationDetails(
        android: AndroidNotificationDetails(
          'spendlog-bills',
          'Card bills',
          channelDescription: 'Said once, when a statement shows what a bill has come to.',
          importance: Importance.defaultImportance,
        ),
      ),
    );
  } catch (_) {
    // Offline, or the server is down. Nothing worth waking anyone for.
  }

  return true;
}
