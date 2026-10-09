import 'package:flutter/material.dart';
import '../../models/models.dart';
import '../../theme.dart';
import '../../utils/format.dart';

/// What the pace means for the rest of the month, in one sentence.
///
/// Said as an instruction rather than a statistic: "keep to ₹300 a day"
/// is something to do at the till, "you are 18% ahead of plan" is not.
/// The daily figure already has the bills still due set aside, so keeping
/// to it is enough.
String paceMessage(MonthPace pace) {
  final days = pace.daysLeft;
  final span = days <= 1 ? 'for today' : 'for the next $days days';
  final safe = formatMoneyShort(pace.safeDailyMinor);
  final runOut = pace.runOutOn == null ? '' : formatIsoShortDate(pace.runOutOn!);

  switch (pace.status) {
    case 'over':
      final over = -pace.remainingMinor;
      return over > 0
          ? 'Over budget by ${formatMoneyShort(over)}. Anything more comes out of savings, so hold off on '
              'whatever can wait.'
          : 'The budget is used up. Anything more comes out of savings, so hold off on whatever can wait.';
    case 'high':
      if (pace.safeDailyMinor <= 0) {
        return "Pace is high — slow down. What's left is spoken for by bills still due"
            '${runOut.isEmpty ? '' : ', and at this rate it runs out by $runOut'}.';
      }
      return runOut.isEmpty
          ? 'Pace is high — slow down. Keep to $safe/day $span to stay inside the budget.'
          : "Pace is high — slow down. Keep to $safe/day or you'll run out by $runOut.";
    default:
      return 'On track · $safe/day is safe $span';
  }
}

/// The month against its budget, on Home.
///
/// Answers three questions in the order they come: how much is left, can
/// I keep going like this, and where did it go. Then what the month is
/// worth to savings if it ended now - the leftover is what goes in, so
/// that number is the reason to keep to the rest.
class MonthlyBudgetCard extends StatelessWidget {
  const MonthlyBudgetCard({super.key, required this.budget, required this.onEdit});

  final MonthlyBudgetStatus budget;

  /// The budget editor - also how a budget is first set.
  final VoidCallback onEdit;

