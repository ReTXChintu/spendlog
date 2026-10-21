import 'dart:math' as math;
import 'package:flutter/material.dart';
import '../../models/fund_models.dart';
import '../../utils/format.dart';
import '../ds/ds.dart';
import 'fund_text.dart';

/// The pieces the Investments screens share: tags, flag notes, the
/// allocation bar, the NAV sparkline and the holding card.

/// One colour per asset class, from the chart palette (§3.3): equity is c1,
/// debt c2, hybrid c3, and anything else the warm grey that always comes last.
Color assetClassColor(DsColors c, String assetClass) => switch (assetClass) {
      'equity' => c.chart[0],
      'debt' => c.chart[1],
      'hybrid' => c.chart[2],
      _ => c.chart.last,
    };

/// Green for a gain, red for a loss (a judgement, §3.2), plain for neither.
Color gainColor(DsColors c, num? value) =>
    value == null || value == 0 ? c.tx2 : (value > 0 ? c.good : c.crit);

enum TagTone { neutral, brand, warn, good }

DsTone _dsTone(TagTone tone) => switch (tone) {
      TagTone.brand => DsTone.ac,
      TagTone.warn => DsTone.warn,
      TagTone.good => DsTone.good,
      TagTone.neutral => DsTone.neutral,
    };

/// A small status tag: "Direct", "Regular", "IDCW", "Waiting for NAV".
class FundTag extends StatelessWidget {
  const FundTag(this.label, {super.key, this.tone = TagTone.neutral});

  final String label;
  final TagTone tone;

  @override
  Widget build(BuildContext context) => DsBadge(label, tone: _dsTone(tone));
}

/// The plan and option tags for a scheme.
List<Widget> schemeTags({required bool isDirect, required bool isRegular, required bool isGrowth}) => [
      if (isDirect) const FundTag('Direct', tone: TagTone.good),
      if (isRegular) const FundTag('Regular', tone: TagTone.warn),
      FundTag(isGrowth ? 'Growth' : 'IDCW'),
    ];

/// A section title (17/24 600) with an optional count and something on
/// the right.
class FundSectionHeader extends StatelessWidget {
  const FundSectionHeader({super.key, required this.title, this.count, this.trailing});

  final String title;
  final int? count;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Row(
      children: [
        Flexible(
          child: Text(
            title,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 17, height: 24 / 17, fontWeight: FontWeight.w600, color: c.tx),
          ),
        ),
        if (count != null) ...[
          const SizedBox(width: 8),
          DsBadge('$count'),
        ],
        if (trailing != null) ...[const Spacer(), trailing!],
      ],
    );
  }
}

/// A flat card: `sf`, 1 px `ln`, radius 14, full width.
class FundCard extends StatelessWidget {
  const FundCard({super.key, required this.child, this.onTap, this.padding = const EdgeInsets.all(16)});

  final Widget child;
  final VoidCallback? onTap;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) => DsCard(onTap: onTap, padding: padding, child: child);
}

/// A callout across the page: stale prices, payments to link, ranks still
/// coming. [icon] is a [DsGlyph] or an [IconData].
class FundBanner extends StatelessWidget {
  const FundBanner({
    super.key,
    required this.icon,
    required this.text,
    this.tone = TagTone.warn,
    this.onTap,
    this.actionLabel,
  });

