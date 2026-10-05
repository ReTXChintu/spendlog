import 'package:flutter/material.dart';
import '../models/models.dart';
import '../theme.dart';
import '../utils/format.dart';

/// The daily allowance, and the pot filling or draining behind it.
///
/// Answers a question the pace block next to it cannot: when the salary
/// lands, how much of it can go straight into savings. The pace divides
/// what is left by the days remaining and moves every time anything is
/// spent - it is a forecast. This keeps score against what you decided a
/// day should cost, and a day that came in under is banked whatever
/// happens afterwards.
///
/// Kept to three numbers on purpose: spent, budget, and what that leaves
/// in savings. A chart of the days behind it is a second card someone can
/// ask for - this one answers "where do I stand" at a glance.
class DailyBucket extends StatelessWidget {
  const DailyBucket({super.key, required this.daily, this.framed = true});

  final DailyBudget daily;

  /// False when it sits inside a Home tile that already draws the box.
  final bool framed;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final saved = daily.bucketMinor >= 0;
    final tint = saved ? c.credit : c.debit;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          width: double.infinity,
          padding: framed ? const EdgeInsets.all(16) : EdgeInsets.zero,
          decoration: framed
              ? BoxDecoration(
                  color: c.surface,
                  border: Border.all(color: c.line),
                  borderRadius: BorderRadius.circular(T.rMd),
                )
              : null,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              FittedBox(
                fit: BoxFit.scaleDown,
                alignment: Alignment.centerLeft,
                child: Text(
                  formatMoney(daily.bucketMinor.abs()),
                  style: kNum.copyWith(fontSize: framed ? 26 : 22, fontWeight: FontWeight.w800, color: tint),
                ),
              ),
              Text(
                saved ? 'in savings' : 'from savings',
                style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: c.muted),
              ),
              const SizedBox(height: 8),
              Text(
                '${formatMoney(daily.spentMinor)} spent of ${formatMoney(daily.allowedMinor)} budget',
                style: TextStyle(fontSize: 12.5, color: c.ink70),
              ),
              // Said so a bucket bigger than the days explain is not a puzzle.
              if (daily.extraIncomeMinor > 0) ...[
                const SizedBox(height: 4),
                Text(
                  'Includes ${formatMoney(daily.extraIncomeMinor)} received on top of salary.',
                  style: TextStyle(fontSize: 11.5, color: c.credit),
                ),
              ],
              if (daily.refundedBackMinor > 0) ...[
                const SizedBox(height: 2),
                Text(
                  'And ${formatMoney(daily.refundedBackMinor)} back from refunds.',
                  style: TextStyle(fontSize: 11.5, color: c.credit),
                ),
              ],
            ],
          ),
        ),
        // Said out loud, so the bucket never looks as though it simply
        // lost a purchase.
        if (daily.keptOutMinor > 0) ...[
          const SizedBox(height: 6),
          Text(
            '${formatMoney(daily.keptOutMinor)} in one-offs, trips and fixed costs kept out of '
            'this - still counted in the month.',
            style: TextStyle(fontSize: 11, height: 1.4, color: c.mutedLight),
          ),
        ],
      ],
    );
  }
}
