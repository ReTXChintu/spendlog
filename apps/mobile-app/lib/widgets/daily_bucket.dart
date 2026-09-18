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
/// The strip is the part worth having. One number cannot say whether a
/// bucket was drained by one bad Saturday or by leaking every day, and
/// those two call for different things being done about them.
class DailyBucket extends StatelessWidget {
  const DailyBucket({super.key, required this.daily});

  final DailyBudget daily;

  /// How tall a day's bar gets, as a share of its half of the strip.
  static const _tallest = 0.9;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final saved = daily.bucketMinor >= 0;
    final tint = saved ? c.credit : c.debit;

    // Scaled against the largest single day either way, so the shape of
    // the period shows rather than one enormous day flattening the rest.
    final biggest = daily.days.fold<int>(
      1,
      (most, day) => day.deltaMinor.abs() > most ? day.deltaMinor.abs() : most,
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          decoration: BoxDecoration(
            color: saved ? c.credit50 : c.debit50,
            borderRadius: BorderRadius.circular(T.rMd),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  _Figure(
                    label: saved ? 'Put by' : 'Out of savings',
                    value: formatMoneyShort(daily.bucketMinor.abs()),
                    tint: tint,
                  ),
                  _Figure(
                    label: 'Spent',
                    value: formatMoneyShort(daily.spentMinor),
                    sub: 'of ${formatMoneyShort(daily.allowedMinor)}',
                  ),
                  _Figure(
                    label: 'Today',
                    value: formatMoneyShort(daily.todaySpentMinor),
                    sub: daily.todayLeftMinor >= 0
                        ? '${formatMoneyShort(daily.todayLeftMinor)} left'
                        : '${formatMoneyShort(-daily.todayLeftMinor)} over',
                  ),
                ],
              ),
              const SizedBox(height: 12),

              // A day each, above the line for what it put by and below
              // for what it took back.
              SizedBox(
                height: 40,
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    for (final day in daily.days)
                      Expanded(
                        child: Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 1),
                          child: _DayBar(
                            share: (day.deltaMinor.abs() / biggest) * _tallest,
                            under: day.deltaMinor >= 0,
                            track: c.track,
                            saved: c.credit,
                            over: c.debit,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 8),
        Text(
          saved
              ? '${formatMoney(daily.bucketMinor)} to move into savings when your salary lands'
                  '${daily.daysOver > 0 ? ', despite ${daily.daysOver} ${daily.daysOver == 1 ? 'day' : 'days'} over.' : ', with every day inside what you allowed.'}'
              : '${daily.daysOver} of ${daily.daysCounted} days went over. At this rate the next '
                  'salary starts ${formatMoney(-daily.bucketMinor)} down rather than up.',
          style: TextStyle(fontSize: 11.5, height: 1.45, color: c.muted),
        ),
        // Said out loud, so the bucket never looks as though it simply
        // lost a purchase.
        if (daily.keptOutMinor > 0) ...[
          const SizedBox(height: 4),
          Text(
            '${formatMoney(daily.keptOutMinor)} across ${daily.keptOutCount} '
            '${daily.keptOutCount == 1 ? 'one-off or trip payment' : 'one-off and trip payments'} '
            'kept out of the score. It still counts in the month.',
            style: TextStyle(fontSize: 11, height: 1.45, color: c.mutedLight),
          ),
        ],
      ],
    );
  }
}

/// One day of the strip: a bar in the top half or the bottom half.
class _DayBar extends StatelessWidget {
  const _DayBar({
    required this.share,
    required this.under,
    required this.track,
    required this.saved,
    required this.over,
  });

  final double share;
  final bool under;
  final Color track;
  final Color saved;
  final Color over;

  @override
  Widget build(BuildContext context) {
    // Two halves of equal height with the bar growing away from the middle,
    // so the midline is the same place on every day whatever it holds.
    final bar = Align(
      alignment: under ? Alignment.bottomCenter : Alignment.topCenter,
      child: FractionallySizedBox(
        heightFactor: share.clamp(0.04, 1.0),
        child: Container(
          decoration: BoxDecoration(
            color: under ? saved : over,
            borderRadius: BorderRadius.circular(2),
          ),
        ),
      ),
    );

    return Column(
      children: [
        Expanded(child: under ? bar : const SizedBox.shrink()),
        Expanded(child: under ? const SizedBox.shrink() : bar),
      ],
    );
  }
}

class _Figure extends StatelessWidget {
  const _Figure({required this.label, required this.value, this.sub, this.tint});

  final String label;
  final String value;
  final String? sub;
  final Color? tint;

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label.toUpperCase(),
          style: TextStyle(
            fontSize: 9.5,
            fontWeight: FontWeight.w700,
            letterSpacing: .5,
            color: c.muted,
          ),
        ),
        const SizedBox(height: 3),
        Text(value, style: kNum.copyWith(fontSize: 16, color: tint)),
        if (sub != null) ...[
          const SizedBox(height: 1),
          Text(sub!, style: TextStyle(fontSize: 10.5, color: c.muted)),
        ],
      ],
    );
  }
}