  final Object icon;
  final String text;
  final TagTone tone;
  final VoidCallback? onTap;
  final String? actionLabel;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final t = _dsTone(tone);
    final strong = c.strong(t);
    // Info and neutral callouts keep their text in ink; the others in their own colour.
    final textColor = switch (t) {
      DsTone.ac => c.tx,
      DsTone.neutral => c.tx2,
      _ => strong,
    };
    final linkColor = t == DsTone.neutral ? c.ac : strong;
    return Material(
      color: c.soft(t),
      borderRadius: BorderRadius.circular(Ds.rLg),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(Ds.rLg),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              dsIconOf(icon, size: 20, color: strong),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  text,
                  style: TextStyle(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w500, color: textColor),
                ),
              ),
              if (actionLabel != null) ...[
                const SizedBox(width: 12),
                Text(actionLabel!, style: TextStyle(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w600, color: linkColor)),
              ] else if (onTap != null) ...[
                const SizedBox(width: 8),
                DsIcon(DsIcons.chevronRight, size: 18, color: linkColor),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// A label over a figure, for the stat grids: `12/600 tx2` over `17/600`.
class StatCell extends StatelessWidget {
  const StatCell({super.key, required this.label, required this.value, this.color, this.sub});

  final String label;
  final String value;
  final Color? color;
  final String? sub;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(label, style: TextStyle(fontSize: 12, height: 16 / 12, fontWeight: FontWeight.w600, color: c.tx2)),
        const SizedBox(height: 2),
        FittedBox(
          fit: BoxFit.scaleDown,
          alignment: Alignment.centerLeft,
          child: Text(
            value,
            maxLines: 1,
            style: kNum.copyWith(fontSize: 17, height: 24 / 17, fontWeight: FontWeight.w600, color: color ?? c.tx),
          ),
        ),
        if (sub != null)
          Text(
            sub!,
            style: kNum.copyWith(
              fontSize: 12,
              height: 16 / 12,
              fontWeight: color == null ? FontWeight.w400 : FontWeight.w600,
              color: color ?? c.tx3,
            ),
          ),
      ],
    );
  }
}

/// Cells two to a row, each half the width.
class StatGrid extends StatelessWidget {
  const StatGrid({super.key, required this.cells, this.columns = 2});

  final List<Widget> cells;
  final int columns;

  @override
  Widget build(BuildContext context) {
    final rows = <Widget>[];
    for (var i = 0; i < cells.length; i += columns) {
      if (rows.isNotEmpty) rows.add(const SizedBox(height: 16));
      rows.add(Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (var j = 0; j < columns; j++) ...[
            if (j > 0) const SizedBox(width: 16),
            Expanded(child: i + j < cells.length ? cells[i + j] : const SizedBox.shrink()),
          ],
        ],
      ));
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: rows);
  }
}

/// A flag, said plainly with its numbers, and why it's raised when [explain].
class FlagNote extends StatelessWidget {
  const FlagNote({super.key, required this.holding, required this.flag, required this.rules, this.explain = false});

  final FundHolding holding;
  final String flag;
  final FlagRules rules;
  final bool explain;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final Object icon = switch (flag) {
      FundFlag.laggingCategory => Icons.trending_down,
      FundFlag.lowXirr => Icons.hourglass_bottom,
      _ => DsIcons.transfer,
    };
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(color: c.warnSoft, borderRadius: BorderRadius.circular(Ds.rLg)),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(padding: const EdgeInsets.only(top: 1), child: dsIconOf(icon, size: 16, color: c.warn)),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  flagReason(holding, flag),
                  style: TextStyle(fontSize: 13, height: 18 / 13, fontWeight: FontWeight.w600, color: c.warn),
                ),
                if (explain) ...[
                  const SizedBox(height: 4),
                  Text(
                    flagExplainer(flag, rules),
                    style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx2),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The portfolio split by asset class: a 12 h stacked bar (radius 6, 2 px
/// gaps) in the chart palette, and a legend of 10×10 swatches.
class AllocationBar extends StatelessWidget {
  const AllocationBar({super.key, required this.slices});

  final List<AllocationSlice> slices;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final shown = slices.where((slice) => slice.valueMinor > 0 && slice.percent > 0).toList();
    if (shown.isEmpty) return const SizedBox.shrink();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(6),
          child: SizedBox(
            height: 12,
            child: Row(
              children: [
                for (final (i, slice) in shown.indexed) ...[
                  if (i > 0) const SizedBox(width: 2),
                  Expanded(
                    // Flex wants integers; tenths of a percent keep a 0.4% sliver visible.
                    flex: math.max(1, (slice.percent * 10).round()),
                    child: Container(color: assetClassColor(c, slice.assetClass)),
                  ),
                ],
              ],
            ),
          ),
        ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 16,
          runSpacing: 6,
          children: [
            for (final slice in shown)
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    width: 10,
                    height: 10,
                    decoration: BoxDecoration(
                      color: assetClassColor(c, slice.assetClass),
                      borderRadius: BorderRadius.circular(3),
                    ),
                  ),
                  const SizedBox(width: 6),
                  Text(
                    '${assetClassLabel(slice.assetClass)} ${fundPercent(slice.percent, digits: slice.percent >= 10 ? 0 : 1)}',
                    style: kNum.copyWith(fontSize: 13, height: 18 / 13, fontWeight: FontWeight.w600, color: c.tx),
                  ),
                  const SizedBox(width: 4),
                  Text(formatMoneyShort(slice.valueMinor), style: kNum.copyWith(fontSize: 12, color: c.tx3)),
                ],
              ),
          ],
        ),
      ],
    );
  }
}

