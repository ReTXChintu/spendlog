import 'package:shared_preferences/shared_preferences.dart';
import '../models/models.dart';
import 'api_client.dart';
import 'reminder_service.dart';

const String _enabledKey = 'spendlog_other_paid_enabled';
const String _hourKey = 'spendlog_other_paid_hour';
const String _minuteKey = 'spendlog_other_paid_minute';
const String _groupIdKey = 'spendlog_other_paid_group';
const String _groupNameKey = 'spendlog_other_paid_group_name';
const String _answeredKey = 'spendlog_other_paid_answered';

/// Where the evening check stands: on or off, when, and for which group.
class OtherPaidSettings {
  final bool enabled;
  final int hour;
  final int minute;
  final String? groupId;
  final String? groupName;

  const OtherPaidSettings({
    this.enabled = true,
    this.hour = 21,
    this.minute = 0,
    this.groupId,
    this.groupName,
  });

  bool get hasGroup => groupId != null && groupName != null;
}

/// "Did anyone in Flatmates pay for something today?" - every evening.
///
/// A payment a flatmate made never reaches the user's bank messages, so
/// it is only in SpendLog if somebody types it, and the split is wrong
/// every time they forget. So each evening a notification asks, and a card
/// on Home keeps asking until today is answered: a payment added, or
/// "nothing today". On by default for the group named Flatmates (or the
/// only group there is); the time and the group are the user's to change.
class OtherPaidCheck {
  OtherPaidCheck._();
  static final OtherPaidCheck instance = OtherPaidCheck._();

  /// Today in India, as the key "answered" is kept against.
  static String todayKey([DateTime? now]) {
    final ist = (now ?? DateTime.now()).toUtc().add(const Duration(hours: 5, minutes: 30));
    return '${ist.year}-${ist.month.toString().padLeft(2, '0')}-${ist.day.toString().padLeft(2, '0')}';
  }

  Future<OtherPaidSettings> settings() async {
    final prefs = await SharedPreferences.getInstance();
    return OtherPaidSettings(
      enabled: prefs.getBool(_enabledKey) ?? true,
      hour: prefs.getInt(_hourKey) ?? 21,
      minute: prefs.getInt(_minuteKey) ?? 0,
      groupId: prefs.getString(_groupIdKey),
      groupName: prefs.getString(_groupNameKey),
    );
  }

  /// The group to ask about when none has been picked: the one called
  /// Flatmates, else the only one. Null when neither says which.
  static Group? defaultGroup(List<Group> groups) {
    final flatmates = groups.where((g) => g.name.trim().toLowerCase() == 'flatmates');
    if (flatmates.isNotEmpty) return flatmates.first;
    return groups.length == 1 ? groups.single : null;
  }

  /// The settings, with a group picked by default when none was, and the
  /// evening notification put in place (or taken off) to match. Called on
  /// every Home load: re-scheduling replaces, so this never piles up.
  Future<OtherPaidSettings> ensure() async {
    var current = await settings();
    if (current.enabled && !current.hasGroup) {
      try {
        final rows = await ApiClient.instance.get('/groups/active') as List<dynamic>;
        final picked = defaultGroup(rows.whereType<Map<String, dynamic>>().map(Group.fromJson).toList());
        if (picked != null) {
          await setGroup(picked.id, picked.name, reschedule: false);
          current = await settings();
        }
      } catch (_) {
        // No group yet; the check waits for one.
      }
    }
    await _reschedule(current);
    return current;
  }

  Future<void> _reschedule(OtherPaidSettings current) async {
    try {
      if (current.enabled && current.hasGroup) {
        await ReminderService.instance.scheduleOtherPaid(
          hour: current.hour,
          minute: current.minute,
          groupName: current.groupName!,
        );
      } else {
        await ReminderService.instance.cancelOtherPaid();
      }
    } catch (_) {
      // Notifications switched off; the Home card still asks.
    }
  }

  Future<void> setEnabled(bool enabled) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_enabledKey, enabled);
    if (enabled) await ReminderService.instance.requestPermission().catchError((_) => false);
    await _reschedule(await settings());
  }

  Future<void> setTime(int hour, int minute) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setInt(_hourKey, hour);
    await prefs.setInt(_minuteKey, minute);
    await _reschedule(await settings());
  }

  Future<void> setGroup(String id, String name, {bool reschedule = true}) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_groupIdKey, id);
    await prefs.setString(_groupNameKey, name);
    if (reschedule) await _reschedule(await settings());
  }

  /// Whether today has been answered - a payment added, or "nothing today".
  Future<bool> answeredToday([DateTime? now]) async =>
      (await SharedPreferences.getInstance()).getString(_answeredKey) == todayKey(now);

  Future<void> markAnswered([DateTime? now]) async =>
      (await SharedPreferences.getInstance()).setString(_answeredKey, todayKey(now));
}
