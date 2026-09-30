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
