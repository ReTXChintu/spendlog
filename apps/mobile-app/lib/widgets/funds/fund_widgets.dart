import 'dart:math' as math;
import 'package:flutter/material.dart';
import '../../models/fund_models.dart';
import '../../theme.dart';
import '../../utils/format.dart';
import 'fund_text.dart';

/// The pieces the Investments screens share: tags, flag notes, the
/// allocation bar, the NAV sparkline and the holding card.

/// One colour per asset class, from the theme so dark mode follows.
Color assetClassColor(SpendColors c, String assetClass) => switch (assetClass) {
      'equity' => c.brand,
      'debt' => c.credit,
      'hybrid' => c.warn,
      _ => c.mutedLight,
    };

/// Green for up, red for down, plain for nothing either way.
Color gainColor(SpendColors c, num? value) =>
    value == null || value == 0 ? c.ink70 : (value > 0 ? c.credit : c.debit);

enum TagTone { neutral, brand, warn, good }

/// A small rounded label: "Direct", "Regular", "IDCW", "Waiting for NAV".
class FundTag extends StatelessWidget {
  const FundTag(this.label, {super.key, this.tone = TagTone.neutral});

  final String label;
  final TagTone tone;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final (background, foreground) = switch (tone) {
      TagTone.brand => (c.brand50, c.brandDark),
      TagTone.warn => (c.warnBg, c.warn),
      TagTone.good => (c.credit50, c.credit),
      TagTone.neutral => (c.chipNeutral, c.ink70),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(color: background, borderRadius: BorderRadius.circular(4)),
      child: Text(
        label,
        style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w800, letterSpacing: 0.3, color: foreground),
      ),
    );
  }
}

/// The plan and option tags for a scheme.
List<Widget> schemeTags({required bool isDirect, required bool isRegular, required bool isGrowth}) => [
      if (isDirect) const FundTag('Direct', tone: TagTone.good),
      if (isRegular) const FundTag('Regular', tone: TagTone.warn),
      FundTag(isGrowth ? 'Growth' : 'IDCW'),
    ];

/// "FUNDS  4", with something on the right when given.
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
            title.toUpperCase(),
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w800, letterSpacing: 1.1, color: c.muted),
          ),
        ),
        if (count != null) ...[
          const SizedBox(width: 8),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 1),
            decoration: BoxDecoration(color: c.chipNeutral, borderRadius: BorderRadius.circular(100)),
            child: Text('$count', style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w800, color: c.ink70)),
          ),
        ],
        if (trailing != null) ...[const Spacer(), trailing!],
      ],
    );
  }
}

/// A white card with the app's border, full width.
class FundCard extends StatelessWidget {
  const FundCard({super.key, required this.child, this.onTap, this.padding = const EdgeInsets.all(14)});

  final Widget child;
  final VoidCallback? onTap;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Material(
      color: c.surface,
      shape: RoundedRectangleBorder(side: BorderSide(color: c.line), borderRadius: BorderRadius.circular(T.rMd)),
      clipBehavior: Clip.antiAlias,
      child: InkWell(onTap: onTap, child: Padding(padding: padding, child: child)),
    );
  }
}

/// A tinted strip across the page: stale prices, payments to link, ranks
/// still coming.
class FundBanner extends StatelessWidget {
  const FundBanner({
    super.key,
    required this.icon,
    required this.text,
    this.tone = TagTone.warn,
    this.onTap,
    this.actionLabel,
  });

