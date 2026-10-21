import 'dart:math' as math;
import 'package:flutter/material.dart';
import '../../theme.dart';

class DonutSegment {
  const DonutSegment({required this.value, required this.color, required this.label});

  final int value;
  final Color color;
  final String label;
}

/// A ring of shares with a figure in the middle (§7.13).
///
/// Proportions follow the design's 168 box: radius 52 and a 16 px stroke,
/// scaled to [size]. It starts at 12 o'clock with ~2 px gaps between
/// segments, left unpainted so the card shows through in either theme.
/// The centre reads like the spec: the small `tx3` label ([centerBottom],
/// e.g. "spent") over the 17/600 figure ([centerTop]).
class DonutChart extends StatelessWidget {
  const DonutChart({
    super.key,
    required this.segments,
    required this.centerTop,
    required this.centerBottom,
    this.size = 168,
  });

  final List<DonutSegment> segments;
  final String centerTop;
  final String centerBottom;
  final double size;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final scale = size / 168;
    // The hole is the ring's inner diameter, less a little air.
    final hole = (52 - 8) * 2 * scale - 8;
    return SizedBox(
      width: size,
      height: size,
      child: CustomPaint(
        painter: _DonutPainter(segments: segments, track: c.sunk),
        child: Center(
          child: SizedBox(
            width: math.max(hole, 24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  centerBottom,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 11, height: 14 / 11, color: c.tx3),
                ),
                FittedBox(
                  fit: BoxFit.scaleDown,
                  child: Text(
                    centerTop,
                    maxLines: 1,
                    style: kNum.copyWith(fontSize: 17, height: 24 / 17, fontWeight: FontWeight.w600, color: c.tx),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _DonutPainter extends CustomPainter {
  _DonutPainter({required this.segments, required this.track});

  final List<DonutSegment> segments;
  final Color track;

  @override
  void paint(Canvas canvas, Size size) {
    final scale = size.shortestSide / 168;
    final stroke = 16 * scale;
    final radius = 52 * scale;
    final rect = Rect.fromCircle(center: size.center(Offset.zero), radius: radius);
    final base = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..strokeCap = StrokeCap.butt;

    final total = segments.fold<int>(0, (sum, s) => sum + s.value);
    if (total <= 0) {
      canvas.drawArc(rect, 0, math.pi * 2, false, base..color = track);
      return;
    }

    var start = -math.pi / 2;
    final live = segments.where((s) => s.value > 0).length;
    // About 2 px of arc at the ring's centre line.
    final separator = live > 1 ? 2 / radius : 0.0;
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
