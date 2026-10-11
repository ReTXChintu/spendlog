import 'package:flutter/material.dart';
import '../../models/fund_models.dart';
import '../../theme.dart';
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
        icon: Icons.savings_outlined,
        onTap: onTap,
        child: Text(
          failed ? "Couldn't load your funds just now. Tap to open them." : 'Loading your funds…',
          style: TextStyle(fontSize: 12, height: 1.4, color: c.muted),
        ),
      );
    }

    if (data.isEmpty) {
      return HomeTile(
        label: 'Investments',
        icon: Icons.savings_outlined,
        onTap: onTap,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Track your mutual funds', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w800, color: c.ink)),
                  const SizedBox(height: 4),
                  Text(
                    'Add your SIPs and holdings: their value every day, which ones lag, and how much to put away for '
                    'a goal.',
                    style: TextStyle(fontSize: 11.5, height: 1.4, color: c.muted),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 10),
            Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(color: c.brand50, borderRadius: BorderRadius.circular(12)),
              child: Icon(Icons.add, color: c.brand),
            ),
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
      icon: Icons.savings_outlined,
      onTap: onTap,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(child: TileFigure(formatMoneyShort(t.valueMinor), size: 24)),
              const SizedBox(width: 8),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text(
                    '${signedMoneyShort(day)} today',
                    style: kNum.copyWith(fontSize: 12.5, fontWeight: FontWeight.w800, color: gainColor(c, day)),
                  ),
                  Text(
                    fundPercent(t.dayChangePercent, signed: true, digits: 2),
                    style: kNum.copyWith(fontSize: 11.5, fontWeight: FontWeight.w600, color: gainColor(c, day)),
                  ),
                ],
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text.rich(
            TextSpan(children: [
              TextSpan(text: 'Invested ${formatMoneyShort(t.investedMinor)} · ', style: TextStyle(color: c.muted)),
              TextSpan(
                text: '${signedMoneyShort(t.gainMinor)} (${fundPercent(t.gainPercent, signed: true)})',
                style: TextStyle(fontWeight: FontWeight.w700, color: gainColor(c, t.gainMinor)),
              ),
              if (t.xirrPercent != null)
                TextSpan(text: ' · XIRR ${fundPercent(t.xirrPercent)}', style: TextStyle(color: c.muted)),
            ]),
            style: const TextStyle(fontSize: 11.5, height: 1.4),
          ),
          if (t.monthlySipMinor > 0 || flagged > 0) ...[
            const SizedBox(height: 4),
            Text.rich(
              TextSpan(children: [
                if (t.monthlySipMinor > 0)
                  TextSpan(text: 'SIPs ${perMonth(t.monthlySipMinor)}', style: TextStyle(color: c.ink70)),
                if (t.monthlySipMinor > 0 && flagged > 0) TextSpan(text: ' · ', style: TextStyle(color: c.muted)),
                if (flagged > 0)
                  TextSpan(
                    text: '$flagged need${flagged == 1 ? 's' : ''} a look',
                    style: TextStyle(fontWeight: FontWeight.w700, color: c.warn),
                  ),
              ]),
              style: const TextStyle(fontSize: 11.5, height: 1.4, fontWeight: FontWeight.w600),
            ),
          ],
        ],
      ),
    );
  }
}