  final IconData icon;
  final String text;
  final TagTone tone;
  final VoidCallback? onTap;
  final String? actionLabel;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final (background, foreground) = switch (tone) {
      TagTone.brand => (c.brand50, c.brandDark),
      TagTone.warn => (c.warnBg, c.warn),
      TagTone.good => (c.credit50, c.credit),
      TagTone.neutral => (c.chipNeutral, c.ink70),
    };
    return Material(
      color: background,
      borderRadius: BorderRadius.circular(T.rSm),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(T.rSm),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(padding: const EdgeInsets.only(top: 1), child: Icon(icon, size: 16, color: foreground)),
              const SizedBox(width: 9),
              Expanded(
                child: Text(
                  text,
                  style: TextStyle(fontSize: 12.5, height: 1.4, fontWeight: FontWeight.w600, color: foreground),
                ),
              ),
              if (actionLabel != null) ...[
                const SizedBox(width: 8),
                Text(actionLabel!, style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w800, color: foreground)),
              ] else if (onTap != null)
                Icon(Icons.chevron_right, size: 16, color: foreground),
            ],
          ),
        ),
      ),
    );
  }
}

/// A label over a figure, for the stat grids.
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
        Text(label, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: c.muted)),
        const SizedBox(height: 2),
        FittedBox(
          fit: BoxFit.scaleDown,
          alignment: Alignment.centerLeft,
          child: Text(
            value,
            maxLines: 1,
            style: kNum.copyWith(fontSize: 15, fontWeight: FontWeight.w800, color: color ?? c.ink),
          ),
        ),
        if (sub != null)
          Text(sub!, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: color ?? c.muted)),
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
      if (rows.isNotEmpty) rows.add(const SizedBox(height: 12));
      rows.add(Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (var j = 0; j < columns; j++) ...[
            if (j > 0) const SizedBox(width: 12),
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
    final icon = switch (flag) {
      FundFlag.laggingCategory => Icons.trending_down,
      FundFlag.lowXirr => Icons.hourglass_bottom,
      _ => Icons.swap_horiz,
    };
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(color: c.warnBg, borderRadius: BorderRadius.circular(T.rSm)),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(padding: const EdgeInsets.only(top: 1), child: Icon(icon, size: 15, color: c.warn)),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  flagReason(holding, flag),
                  style: TextStyle(fontSize: 12.5, height: 1.35, fontWeight: FontWeight.w700, color: c.warn),
                ),
                if (explain) ...[
                  const SizedBox(height: 3),
                  Text(
                    flagExplainer(flag, rules),
                    style: TextStyle(fontSize: 11.5, height: 1.4, color: c.ink70),
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

/// The portfolio split by asset class, as one stacked bar and a legend.
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
          borderRadius: BorderRadius.circular(100),
          child: SizedBox(
            height: 12,
            child: Row(
              children: [
                for (final (i, slice) in shown.indexed) ...[
                  if (i > 0) Container(width: 2, color: c.surface),
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
        const SizedBox(height: 10),
        Wrap(
          spacing: 14,
          runSpacing: 6,
          children: [
            for (final slice in shown)
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    width: 9,
                    height: 9,
                    decoration: BoxDecoration(
                      color: assetClassColor(c, slice.assetClass),
                      borderRadius: BorderRadius.circular(3),
                    ),
                  ),
                  const SizedBox(width: 6),
                  Text(
                    '${assetClassLabel(slice.assetClass)} ${fundPercent(slice.percent, digits: slice.percent >= 10 ? 0 : 1)}',
                    style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: c.ink70),
                  ),
                  const SizedBox(width: 4),
                  Text(formatMoneyShort(slice.valueMinor), style: kNum.copyWith(fontSize: 11.5, color: c.muted)),
                ],
              ),
          ],
        ),
      ],
    );
  }
}

/// A year of NAVs as a line, with a soft fill beneath it.
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
        child: Center(child: Text('Not enough NAV history yet', style: TextStyle(fontSize: 12, color: c.muted))),
      );
    }
    final up = points.last.nav >= points.first.nav;
    return SizedBox(
      height: height,
      width: double.infinity,
      child: CustomPaint(
        painter: _SparklinePainter(
          values: [for (final point in points) point.nav],
          line: up ? c.credit : c.debit,
          baseline: c.line,
        ),
      ),
    );
  }
}

class _SparklinePainter extends CustomPainter {
  _SparklinePainter({required this.values, required this.line, required this.baseline});

  final List<double> values;
  final Color line;
  final Color baseline;

