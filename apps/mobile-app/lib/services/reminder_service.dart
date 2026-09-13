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

const String _nagTask = 'spendlog-review-nag';

/// Notification ids. Fixed so that re-scheduling replaces rather than piles up.
const int _dailyNotificationId = 1;
const int _nagNotificationId = 2;

/// The hour the nagging is allowed to start.
const int _nagFromHour = 6;

/// Reminders to go back over yesterday's payments.
///
/// Two separate things, because they answer to different machinery. The
/// midnight nudge is a fixed time, so the notification plugin can schedule
/// it once and forget. The follow-ups have a condition attached — only if
/// something is still uncategorised — which needs waking up, asking the
/// server, and deciding, so that runs as a background task.
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

    await Workmanager().cancelByUniqueName(_nagTask);
    if (!enabled) {
      await prefs.setBool(_nagEnabledKey, false);
      await _plugin.cancel(id: _nagNotificationId);
      return false;
    }

    if (!await requestPermission()) {
      await prefs.setBool(_nagEnabledKey, false);
      return false;
    }
    await prefs.setBool(_nagEnabledKey, true);

    await Workmanager().registerPeriodicTask(
      _nagTask,
      _nagTask,
      frequency: const Duration(minutes: 30),
      existingWorkPolicy: ExistingPeriodicWorkPolicy.replace,
      constraints: Constraints(networkType: NetworkType.connected),
    );
    return true;
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
    return _remindIfAnythingIsUnfiled();
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
    final count = body['uncategorized'] as int? ?? 0;
    if (count == 0) {
      // Nothing left, so take the last reminder off the shade rather than
      // leaving a stale one sitting there.
      await FlutterLocalNotificationsPlugin().cancel(id: _nagNotificationId);
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
