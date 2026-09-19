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
  const DailyBucket({super.key, required this.daily});

  final DailyBudget daily;

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
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: c.surface,
            border: Border.all(color: c.line),
            borderRadius: BorderRadius.circular(T.rMd),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                formatMoney(daily.bucketMinor.abs()),
                style: kNum.copyWith(fontSize: 26, fontWeight: FontWeight.w800, color: tint),
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
            ],
          ),
        ),
        // Said out loud, so the bucket never looks as though it simply
        // lost a purchase.
        if (daily.keptOutMinor > 0) ...[
          const SizedBox(height: 6),
          Text(
            '${formatMoney(daily.keptOutMinor)} in one-offs and trips kept out of this - still '
            'counted in the month.',
            style: TextStyle(fontSize: 11, height: 1.4, color: c.mutedLight),
          ),
        ],
      ],
    );
  }
}