  @override
  void paint(Canvas canvas, Size size) {
    final low = values.reduce(math.min);
    final high = values.reduce(math.max);
    final span = high - low == 0 ? 1.0 : high - low;
    const pad = 4.0;
    final height = size.height - pad * 2;

    Offset at(int i) => Offset(
          size.width * i / (values.length - 1),
          pad + height - ((values[i] - low) / span) * height,
        );

    final path = Path()..moveTo(at(0).dx, at(0).dy);
    for (var i = 1; i < values.length; i++) {
      final point = at(i);
      path.lineTo(point.dx, point.dy);
    }

    final fill = Path.from(path)
      ..lineTo(size.width, size.height)
      ..lineTo(0, size.height)
      ..close();
    canvas.drawPath(
      fill,
      Paint()
        ..shader = LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [line.withValues(alpha: .22), line.withValues(alpha: .02)],
        ).createShader(Offset.zero & size),
    );

    // Where the year started, dashed, so up or down reads at a glance.
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
        ..strokeWidth = 2
        ..strokeJoin = StrokeJoin.round
        ..strokeCap = StrokeCap.round,
    );
    final last = at(values.length - 1);
    canvas.drawCircle(last, 3.2, Paint()..color = line);
  }

  @override
  bool shouldRepaint(_SparklinePainter old) => old.values != values || old.line != line || old.baseline != baseline;
}

/// "Category ranks coming": the peer table isn't built yet.
class RanksComingNote extends StatelessWidget {
  const RanksComingNote({super.key});

  @override
  Widget build(BuildContext context) => const FundBanner(
        icon: Icons.leaderboard_outlined,
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
      if (sip != null) h.sipRunning ? 'SIP ${sipLine(sip)}' : 'SIP stopped',
      if (h.pendingCount > 0) '${h.pendingCount} waiting for NAV',
      if (rank != null) '${rankLine(rank)} in category${peers?.basis == null ? '' : ' (${peers!.basis})'}',
    ];

    return FundCard(
      onTap: onTap,
      padding: const EdgeInsets.fromLTRB(14, 13, 14, 13),
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
                  style: TextStyle(fontSize: 14.5, height: 1.3, fontWeight: FontWeight.w800, color: c.ink),
                ),
              ),
              if (h.isRegular) ...[
                const SizedBox(width: 8),
                const Padding(padding: EdgeInsets.only(top: 2), child: FundTag('Regular', tone: TagTone.warn)),
              ],
            ],
          ),
          const SizedBox(height: 2),
          Text(
            [if (h.fundHouse != null) h.fundHouse!, h.categoryLabel].join(' · '),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 12, color: c.muted),
          ),
          const SizedBox(height: 10),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: FittedBox(
                  fit: BoxFit.scaleDown,
                  alignment: Alignment.centerLeft,
                  child: Text(
                    formatMoneyShort(h.valueMinor),
                    style: kNum.copyWith(fontSize: 20, fontWeight: FontWeight.w800, color: c.ink),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text(
                    '${signedMoneyShort(h.gainMinor)} (${fundPercent(h.gainPercent, signed: true)})',
                    style: kNum.copyWith(fontSize: 12.5, fontWeight: FontWeight.w800, color: gainColor(c, h.gainMinor)),
                  ),
                  Text(
                    h.xirrPercent == null ? 'XIRR after 3 months' : 'XIRR ${fundPercent(h.xirrPercent)}',
                    style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: c.muted),
                  ),
                ],
              ),
            ],
          ),
          const SizedBox(height: 2),
          Text(
            'Invested ${formatMoneyShort(h.investedMinor)}',
            style: TextStyle(fontSize: 11.5, color: c.muted),
          ),
          if (meta.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(meta.join(' · '), style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: c.ink70)),
          ],
          if (returns.isNotEmpty) ...[
            const SizedBox(height: 3),
            Text(returns.join(' · '), style: TextStyle(fontSize: 12, color: c.ink70)),
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
