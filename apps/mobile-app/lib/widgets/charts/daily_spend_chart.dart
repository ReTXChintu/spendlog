import 'dart:math' as math;
import 'package:flutter/material.dart';
import '../../models/models.dart';
import '../../theme.dart';
import '../../utils/format.dart';
import 'chart_utils.dart';

/// Spending day by day across the month, as a line over a soft area, with
/// the month's average per day dashed across it.
///
/// Days still to come are left off the line rather than drawn as zeros,
/// which would read as "spent nothing" and drag the eye down. Touch or drag
/// to read a single day.
class DailySpendChart extends StatefulWidget {
  const DailySpendChart({super.key, required this.days, this.height = 170});

  final List<DaySpend> days;
  final double height;

  @override
  State<DailySpendChart> createState() => _DailySpendChartState();
}

class _DailySpendChartState extends State<DailySpendChart> {
  int? _selected;

  static const _gutter = 40.0;

  /// How many of the days have happened yet; the rest are not plotted.
  int get _shown {
    final today = istToday();
    final count = widget.days.where((d) => d.day.compareTo(today) <= 0).length;
    return count == 0 ? widget.days.length : count;
  }

  void _select(Offset local, double width) {
    final n = widget.days.length;
    if (n == 0) return;
    final plot = width - _gutter;
    final step = n > 1 ? plot / (n - 1) : plot;
    final index = ((local.dx - _gutter) / step).round().clamp(0, _shown - 1);
    if (index != _selected) setState(() => _selected = index);
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final days = widget.days;
    if (days.isEmpty) return const SizedBox.shrink();

    final shown = _shown;
    final spent = days.take(shown).fold<int>(0, (sum, d) => sum + d.spendMinor);
    final average = shown == 0 ? 0 : spent ~/ shown;
    final selected = _selected;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // The read-out sits above the chart rather than in a floating
        // tooltip, so a finger never covers it.
        SizedBox(
          height: 20,
          child: selected == null
              ? Text(
                  'Average ${formatMoneyShort(average)} a day · touch the chart to read a day',
                  style: TextStyle(fontSize: 11.5, color: c.muted),
                )
              : Text.rich(
                  TextSpan(children: [
                    TextSpan(
                      text: '${formatIsoShortDate(days[selected].day)}  ',
                      style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: c.ink),
                    ),
                    TextSpan(
                      text: formatMoney(days[selected].spendMinor),
                      style: kNum.copyWith(fontSize: 12, fontWeight: FontWeight.w700, color: c.debit),
                    ),
                    if (days[selected].incomeMinor > 0)
                      TextSpan(
                        text: '  +${formatMoneyShort(days[selected].incomeMinor)} in',
                        style: kNum.copyWith(fontSize: 11.5, color: c.credit),
                      ),
                  ]),
                ),
        ),
        const SizedBox(height: 6),
        LayoutBuilder(
          builder: (context, constraints) => GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTapDown: (d) => _select(d.localPosition, constraints.maxWidth),
            onHorizontalDragUpdate: (d) => _select(d.localPosition, constraints.maxWidth),
            onHorizontalDragEnd: (_) => setState(() => _selected = null),
            child: SizedBox(
              width: constraints.maxWidth,
              height: widget.height,
              child: CustomPaint(
                painter: _AreaPainter(
                  values: days.take(shown).map((d) => d.spendMinor).toList(),
                  total: days.length,
                  labels: days.map((d) => d.day).toList(),
                  average: average,
                  selected: selected,
                  line: c.debit,
                  grid: c.line,
                  axis: c.muted,
                  surface: c.surface,
                  gutter: _gutter,
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _AreaPainter extends CustomPainter {
  _AreaPainter({
    required this.values,
    required this.total,
    required this.labels,
    required this.average,
    required this.selected,
    required this.line,
    required this.grid,
    required this.axis,
    required this.surface,
    required this.gutter,
  });

  final List<int> values;
  final int total;
  final List<String> labels;
  final int average;
  final int? selected;
  final Color line;
  final Color grid;
  final Color axis;
  final Color surface;
  final double gutter;

  static const _bottom = 18.0;

  @override
  void paint(Canvas canvas, Size size) {
    final plotH = size.height - _bottom;
    final plotW = size.width - gutter;
    final peak = values.isEmpty ? 0 : values.reduce(math.max);
    final top = niceCeiling(peak.toDouble());
    final labelStyle = TextStyle(fontSize: 10, color: axis);

    // Gridlines at nothing, half and the top, each labelled.
    final gridPaint = Paint()
      ..color = grid
      ..strokeWidth = 1;
    for (final f in [0.0, 0.5, 1.0]) {
      final y = plotH - f * plotH;
      canvas.drawLine(Offset(gutter, y), Offset(size.width, y), gridPaint);
      paintLabel(canvas, compactMoney((top * f).round()), Offset(gutter - 6, y - 7), labelStyle, alignRight: true);
    }

    final step = total > 1 ? plotW / (total - 1) : plotW;
    Offset at(int i) => Offset(gutter + i * step, plotH - (values[i] / top) * plotH);

    if (values.isNotEmpty) {
      final path = Path()..moveTo(at(0).dx, at(0).dy);
      for (var i = 1; i < values.length; i++) {
        // A gentle curve between days: smoother to read than a zig-zag,
        // and the control points keep it from overshooting below zero.
        final p = at(i - 1);
        final q = at(i);
        final mid = (p.dx + q.dx) / 2;
        path.cubicTo(mid, p.dy, mid, q.dy, q.dx, q.dy);
      }

      final area = Path.from(path)
        ..lineTo(at(values.length - 1).dx, plotH)
        ..lineTo(gutter, plotH)
        ..close();
      canvas.drawPath(
        area,
        Paint()
          ..shader = LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [line.withValues(alpha: .26), line.withValues(alpha: .02)],
          ).createShader(Rect.fromLTWH(0, 0, size.width, plotH)),
      );
      canvas.drawPath(
        path,
        Paint()
          ..color = line
          ..strokeWidth = 2
          ..style = PaintingStyle.stroke
          ..strokeJoin = StrokeJoin.round
          ..strokeCap = StrokeCap.round,
      );
    }

    // The average, dashed, so a spike reads against a normal day.
    if (average > 0) {
      final y = plotH - (average / top) * plotH;
      final dash = Paint()
        ..color = axis.withValues(alpha: .7)
        ..strokeWidth = 1;
      for (var x = gutter; x < size.width; x += 8) {
        canvas.drawLine(Offset(x, y), Offset(math.min(x + 4, size.width), y), dash);
      }
      paintLabel(canvas, 'avg', Offset(size.width, y - 13), labelStyle, alignRight: true);
    }

    // First, middle and last day along the bottom.
    if (labels.isNotEmpty) {
      final picks = {0, labels.length ~/ 2, labels.length - 1};
      for (final i in picks) {
        final x = gutter + i * step;
        paintLabel(
          canvas,
          formatIsoShortDate(labels[i]),
          Offset(x, plotH + 4),
          labelStyle,
          center: i != 0 && i != labels.length - 1,
          alignRight: i == labels.length - 1 && labels.length > 1,
        );
      }
    }

    final s = selected;
    if (s != null && s < values.length) {
      final point = at(s);
      canvas.drawLine(
        Offset(point.dx, 0),
        Offset(point.dx, plotH),
        Paint()
          ..color = axis.withValues(alpha: .5)
          ..strokeWidth = 1,
      );
      canvas.drawCircle(point, 5.5, Paint()..color = surface);
      canvas.drawCircle(point, 4, Paint()..color = line);
    }
  }

  @override
  bool shouldRepaint(_AreaPainter old) =>
      old.values != values || old.selected != selected || old.line != line || old.average != average;
}
