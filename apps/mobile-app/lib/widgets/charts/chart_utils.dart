import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import '../../theme.dart';

/// Axis labels have a few pixels each, so ₹12,40,000 becomes ₹12.4L. A
/// negative gets a true minus (U+2212), as every amount in the app does.
String compactMoney(int amountMinor) {
  final rupees = amountMinor / 100;
  final abs = rupees.abs();
  final sign = rupees < 0 ? '−' : '';
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

/// The chart axis style (§7.13): 11 px tabular figures.
TextStyle axisStyle(Color color, {FontWeight weight = FontWeight.w400}) => TextStyle(
      fontFamily: Ds.sans,
      fontSize: 11,
      height: 14 / 11,
      fontWeight: weight,
      color: color,
      fontFeatures: Ds.tabular,
    );

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

/// A dashed horizontal or sloped line from [a] to [b].
void paintDashedLine(Canvas canvas, Offset a, Offset b, Paint paint, {double dash = 5, double gap = 4}) {
  final total = (b - a).distance;
  if (total <= 0) return;
  final dir = (b - a) / total;
  var d = 0.0;
  while (d < total) {
    final end = (d + dash).clamp(0.0, total);
    canvas.drawLine(a + dir * d, a + dir * end, paint);
    d += dash + gap;
  }
}

/// A dashed polyline through [points], for a comparison series.
void paintDashedPath(Canvas canvas, List<Offset> points, Paint paint, {double dash = 5, double gap = 4}) {
  if (points.length < 2) return;
  final path = Path()..moveTo(points.first.dx, points.first.dy);
  for (final p in points.skip(1)) {
    path.lineTo(p.dx, p.dy);
  }
  for (final ui.PathMetric metric in path.computeMetrics()) {
    var d = 0.0;
    while (d < metric.length) {
      canvas.drawPath(metric.extractPath(d, (d + dash).clamp(0.0, metric.length)), paint);
      d += dash + gap;
    }
  }
}

/// A small coloured square and its name, for chart legends: a 10×10
/// radius-3 swatch and 13/18 text.
class LegendDot extends StatelessWidget {
  const LegendDot({super.key, required this.color, required this.label, this.textColor, this.hollow = false});

  final Color color;
  final String label;
  final Color? textColor;

  /// An outlined swatch, for a series with no fill of its own.
  final bool hollow;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 10,
          height: 10,
          decoration: BoxDecoration(
            color: hollow ? Colors.transparent : color,
            border: hollow ? Border.all(color: color, width: 1.5) : null,
            borderRadius: BorderRadius.circular(3),
          ),
        ),
        const SizedBox(width: 8),
        Flexible(
          child: Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 13, height: 18 / 13, color: textColor ?? c.tx2),
          ),
        ),
      ],
    );
  }
}
