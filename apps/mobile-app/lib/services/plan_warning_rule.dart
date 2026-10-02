import '../utils/format.dart';

/// When a savings-plan warning is allowed to go out, and what it says.
///
/// Pure on purpose: it runs in the WorkManager isolate, where nothing else
/// from the app is set up, and it is the part worth testing without a
/// phone.

/// No warnings before 08:00 or from 22:00 on. Being told off about food at
/// 3am helps nobody.
const int planWarnFromHour = 8;
const int planWarnUntilHour = 22;

/// The usual gap between two warnings, and the cap per day.
const Duration planWarnGap = Duration(hours: 6);
const int planWarnPerDay = 3;

/// A rule newly broken may jump the six-hour wait, but never sooner than
/// this after the last one, so a figure hovering on a line can't flap.
const Duration planWarnChangedGap = Duration(hours: 1);

/// What was last said, as stored between runs.
class PlanWarnHistory {
  final DateTime? lastShownAt;
  final String? lastSignature;

  /// IST day (yyyy-mm-dd) the count below belongs to.
  final String? day;
  final int shownThatDay;

  const PlanWarnHistory({this.lastShownAt, this.lastSignature, this.day, this.shownThatDay = 0});
}

/// Which rules are broken and how, ignoring the exact amounts - spending
/// another ₹50 on food is not news, a new category going over is.
String planWarningSignature(List<Map<String, dynamic>> warnings) {
  final parts = warnings
      .map((w) => '${w['category'] ?? w['text'] ?? ''}|${w['state'] ?? ''}')
      .toList()
    ..sort();
  return parts.join(';');
}

String istDayKey(DateTime ist) =>
    '${ist.year}-${ist.month.toString().padLeft(2, '0')}-${ist.day.toString().padLeft(2, '0')}';

/// [nowIst] is wall-clock IST (the hour is read off it directly).
bool shouldWarnAboutPlan({
  required DateTime nowIst,
  required String signature,
  required PlanWarnHistory history,
}) {
  if (signature.isEmpty) return false;
  if (nowIst.hour < planWarnFromHour || nowIst.hour >= planWarnUntilHour) return false;

  final today = istDayKey(nowIst);
  final shownToday = history.day == today ? history.shownThatDay : 0;
  if (shownToday >= planWarnPerDay) return false;

  final last = history.lastShownAt;
  if (last == null) return true;
  final since = nowIst.difference(last);
  if (since >= planWarnGap) return true;
  return signature != history.lastSignature && since >= planWarnChangedGap;
}

/// The history after a warning has gone out.
PlanWarnHistory recordPlanWarning(PlanWarnHistory history, DateTime nowIst, String signature) {
  final today = istDayKey(nowIst);
  return PlanWarnHistory(
    lastShownAt: nowIst,
    lastSignature: signature,
    day: today,
    shownThatDay: (history.day == today ? history.shownThatDay : 0) + 1,
  );
}

/// One broken rule, as a line a person reads on a lock screen.
String describePlanWarning(Map<String, dynamic> warning) {
  final category = warning['category'] as String?;
  final cap = (warning['monthlyCapMinor'] as num?)?.toInt();
  final spent = (warning['spentMinor'] as num?)?.toInt();
  if (category != null && cap != null && spent != null) {
    final verb = warning['state'] == 'over' ? 'Over your plan' : 'Close to your plan';
    return '$verb: $category ${formatMoneyShort(spent)} of ${formatMoneyShort(cap)}';
  }
  return (warning['text'] as String?) ?? 'A savings rule is being broken';
}

/// Title and body for the notification.
({String title, String body}) planWarningMessage(List<Map<String, dynamic>> warnings) {
  if (warnings.length == 1) {
    return (
      title: describePlanWarning(warnings.first),
      body: (warnings.first['text'] as String?) ?? 'Open SpendLog to see your savings plan.',
    );
  }
  return (
    title: '${warnings.length} savings rules being broken this month',
    body: warnings.take(3).map(describePlanWarning).join('\n'),
  );
}
