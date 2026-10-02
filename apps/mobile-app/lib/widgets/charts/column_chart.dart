import 'dart:math' as math;
import 'package:flutter/material.dart';
import '../../theme.dart';
import 'chart_utils.dart';

/// Upright bars with a label under each, the tallest one picked out in
/// [highlight] and labelled with its value - the bar worth reading first.
class ColumnChart extends StatelessWidget {
  const ColumnChart({
    super.key,
    required this.values,
    required this.labels,
    required this.color,
    required this.highlight,
    this.height = 130,
  });

  final List<int> values;
  final List<String> labels;
  final Color color;
  final Color highlight;
  final double height;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return SizedBox(
      height: height,
      width: double.infinity,
      child: CustomPaint(
        painter: _ColumnPainter(
          values: values,
          labels: labels,
          color: color,
          highlight: highlight,
          grid: c.line,
          axis: c.muted,
          ink: c.ink,
        ),
      ),
    );
  }
}

class _ColumnPainter extends CustomPainter {
  _ColumnPainter({
    required this.values,
    required this.labels,
    required this.color,
    required this.highlight,
    required this.grid,
    required this.axis,
    required this.ink,
  });

  final List<int> values;
  final List<String> labels;
  final Color color;
  final Color highlight;
  final Color grid;
  final Color axis;
  final Color ink;

  static const _bottom = 16.0;
  static const _top = 16.0;

  @override
  void paint(Canvas canvas, Size size) {
    if (values.isEmpty) return;
    final plotH = size.height - _bottom - _top;
    final peak = values.reduce(math.max);
    final peakIndex = values.indexOf(peak);
    final slot = size.width / values.length;
    final barW = math.min(slot * 0.58, 26.0);
    final labelStyle = TextStyle(fontSize: 10, color: axis);

    canvas.drawLine(
      Offset(0, _top + plotH),
      Offset(size.width, _top + plotH),
      Paint()
        ..color = grid
        ..strokeWidth = 1,
    );

    for (var i = 0; i < values.length; i++) {
      final h = peak <= 0 ? 0.0 : values[i] / peak * plotH;
      final x = slot * i + (slot - barW) / 2;
      final rect = RRect.fromRectAndCorners(
        Rect.fromLTWH(x, _top + plotH - math.max(h, 2), barW, math.max(h, 2)),
        topLeft: const Radius.circular(4),
        topRight: const Radius.circular(4),
      );
      canvas.drawRRect(rect, Paint()..color = i == peakIndex && peak > 0 ? highlight : color);
      if (i < labels.length) {
        paintLabel(canvas, labels[i], Offset(slot * i + slot / 2, _top + plotH + 3), labelStyle, center: true);
      }
    }

    if (peak > 0) {
      paintLabel(
        canvas,
        compactMoney(peak),
        Offset(slot * peakIndex + slot / 2, _top - 14),
        TextStyle(fontSize: 10, fontWeight: FontWeight.w700, color: ink),
        center: true,
      );
    }
  }

  @override
  bool shouldRepaint(_ColumnPainter old) => old.values != values || old.color != color;
}
