import 'package:flutter/material.dart';

/// Axis labels have a few pixels each, so ₹12,40,000 becomes ₹12.4L.
String compactMoney(int amountMinor) {
  final rupees = amountMinor / 100;
  final abs = rupees.abs();
  final sign = rupees < 0 ? '-' : '';
  String trim(double v) => v >= 10 ? v.round().toString() : v.toStringAsFixed(1).replaceAll('.0', '');
  if (abs >= 10000000) return '$sign₹${trim(abs / 10000000)}Cr';
  if (abs >= 100000) return '$sign₹${trim(abs / 100000)}L';
  if (abs >= 1000) return '$sign₹${trim(abs / 1000)}k';
  return '$sign₹${abs.round()}';
}

/// A "nice" ceiling for an axis - 1, 2 or 5 times a power of ten - so the
/// gridlines land on round numbers rather than on the month's peak.
double niceCeiling(double value) {
  if (value <= 0) return 1;
  var magnitude = 1.0;
  while (magnitude * 10 <= value) {
    magnitude *= 10;
  }
  for (final step in [1.0, 2.0, 5.0, 10.0]) {
    if (step * magnitude >= value) return step * magnitude;
  }
  return 10 * magnitude;
}

/// Draws [text] with its top-left (or right-aligned end) at [at].
void paintLabel(Canvas canvas, String text, Offset at, TextStyle style, {bool alignRight = false, bool center = false}) {
  final painter = TextPainter(
    text: TextSpan(text: text, style: style),
    textDirection: TextDirection.ltr,
    maxLines: 1,
  )..layout();
  var dx = at.dx;
  if (alignRight) dx -= painter.width;
  if (center) dx -= painter.width / 2;
  painter.paint(canvas, Offset(dx, at.dy));
}

/// A small coloured square and its name, for chart legends.
class LegendDot extends StatelessWidget {
  const LegendDot({super.key, required this.color, required this.label, this.textColor});

  final Color color;
  final String label;
  final Color? textColor;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 9,
          height: 9,
          decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(3)),
        ),
        const SizedBox(width: 6),
        Flexible(
          child: Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 11.5, color: textColor),
          ),
        ),
      ],
    );
  }
}
