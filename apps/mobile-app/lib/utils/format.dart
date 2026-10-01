import 'package:intl/intl.dart';

/// Amounts are stored in paise and always shown with Indian grouping.
String formatMoney(int amountMinor, [String currency = 'INR']) {
  final formatter = NumberFormat.currency(
    locale: 'en_IN',
    symbol: currency == 'INR' ? '₹' : '$currency ',
  );
  return formatter.format(amountMinor / 100);
}

/// Rupees as typed - "1,499.50", "₹ 2000", "-350" - to paise. Null when it
/// is not a number, and for a negative one unless [allowNegative]: only a
/// balance can be below zero, an amount never is.
int? parseRupees(String text, {bool allowNegative = false}) {
  final cleaned = text.replaceAll(RegExp(r'[₹,\s]'), '');
  if (cleaned.isEmpty) return null;
  final value = double.tryParse(cleaned);
  if (value == null || value.isNaN || value.isInfinite) return null;
  if (value < 0 && !allowNegative) return null;
  return (value * 100).round();
}

/// Compact form for tiles and the month rollup: ₹42,318 with no paise.
String formatMoneyShort(int amountMinor, [String currency = 'INR']) {
  final formatter = NumberFormat.currency(
    locale: 'en_IN',
    symbol: currency == 'INR' ? '₹' : '$currency ',
    decimalDigits: 0,
  );
  return formatter.format(amountMinor / 100);
}

/// Everything is shown in IST, whatever the phone's own timezone says.
///
/// A ledger read on a phone that has picked up another country's clock —
/// or one simply set wrong — should still say a payment happened on the
/// evening of the 11th, because that is when it happened. India has a fixed
/// +05:30 offset and no daylight saving, so the arithmetic is safe.
const Duration _istOffset = Duration(hours: 5, minutes: 30);

/// The instant as IST wall-clock, carried in a DateTime whose own fields
/// are what should be displayed.
DateTime _ist(DateTime instant) => instant.toUtc().add(_istOffset);

/// The instant as IST wall-clock, for a date/time picker to edit. The
/// result is a local-flavoured DateTime whose fields read as IST.
DateTime istWallClock(DateTime instant) {
  final ist = _ist(instant);
  return DateTime(ist.year, ist.month, ist.day, ist.hour, ist.minute, ist.second);
}

/// The reverse: IST wall-clock fields back to the instant they name.
DateTime fromIstWallClock(DateTime wallClock) =>
    DateTime.utc(
      wallClock.year,
      wallClock.month,
      wallClock.day,
      wallClock.hour,
      wallClock.minute,
      wallClock.second,
    ).subtract(_istOffset);

/// Today's date in IST, as YYYY-MM-DD.
String istToday() => _ist(DateTime.now()).toIso8601String().substring(0, 10);

String formatDayLabel(String isoDate) {
  final today = istToday();
  if (isoDate == today) return 'Today';

  final yesterday = DateTime.parse('${today}T00:00:00Z')
      .subtract(const Duration(days: 1))
      .toIso8601String()
      .substring(0, 10);
  if (isoDate == yesterday) return 'Yesterday';

  // Parsed as a plain date, so no offset can shift which day is named.
  return DateFormat('EEE, d MMM').format(DateTime.parse(isoDate));
}

String formatTime(DateTime dateTime) => DateFormat('h:mm a').format(_ist(dateTime));

String formatDateTime(DateTime dateTime) => DateFormat('EEE, d MMM, h:mm a').format(_ist(dateTime));

/// "September 2026" for the analytics month picker.
String formatMonthLabel(String month) {
  final parts = month.split('-').map(int.parse).toList();
  return DateFormat('MMMM yyyy').format(DateTime(parts[0], parts[1]));
}

/// "15 Sep" from a plain YYYY-MM-DD, for naming a pay-day month by the day
/// it starts. Parsed as a plain date, so no offset can shift the day.
String formatIsoShortDate(String isoDate) {
  final parsed = DateTime.tryParse(isoDate);
  return parsed == null ? '' : DateFormat('d MMM').format(parsed);
}

/// A month's readable name. The server sends one ("15 Sep – 14 Oct 2026");
/// an older server sent only the YYYY-MM key, which gets the calendar name.
String readableMonth(String labelOrKey) {
  if (RegExp(r'^\d{4}-\d{2}$').hasMatch(labelOrKey)) return formatMonthLabel(labelOrKey);
  return labelOrKey;
}

// No calendar currentMonth()/shiftMonth() here on purpose: which month
// "now" is, and the one before it, depend on the user's salary day, so
// both come from the server (/analytics/months).

/// "1st", "17th", "21st", "23rd" — a day of the month, said aloud.
///
/// The lookup is by the last digit and the table only covers 0 to 3, so
/// every other digit has to fall back rather than index past the end of
/// it. This began life as a port of the web version, where reading past
/// an array gives undefined and a `?? "th"` quietly catches it; in Dart
/// the same expression throws, and a card billing on the 24th to the 29th
/// took a whole screen down with a RangeError.
String ordinalDay(int day) {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  final last = day % 10;

  // 11th, 12th and 13th are "th" despite ending in 1, 2 and 3.
  final suffix = (day > 3 && day < 21) || last > 3 ? 'th' : suffixes[last];
  return '$day$suffix';
}

/// "17 Oct", in IST. For a date named alongside something else, where the
/// weekday formatDayLabel gives would be noise rather than help.
String formatShortDate(DateTime date) => DateFormat('d MMM').format(_ist(date));