/// A year of NAVs as an accent line (1.75, round joins), with the year's
/// starting level dashed so up or down reads at a glance.
class NavSparkline extends StatelessWidget {
  const NavSparkline({super.key, required this.points, this.height = 96});

  final List<NavPoint> points;
  final double height;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    if (points.length < 2) {
      return SizedBox(
        height: height,
        child: Center(child: Text('Not enough NAV history yet', style: TextStyle(fontSize: 12, color: c.tx3))),
      );
    }
    return SizedBox(
      height: height,
      width: double.infinity,
      child: CustomPaint(
        painter: _SparklinePainter(
          values: [for (final point in points) point.nav],
          line: c.ac,
          baseline: c.ln2,
          grid: c.ln,
        ),
      ),
    );
  }
}

class _SparklinePainter extends CustomPainter {
  _SparklinePainter({required this.values, required this.line, required this.baseline, required this.grid});

  final List<double> values;
  final Color line;
  final Color baseline;
  final Color grid;

  @override
  void paint(Canvas canvas, Size size) {
    final low = values.reduce(math.min);
    final high = values.reduce(math.max);
    final span = high - low == 0 ? 1.0 : high - low;
    const pad = 5.0;
    final height = size.height - pad * 2;

    // Light gridlines, top, middle and bottom.
    final gridPaint = Paint()
      ..color = grid
      ..strokeWidth = 1;
    for (final f in [0.0, 0.5, 1.0]) {
      final y = pad + height * f;
      canvas.drawLine(Offset(0, y), Offset(size.width, y), gridPaint);
    }

    Offset at(int i) => Offset(
          size.width * i / (values.length - 1),
          pad + height - ((values[i] - low) / span) * height,
        );

    final path = Path()..moveTo(at(0).dx, at(0).dy);
    for (var i = 1; i < values.length; i++) {
      final point = at(i);
      path.lineTo(point.dx, point.dy);
    }

    // Where the year started, dashed.
    final startY = at(0).dy;
    final dash = Paint()
      ..color = baseline
      ..strokeWidth = 1;
    for (var x = 0.0; x < size.width; x += 8) {
      canvas.drawLine(Offset(x, startY), Offset(math.min(x + 4, size.width), startY), dash);
    }

    canvas.drawPath(
      path,
      Paint()
        ..color = line
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.75
        ..strokeJoin = StrokeJoin.round
        ..strokeCap = StrokeCap.round,
    );
    final last = at(values.length - 1);
    canvas.drawCircle(last, 3.5, Paint()..color = line);
  }

  @override
  bool shouldRepaint(_SparklinePainter old) =>
      old.values != values || old.line != line || old.baseline != baseline || old.grid != grid;
}

