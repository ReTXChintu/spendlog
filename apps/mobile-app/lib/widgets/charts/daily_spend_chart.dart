import 'dart:math' as math;
import 'package:flutter/material.dart';
import '../../models/models.dart';
import '../../theme.dart';
import '../../utils/format.dart';
import 'chart_utils.dart';

/// Spending day by day across the month, as the design's bar chart
/// (§7.13): days gone in ink, today in the accent, days still to come as
/// hollow stubs, and the month's average per day dashed across it.
///
/// Days still to come are drawn as empty placeholders rather than zeros,
/// which would read as "spent nothing". Touch or drag to read a single day.
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

  /// How many of the days have happened yet; the rest are placeholders.
  int get _shown {
    final today = istToday();
    final count = widget.days.where((d) => d.day.compareTo(today) <= 0).length;
    return count == 0 ? widget.days.length : count;
  }

  void _select(Offset local, double width) {
    final n = widget.days.length;
    if (n == 0) return;
    final slot = (width - _gutter) / n;
    final index = ((local.dx - _gutter) / slot).floor().clamp(0, _shown - 1);
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
    final todayIndex = days.indexWhere((d) => d.day == istToday());

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
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: kNum.copyWith(fontSize: 12, height: 16 / 12, color: c.tx3),
                )
              : Text.rich(
                  TextSpan(children: [
                    TextSpan(
                      text: '${formatIsoShortDate(days[selected].day)}  ',
                      style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: c.tx2),
                    ),
                    TextSpan(
                      text: formatMoney(days[selected].spendMinor),
                      style: kNum.copyWith(fontSize: 13, fontWeight: FontWeight.w600, color: c.tx),
                    ),
                    if (days[selected].incomeMinor > 0)
                      TextSpan(
                        text: '  +${formatMoneyShort(days[selected].incomeMinor)} in',
                        style: kNum.copyWith(fontSize: 12, fontWeight: FontWeight.w600, color: c.good),
                      ),
                  ]),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
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
                painter: _BarsPainter(
                  values: days.take(shown).map((d) => d.spendMinor).toList(),
                  total: days.length,
                  labels: days.map((d) => d.day).toList(),
                  average: average,
                  selected: selected,
                  todayIndex: todayIndex,
                  ink: c.tx,
                  accent: c.ac,
                  sunk: c.sunk,
                  grid: c.ln,
                  baseline: c.ln2,
                  axis: c.tx3,
                  gutter: _gutter,
                ),
              ),
            ),
          ),
        ),
        const SizedBox(height: 10),
        Wrap(
          spacing: 16,
          runSpacing: 6,
          children: [
            LegendDot(color: c.tx, label: 'Spent each day'),
            if (todayIndex >= 0) LegendDot(color: c.ac, label: 'Today'),
            if (shown < days.length) LegendDot(color: c.ln2, label: 'Days to come', hollow: true),
            if (average > 0) _DashLegend(color: c.tx3, label: 'Average a day'),
          ],
        ),
      ],
    );
  }
}

class _DashLegend extends StatelessWidget {
  const _DashLegend({required this.color, required this.label});

  final Color color;
  final String label;

  @override
  Widget build(BuildContext context) => Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var i = 0; i < 3; i++) ...[
            if (i > 0) const SizedBox(width: 2),
            Container(width: 4, height: 1.75, color: color),
          ],
          const SizedBox(width: 8),
          Text(label, style: TextStyle(fontSize: 13, height: 18 / 13, color: context.c.tx2)),
        ],
      );
}

class _BarsPainter extends CustomPainter {
  _BarsPainter({
    required this.values,
    required this.total,
    required this.labels,
    required this.average,
    required this.selected,
    required this.todayIndex,
    required this.ink,
    required this.accent,
    required this.sunk,
    required this.grid,
    required this.baseline,
    required this.axis,
    required this.gutter,
  });

  final List<int> values;
  final int total;
  final List<String> labels;
  final int average;
  final int? selected;
  final int todayIndex;
  final Color ink, accent, sunk, grid, baseline, axis;
  final double gutter;

  static const _bottom = 20.0;
  static const _top = 6.0;

