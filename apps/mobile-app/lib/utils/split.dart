/// [totalMinor] shared out across [count] people as evenly as paise allow.
///
/// Whatever does not divide goes on the first person rather than being
/// dropped or spread a paisa at a time: ₹100 three ways is ₹33.34, ₹33.33,
/// ₹33.33, and the parts always add back up to the whole.
List<int> splitEvenly(int totalMinor, int count) {
  if (count <= 0) return const [];
  if (totalMinor <= 0) return List.filled(count, 0);

  final each = totalMinor ~/ count;
  final leftover = totalMinor - each * count;
  return [for (var i = 0; i < count; i++) i == 0 ? each + leftover : each];
}

/// What a split works out to: what each person owes, and what is left as
/// the user's own share.
class SplitResult {
  /// One amount per person, in the order they were given.
  final List<int> owedMinor;

  /// The user's own part. Never negative - see [overByMinor].
  final int myShareMinor;

  /// How far the typed amounts go past the total. 0 when they fit.
  final int overByMinor;

  const SplitResult({required this.owedMinor, required this.myShareMinor, this.overByMinor = 0});

  bool get isOver => overByMinor > 0;
}

/// Shares [totalMinor] equally among [people] others, plus the user when
/// [includeMe] is on.
///
/// With the user in, they are one of the heads and take whatever paise do
/// not divide - nobody else should owe an odd paisa the payer chose. With
/// the user out (money lent), the first person takes the leftover so the
/// user's share stays exactly 0.
SplitResult splitEqually({required int totalMinor, required int people, required bool includeMe}) {
  if (people <= 0) {
    // Nobody named yet: all of it is mine, or - lending - none of it.
    return SplitResult(
      owedMinor: const [],
      myShareMinor: includeMe && totalMinor > 0 ? totalMinor : 0,
    );
  }
  if (totalMinor <= 0) return SplitResult(owedMinor: List.filled(people, 0), myShareMinor: 0);
  if (!includeMe) return SplitResult(owedMinor: splitEvenly(totalMinor, people), myShareMinor: 0);

  final each = totalMinor ~/ (people + 1);
  return SplitResult(
    owedMinor: List.filled(people, each),
    myShareMinor: totalMinor - each * people,
  );
}

/// Each person's amount typed by hand: the user's share is whatever is
/// left, and typing more than the total is flagged rather than clamped.
SplitResult splitCustom({required int totalMinor, required List<int> owedMinor}) {
  final assigned = owedMinor.fold<int>(0, (sum, part) => sum + part);
  final left = totalMinor - assigned;
  return SplitResult(
    owedMinor: List.of(owedMinor),
    myShareMinor: left < 0 ? 0 : left,
    overByMinor: left < 0 ? -left : 0,
  );
}