  @override
  Widget build(BuildContext context) {
    if (!budget.configured) return _SetUp(budget: budget, onSetUp: onEdit);

    final c = context.c;
    final total = budget.budgetMinor ?? 0;
    final left = budget.leftMinor ?? total - budget.spentMinor;
    final over = left < 0;
    final pace = budget.pace;
    final tint = over || (pace?.isOver ?? false)
        ? c.debit
        : (pace?.isHigh ?? false)
            ? c.warn
            : c.brand;
    final fraction = total > 0 ? (budget.spentMinor / total).clamp(0.0, 1.0) : 0.0;
    final expected = pace != null && total > 0 ? (pace.expectedSpentMinor / total).clamp(0.0, 1.0) : null;
    final month = budget.month;
    final unassigned = budget.unassigned;
    final showUnassigned = unassigned != null && (unassigned.amountMinor > 0 || unassigned.spentMinor > 0);

    return Container(
      padding: const EdgeInsets.fromLTRB(16, 12, 8, 16),
      decoration: BoxDecoration(
        color: c.surface,
        border: Border.all(color: c.line),
        borderRadius: BorderRadius.circular(T.rMd),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.donut_large_outlined, size: 14, color: c.muted),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  month.label.isEmpty ? 'MONTHLY BUDGET' : 'MONTHLY BUDGET · ${month.label.toUpperCase()}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w800, letterSpacing: 0.6, color: c.muted),
                ),
              ),
              TextButton.icon(
                onPressed: onEdit,
                icon: const Icon(Icons.edit_outlined, size: 15),
                label: const Text('Edit budget'),
                style: TextButton.styleFrom(visualDensity: VisualDensity.compact),
              ),
            ],
          ),
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Bottom-aligned rather than on the baseline: the figure
                // sits in a FittedBox, which has no baseline to offer.
                Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Expanded(
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.end,
                        children: [
                          Flexible(
                            child: FittedBox(
                              fit: BoxFit.scaleDown,
                              alignment: Alignment.centerLeft,
                              child: Text(
                                formatMoney(left.abs()),
                                style: kNum.copyWith(
                                  fontSize: 28,
                                  fontWeight: FontWeight.w800,
                                  color: over ? c.debit : c.ink,
                                ),
                              ),
                            ),
                          ),
                          const SizedBox(width: 6),
                          Padding(
                            padding: const EdgeInsets.only(bottom: 5),
                            child: Text(
                              over ? 'over' : 'left',
                              style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: over ? c.debit : c.muted),
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 8),
                    Padding(
                      padding: const EdgeInsets.only(bottom: 5),
                      child: Text(
                        'of ${formatMoneyShort(total)}',
                        style: kNum.copyWith(fontSize: 13, fontWeight: FontWeight.w600, color: c.muted),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                _Meter(fraction: fraction, tint: tint, marker: expected),
                const SizedBox(height: 7),
                Text(
                  [
                    '${formatMoneyShort(budget.spentMinor)} spent',
                    if (month.dayOfMonth != null) 'day ${month.dayOfMonth} of ${month.daysInMonth}',
                    if (month.isCurrent) '${month.daysLeft} ${month.daysLeft == 1 ? 'day' : 'days'} left',
                  ].join(' · '),
                  style: TextStyle(fontSize: 12, color: c.muted),
                ),
                if (pace != null) ...[
                  const SizedBox(height: 12),
                  PaceBanner(pace: pace),
                ],
                if (budget.categories.isNotEmpty || showUnassigned) ...[
                  const SizedBox(height: 16),
                  Text(
                    'CATEGORY LIMITS',
                    style: TextStyle(fontSize: 10, fontWeight: FontWeight.w800, letterSpacing: 0.6, color: c.mutedLight),
                  ),
                  const SizedBox(height: 8),
                  for (final category in budget.categories)
                    _LimitRow(
                      name: category.name,
                      icon: categoryIcon(category.icon),
                      colour: parseHexColor(category.color, fallback: c.brand),
                      spentMinor: category.spentMinor,
                      limitMinor: category.limitMinor,
                      isOver: category.isOver,
                      isHigh: category.pace?.isHigh ?? false,
                    ),
                  if (showUnassigned)
                    _LimitRow(
                      name: 'Unplanned',
                      icon: Icons.more_horiz,
                      colour: c.muted,
                      spentMinor: unassigned.spentMinor,
                      limitMinor: unassigned.amountMinor,
                      isOver: unassigned.isOver,
                      isHigh: unassigned.pace?.isHigh ?? false,
                      note: unassigned.categories.isEmpty
                          ? 'Everything without a limit of its own'
                          : 'Mostly ${unassigned.categories.take(2).map((x) => x.name).join(' and ')}',
                    ),
                ],
                if (budget.bucket.configured) ...[
                  const SizedBox(height: 6),
                  Divider(height: 20, color: c.line),
                  _BucketRow(bucket: budget.bucket),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The pace sentence, tinted by how worried it should make you.
class PaceBanner extends StatelessWidget {
  const PaceBanner({super.key, required this.pace});

  final MonthPace pace;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final (background, foreground, icon) = switch (pace.status) {
      'over' => (c.debit50, c.debit, Icons.error_outline),
      'high' => (c.warnBg, c.warn, Icons.speed),
      _ => (c.credit50, c.credit, Icons.check_circle_outline),
    };

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(color: background, borderRadius: BorderRadius.circular(T.rSm)),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(padding: const EdgeInsets.only(top: 1), child: Icon(icon, size: 16, color: foreground)),
          const SizedBox(width: 9),
          Expanded(
            child: Text(
              paceMessage(pace),
              style: TextStyle(fontSize: 12.8, height: 1.4, fontWeight: FontWeight.w600, color: foreground),
            ),
          ),
        ],
      ),
    );
  }
}

/// The month's bar, with a tick where spending would be today if the
/// month were going exactly to plan.
class _Meter extends StatelessWidget {
  const _Meter({required this.fraction, required this.tint, this.marker});

  final double fraction;
  final Color tint;
  final double? marker;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return SizedBox(
      height: 14,
      child: LayoutBuilder(builder: (context, constraints) {
        final width = constraints.maxWidth;
        return Stack(
          clipBehavior: Clip.none,
          alignment: Alignment.centerLeft,
          children: [
            ClipRRect(
              borderRadius: BorderRadius.circular(100),
              child: LinearProgressIndicator(
                value: fraction,
                minHeight: 8,
                backgroundColor: c.track,
                valueColor: AlwaysStoppedAnimation(tint),
              ),
            ),
            if (marker != null && marker! > 0 && marker! < 1)
              Positioned(
                left: (width * marker!).clamp(1.0, width - 2) - 1,
                top: 0,
                bottom: 0,
                child: Tooltip(
                  message: 'Where spending would be today, on plan',
                  child: Container(width: 2, decoration: BoxDecoration(color: c.ink70, borderRadius: BorderRadius.circular(1))),
                ),
              ),
          ],
        );
      }),
    );
  }
}