  @override
  void paint(Canvas canvas, Size size) {
    final plotH = size.height - _bottom - _top;
    final plotW = size.width - gutter;
    final peak = values.isEmpty ? 0 : values.reduce(math.max);
    final top = niceCeiling(math.max(peak, average).toDouble());
    final labelStyle = axisStyle(axis);
    double yOf(num v) => _top + plotH - (v / top) * plotH;

    // Gridlines at nothing, half and the top, each labelled.
    final gridPaint = Paint()
      ..color = grid
      ..strokeWidth = 1;
    for (final f in [0.5, 1.0]) {
      final y = yOf(top * f);
      canvas.drawLine(Offset(gutter, y), Offset(size.width, y), gridPaint);
    }
    for (final f in [0.0, 0.5, 1.0]) {
      paintLabel(canvas, compactMoney((top * f).round()), Offset(gutter - 6, yOf(top * f) - 7), labelStyle,
          alignRight: true);
    }

    final n = math.max(total, 1);
    final slot = plotW / n;
    final barW = math.min(slot * 0.64, 14.0);
    double xOf(int i) => gutter + slot * i + (slot - barW) / 2;
    final base = _top + plotH;

    for (var i = 0; i < total; i++) {
      final x = xOf(i);
      if (i >= values.length) {
        // A day still to come: a hollow stub.
        final stub = math.min(14.0, plotH);
        final r = RRect.fromRectAndCorners(
          Rect.fromLTWH(x + 0.5, base - stub + 0.5, barW - 1, stub - 1),
          topLeft: const Radius.circular(2),
          topRight: const Radius.circular(2),
        );
        canvas.drawRRect(r, Paint()..color = sunk);
        canvas.drawRRect(
          r,
          Paint()
            ..color = baseline
            ..style = PaintingStyle.stroke
            ..strokeWidth = 1,
        );
        continue;
      }
      final v = values[i];
      final h = v <= 0 ? 0.0 : math.max((v / top) * plotH, 2.0);
      if (h <= 0) continue;
      var colour = i == todayIndex ? accent : ink;
      // While a day is being read, the others step back.
      if (selected != null && selected != i) colour = colour.withValues(alpha: colour.a * 0.35);
      canvas.drawRRect(
        RRect.fromRectAndCorners(
          Rect.fromLTWH(x, base - h, barW, h),
          topLeft: const Radius.circular(2),
          topRight: const Radius.circular(2),
        ),
        Paint()..color = colour,
      );
    }

    canvas.drawLine(
      Offset(gutter, base + 0.5),
      Offset(size.width, base + 0.5),
      Paint()
        ..color = baseline
        ..strokeWidth = 1,
    );

    // The average, dashed, so a spike reads against a normal day.
    if (average > 0) {
      final y = yOf(average);
      paintDashedLine(
        canvas,
        Offset(gutter, y),
        Offset(size.width, y),
        Paint()
          ..color = axis
          ..strokeWidth = 1.75
          ..strokeCap = StrokeCap.round,
      );
      paintLabel(canvas, 'avg', Offset(size.width, y - 15), labelStyle, alignRight: true);
    }

    // First, middle and last day along the bottom; "Today" in the accent.
    if (labels.isNotEmpty) {
      final picks = {0, labels.length ~/ 2, labels.length - 1};
      double centre(int i) => gutter + slot * i + slot / 2;
      for (final i in picks) {
        if (todayIndex >= 0 && (i - todayIndex).abs() * slot < 36) continue;
        final first = i == 0;
        final last = i == labels.length - 1 && labels.length > 1;
        paintLabel(
          canvas,
          formatIsoShortDate(labels[i]),
          Offset(first ? gutter : (last ? size.width : centre(i)), base + 5),
          labelStyle,
          center: !first && !last,
          alignRight: last,
        );
      }
      if (todayIndex >= 0) {
        final tx = centre(todayIndex);
        final style = axisStyle(accent, weight: FontWeight.w600);
        final w = (TextPainter(
          text: TextSpan(text: 'Today', style: style),
          textDirection: TextDirection.ltr,
        )..layout())
            .width;
        final left = (tx - w / 2).clamp(gutter, size.width - w);
        paintLabel(canvas, 'Today', Offset(left, base + 5), style);
      }
    }
  }

  @override
  bool shouldRepaint(_BarsPainter old) =>
      old.values != values ||
      old.selected != selected ||
      old.ink != ink ||
      old.accent != accent ||
      old.average != average ||
      old.todayIndex != todayIndex;
}
