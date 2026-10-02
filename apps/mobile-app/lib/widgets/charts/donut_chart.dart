import 'dart:math' as math;
import 'package:flutter/material.dart';
import '../../theme.dart';

class DonutSegment {
  const DonutSegment({required this.value, required this.color, required this.label});

  final int value;
  final Color color;
  final String label;
}

/// A ring of shares with a figure in the middle. Segments are separated by
/// a thin gap in the surface colour so neighbouring colours never blur
/// together, in either theme.
class DonutChart extends StatelessWidget {
  const DonutChart({
    super.key,
    required this.segments,
    required this.centerTop,
    required this.centerBottom,
    this.size = 140,
  });

  final List<DonutSegment> segments;
  final String centerTop;
  final String centerBottom;
  final double size;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return SizedBox(
      width: size,
      height: size,
      child: CustomPaint(
        painter: _DonutPainter(segments: segments, track: c.track, gap: c.surface),
        child: Center(
          child: Padding(
            padding: EdgeInsets.all(size * 0.2),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                FittedBox(
                  child: Text(
                    centerTop,
                    style: kNum.copyWith(fontSize: 15, fontWeight: FontWeight.w800, color: c.ink),
                  ),
                ),
                Text(centerBottom, style: TextStyle(fontSize: 10.5, color: c.muted)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _DonutPainter extends CustomPainter {
  _DonutPainter({required this.segments, required this.track, required this.gap});

  final List<DonutSegment> segments;
  final Color track;
  final Color gap;

  @override
  void paint(Canvas canvas, Size size) {
    final stroke = size.shortestSide * 0.15;
    final rect = Rect.fromCircle(
      center: size.center(Offset.zero),
      radius: size.shortestSide / 2 - stroke / 2,
    );
    final base = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke;

    canvas.drawArc(rect, 0, math.pi * 2, false, base..color = track);

    final total = segments.fold<int>(0, (sum, s) => sum + s.value);
    if (total <= 0) return;

    var start = -math.pi / 2;
    final separator = segments.length > 1 ? 0.025 : 0.0;
    for (final segment in segments) {
      final sweep = segment.value / total * math.pi * 2;
      if (sweep <= 0) continue;
      canvas.drawArc(
        rect,
        start + separator / 2,
        math.max(sweep - separator, 0.004),
        false,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = stroke
          ..color = segment.color,
      );
      start += sweep;
    }
  }

  @override
  bool shouldRepaint(_DonutPainter old) => old.segments != segments || old.track != track;
}