class _LimitRow extends StatelessWidget {
  const _LimitRow({
    required this.name,
    required this.icon,
    required this.colour,
    required this.spentMinor,
    required this.limitMinor,
    required this.isOver,
    required this.isHigh,
    this.note,
  });

  final String name;
  final IconData icon;
  final Color colour;
  final int spentMinor;
  final int limitMinor;
  final bool isOver;
  final bool isHigh;
  final String? note;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final fraction = limitMinor > 0 ? (spentMinor / limitMinor).clamp(0.0, 1.0) : (spentMinor > 0 ? 1.0 : 0.0);
    final bar = isOver ? c.debit : (isHigh ? c.warn : colour);

    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 24,
            height: 24,
            decoration: BoxDecoration(color: colour.withValues(alpha: .14), borderRadius: BorderRadius.circular(7)),
            child: Icon(icon, size: 14, color: colour),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 12.8, fontWeight: FontWeight.w600, color: c.ink70),
                      ),
                    ),
                    const SizedBox(width: 8),
                    if (isOver)
                      Text(
                        'Over by ${formatMoneyShort(spentMinor - limitMinor)}',
                        style: kNum.copyWith(fontSize: 12, fontWeight: FontWeight.w800, color: c.debit),
                      )
                    else
                      Text.rich(
                        TextSpan(children: [
                          TextSpan(
                            text: formatMoneyShort(spentMinor),
                            style: TextStyle(fontWeight: FontWeight.w700, color: c.ink),
                          ),
                          TextSpan(text: ' / ${formatMoneyShort(limitMinor)}'),
                        ]),
                        style: kNum.copyWith(fontSize: 12, color: c.muted),
                      ),
                  ],
                ),
                const SizedBox(height: 5),
                ClipRRect(
                  borderRadius: BorderRadius.circular(100),
                  child: LinearProgressIndicator(
                    value: fraction,
                    minHeight: 5,
                    backgroundColor: c.track,
                    valueColor: AlwaysStoppedAnimation(bar),
                  ),
                ),
                if (note != null) ...[
                  const SizedBox(height: 3),
                  Text(
                    note!,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 11, color: c.mutedLight),
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

class _BucketRow extends StatelessWidget {
  const _BucketRow({required this.bucket});

  final BucketSummary bucket;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final change = bucket.thisMonthMinor;

    return Row(
      children: [
        Container(
          width: 24,
          height: 24,
          decoration: BoxDecoration(color: c.credit50, borderRadius: BorderRadius.circular(7)),
          child: Icon(Icons.savings_outlined, size: 14, color: c.credit),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Savings bucket', style: TextStyle(fontSize: 12.8, fontWeight: FontWeight.w600, color: c.ink70)),
              if (change != 0)
                Text(
                  '${change > 0 ? '+' : '−'}${formatMoneyShort(change.abs())} if the month ended now',
                  style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: change > 0 ? c.credit : c.debit),
                ),
            ],
          ),
        ),
        Text(
          formatMoneyShort(bucket.balanceMinor),
          style: kNum.copyWith(
            fontSize: 16,
            fontWeight: FontWeight.w800,
            color: bucket.balanceMinor < 0 ? c.debit : c.ink,
          ),
        ),
      ],
    );
  }
}

/// No budget yet: what one is, and the way to set it - with the old daily
/// budget's worth for the month offered as a place to start.
class _SetUp extends StatelessWidget {
  const _SetUp({required this.budget, required this.onSetUp});

  final MonthlyBudgetStatus budget;
  final VoidCallback onSetUp;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final suggested = budget.suggestedMonthlyMinor;

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: c.brand50,
        border: Border.all(color: c.brand100),
        borderRadius: BorderRadius.circular(T.rMd),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.donut_large_outlined, size: 18, color: c.brandDark),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'Set a monthly budget',
                  style: TextStyle(fontSize: 15, fontWeight: FontWeight.w800, color: c.ink),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            'One amount for the month, with rent, EMIs and SIPs counted in it. Share it out across dining, '
            'groceries, transport and the rest - whatever is left when the month ends goes to savings.',
            style: TextStyle(fontSize: 12.5, height: 1.5, color: c.ink70),
          ),
          if (suggested != null && suggested > 0) ...[
            const SizedBox(height: 6),
            Text(
              'Your old daily budget comes to about ${formatMoneyShort(suggested)} for this month.',
              style: TextStyle(fontSize: 12, height: 1.45, color: c.muted),
            ),
          ],
          const SizedBox(height: 12),
          FilledButton(
            onPressed: onSetUp,
            child: Text(suggested != null && suggested > 0 ? 'Start with ${formatMoneyShort(suggested)}' : 'Set a budget'),
          ),
        ],
      ),
    );
  }
}
