import 'package:flutter/material.dart';
import '../../models/fund_models.dart';
import '../ds/ds.dart';
import '../../utils/format.dart';
import '../funds/fund_text.dart';
import '../funds/fund_widgets.dart';
import 'home_grid.dart';

/// The way into Investments from Home: the portfolio's value and today's
/// move, or an invitation to start when there's nothing to show.
///
/// Fed by its own request, after the dashboard's, so a slow NAV source
/// costs this tile and nothing else - [portfolio] is null while it loads.
class InvestmentsTile extends StatelessWidget {
  const InvestmentsTile({super.key, required this.portfolio, this.failed = false, required this.onTap});

  final FundPortfolio? portfolio;
  final bool failed;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final data = portfolio;

    if (data == null) {
      return HomeTile(
        label: 'Investments',
        icon: DsIcons.trendingUp,
        onTap: onTap,
        child: Text(
          failed ? "Couldn't load your funds just now. Tap to open them." : 'Loading your funds…',
          style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3),
        ),
      );
    }

    if (data.isEmpty) {
      return HomeTile(
        label: 'Investments',
        icon: DsIcons.trendingUp,
        onTap: onTap,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Track your mutual funds',
                    style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'Add your SIPs and holdings: their value every day, which ones lag, and how much to put away for '
                    'a goal.',
                    style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 12),
            const DsIconTile(DsIcons.plus, tone: DsTone.ac),
          ],
        ),
      );
    }

    final t = data.totals;
    final day = t.dayChangeMinor;
    final flagged = data.holdings.where((holding) => holding.flags.isNotEmpty).length;
    final count = data.holdings.length;
    return HomeTile(
      label: 'Mutual funds · $count ${count == 1 ? 'fund' : 'funds'}',
      icon: DsIcons.trendingUp,
      onTap: onTap,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(child: TileFigure(formatMoneyShort(t.valueMinor), size: 28)),
              const SizedBox(width: 8),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text(
                    '${signedMoneyShort(day)} today',
                    style: kNum.copyWith(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w600, color: gainColor(c, day)),
                  ),
                  Text(
                    fundPercent(t.dayChangePercent, signed: true, digits: 2),
                    style: kNum.copyWith(fontSize: 12, height: 16 / 12, fontWeight: FontWeight.w500, color: gainColor(c, day)),
                  ),
                ],
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text.rich(
            TextSpan(children: [
              TextSpan(text: 'Invested ${formatMoneyShort(t.investedMinor)} · ', style: TextStyle(color: c.tx3)),
              TextSpan(
                text: '${signedMoneyShort(t.gainMinor)} (${fundPercent(t.gainPercent, signed: true)})',
                style: TextStyle(fontWeight: FontWeight.w600, color: gainColor(c, t.gainMinor)),
              ),
              if (t.xirrPercent != null)
                TextSpan(text: ' · XIRR ${fundPercent(t.xirrPercent)}', style: TextStyle(color: c.tx3)),
            ]),
            style: kNum.copyWith(fontSize: 13, height: 18 / 13),
          ),
          if (t.monthlySipMinor > 0 || flagged > 0) ...[
            const SizedBox(height: 4),
            Text.rich(
              TextSpan(children: [
                if (t.monthlySipMinor > 0)
                  TextSpan(text: 'SIPs ${perMonth(t.monthlySipMinor)}', style: TextStyle(color: c.tx2)),
                if (t.monthlySipMinor > 0 && flagged > 0) TextSpan(text: ' · ', style: TextStyle(color: c.tx3)),
                if (flagged > 0)
                  TextSpan(
                    text: '$flagged need${flagged == 1 ? 's' : ''} a look',
                    style: TextStyle(fontWeight: FontWeight.w600, color: c.warn),
                  ),
              ]),
              style: kNum.copyWith(fontSize: 13, height: 18 / 13, fontWeight: FontWeight.w500),
            ),
          ],
        ],
      ),
    );
  }
}