/// "Category ranks coming": the peer table isn't built yet.
class RanksComingNote extends StatelessWidget {
  const RanksComingNote({super.key});

  @override
  Widget build(BuildContext context) => const FundBanner(
        icon: DsIcons.barChart,
        tone: TagTone.neutral,
        text: 'Category ranks coming — every fund\'s 1- and 3-year returns are still being gathered to compare '
            'yours against. Check back in a little while.',
      );
}

/// One fund in the portfolio list: what it's worth, how it's doing, against
/// its category, and anything wrong with it.
class HoldingCard extends StatelessWidget {
  const HoldingCard({super.key, required this.holding, required this.rules, this.onTap});

  final FundHolding holding;
  final FlagRules rules;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final h = holding;
    final peers = h.peers;
    final rank = peers?.rank;
    final sip = h.sip;

    final returns = [
      if (h.oneYearPercent != null) returnVsMedian('1y', h.oneYearPercent, peers?.oneYear.medianPercent),
      if (h.threeYearPercent != null) returnVsMedian('3y', h.threeYearPercent, peers?.threeYear.medianPercent),
    ];

    final meta = [
      if (sip != null) h.sipRunning ? 'SIP ${sipLine(sip)}' : (h.sipPaused ? 'SIP paused' : 'SIP stopped'),
      if (h.pendingCount > 0) '${h.pendingCount} waiting for NAV',
      if (rank != null) '${rankLine(rank)} in category${peers?.basis == null ? '' : ' (${peers!.basis})'}',
    ];

    return FundCard(
      onTap: onTap,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Text(
                  shortSchemeName(h.schemeName),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
                ),
              ),
              if (h.isRegular) ...[
                const SizedBox(width: 8),
                const FundTag('Regular', tone: TagTone.warn),
              ],
            ],
          ),
          const SizedBox(height: 2),
          Text(
            [if (h.fundHouse != null) h.fundHouse!, h.categoryLabel].join(' · '),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3),
          ),
          const SizedBox(height: 12),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    FittedBox(
                      fit: BoxFit.scaleDown,
                      alignment: Alignment.centerLeft,
                      child: Text(
                        formatMoneyShort(h.valueMinor),
                        style: kNum.copyWith(fontSize: 17, height: 24 / 17, fontWeight: FontWeight.w600, color: c.tx),
                      ),
                    ),
                    Text(
                      'Invested ${formatMoneyShort(h.investedMinor)}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: kNum.copyWith(fontSize: 12, height: 16 / 12, color: c.tx3),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Flexible(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    FittedBox(
                      fit: BoxFit.scaleDown,
                      alignment: Alignment.centerRight,
                      child: Text(
                        '${signedMoneyShort(h.gainMinor)} (${fundPercent(h.gainPercent, signed: true)})',
                        style: kNum.copyWith(
                          fontSize: 14,
                          height: 20 / 14,
                          fontWeight: FontWeight.w600,
                          color: gainColor(c, h.gainMinor),
                        ),
                      ),
                    ),
                    Text(
                      h.xirrPercent == null ? 'XIRR after 3 months' : 'XIRR ${fundPercent(h.xirrPercent)}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: kNum.copyWith(fontSize: 12, height: 16 / 12, color: c.tx3),
                    ),
                  ],
                ),
              ),
            ],
          ),
          if (meta.isNotEmpty) ...[
            const SizedBox(height: 10),
            Text(meta.join(' · '), style: TextStyle(fontSize: 13, height: 18 / 13, fontWeight: FontWeight.w500, color: c.tx2)),
          ],
          if (returns.isNotEmpty) ...[
            const SizedBox(height: 2),
            Text(returns.join(' · '), style: kNum.copyWith(fontSize: 13, height: 18 / 13, color: c.tx2)),
          ],
          for (final flag in h.flags) ...[
            const SizedBox(height: 8),
            FlagNote(holding: h, flag: flag, rules: rules),
          ],
        ],
      ),
    );
  }
}
