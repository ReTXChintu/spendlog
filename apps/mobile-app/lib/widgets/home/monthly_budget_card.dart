import 'package:flutter/material.dart';
import '../../models/models.dart';
import '../../models/subscription_models.dart';
import '../ds/ds.dart';
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

/// The month against its budget, on Home: the "Free to spend" hero.
///
/// Answers three questions in the order they come: how much is left, can
/// I keep going like this, and where did it go. Then what the month is
/// worth to savings if it ended now - the leftover is what goes in, so
/// that number is the reason to keep to the rest.
///
/// The pace bar is the design's signature: ink for what is spent, hatching
/// for the fixed costs still due (promised, not yet spent), the sunk track
/// for what is free, and a thin cobalt tick where spending would be today
/// on plan.
class MonthlyBudgetCard extends StatelessWidget {
  const MonthlyBudgetCard({
    super.key,
    required this.budget,
    required this.onEdit,
    this.subscriptions,
    this.onSubscriptions,
  });

  final MonthlyBudgetStatus budget;

  /// The budget editor - also how a budget is first set.
  final VoidCallback onEdit;

  /// What renews, when there is anything: its line sits under the bucket,
  /// since renewals are the fixed costs that creep.
  final SubscriptionTotals? subscriptions;
  final VoidCallback? onSubscriptions;

  @override
  Widget build(BuildContext context) {
    if (!budget.configured) return _SetUp(budget: budget, onSetUp: onEdit);

    final c = context.c;
    final total = budget.budgetMinor ?? 0;
    final left = budget.leftMinor ?? total - budget.spentMinor;
    final over = left < 0;
    final pace = budget.pace;
    final promisedMinor = pace == null ? 0 : pace.fixedStillDueMinor.clamp(0, left < 0 ? 0 : left);
    final freeMinor = (left - promisedMinor).clamp(0, total);
    final spentFraction = total > 0 ? (budget.spentMinor / total).clamp(0.0, 1.0) : 0.0;
    final promisedFraction = total > 0 ? (promisedMinor / total).clamp(0.0, 1.0) : 0.0;
    final expected = pace != null && total > 0 && budget.month.isCurrent
        ? (pace.expectedSpentMinor / total).clamp(0.0, 1.0)
        : null;
    final month = budget.month;
    final unassigned = budget.unassigned;
    final showUnassigned = unassigned != null && (unassigned.amountMinor > 0 || unassigned.spentMinor > 0);
    final todayFraction = month.isCurrent && month.dayOfMonth != null && month.daysInMonth > 0
        ? (month.dayOfMonth! / month.daysInMonth).clamp(0.0, 1.0)
        : null;

    final eyebrow = [
      if (month.label.isNotEmpty) month.label,
      if (month.dayOfMonth != null) 'day ${month.dayOfMonth} of ${month.daysInMonth}',
    ].join(' · ');

    final explain = <InlineSpan>[
      if (month.isCurrent) TextSpan(text: '${month.daysLeft} ${month.daysLeft == 1 ? 'day' : 'days'} left'),
      if (month.isCurrent && pace != null && pace.safeDailyMinor > 0 && !over) ...[
        const TextSpan(text: ' · about '),
        TextSpan(
          text: '${formatMoneyShort(pace.safeDailyMinor)}/day',
          style: TextStyle(fontWeight: FontWeight.w600, color: c.tx),
        ),
      ],
      if (!month.isCurrent) TextSpan(text: '${formatMoneyShort(budget.spentMinor)} spent'),
    ];

    return DsCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: DsLabel(eyebrow.isEmpty ? 'Monthly budget' : eyebrow),
              ),
              TextButton.icon(
                onPressed: onEdit,
                icon: const DsIcon(DsIcons.pencil, size: 16),
                label: const Text('Edit budget'),
                style: TextButton.styleFrom(
                  visualDensity: VisualDensity.compact,
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                ),
              ),
            ],
          ),
          Text(
            over ? 'Over budget' : 'Free to spend',
            style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx2),
          ),
          const SizedBox(height: 2),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(
              over ? formatMoneyShort(left.abs()) : formatMoneyShort(freeMinor),
              style: kNum.copyWith(
                fontSize: 34,
                height: 40 / 34,
                fontWeight: FontWeight.w600,
                letterSpacing: -0.68,
                color: over ? c.crit : c.tx,
              ),
            ),
          ),
          if (explain.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text.rich(
              TextSpan(children: explain),
              style: kNum.copyWith(fontSize: 15, height: 22 / 15, color: c.tx2),
            ),
          ],
          const SizedBox(height: 14),
          Wrap(
            spacing: 24,
            runSpacing: 10,
            children: [
              DsInlineStat(label: 'Budget', value: formatMoneyShort(total)),
              DsInlineStat(
                label: over ? 'Over by' : 'Left',
                value: formatMoneyShort(left.abs()),
                valueColor: over ? c.crit : null,
              ),
              DsInlineStat(label: 'Spent', value: formatMoneyShort(budget.spentMinor)),
            ],
          ),
          const SizedBox(height: 16),
          DsPaceBar(
            spent: spentFraction,
            promised: promisedFraction,
            today: expected,
            todayLabel: expected == null ? null : 'Today · ${formatMoneyShort(pace!.expectedSpentMinor)}',
            semanticsLabel: [
              'Spent ${formatMoneyShort(budget.spentMinor)} of ${formatMoneyShort(total)}',
              if (promisedMinor > 0) 'promised ${formatMoneyShort(promisedMinor)}',
              'free ${formatMoneyShort(freeMinor)}',
              if (expected != null) 'on plan by today ${formatMoneyShort(pace!.expectedSpentMinor)}',
            ].join(', '),
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 20,
            runSpacing: 6,
            children: [
              DsLegendItem(swatch: DsSwatch.spent, label: 'Spent', value: formatMoneyShort(budget.spentMinor)),
              if (promisedMinor > 0)
                DsLegendItem(swatch: DsSwatch.promised, label: 'Promised', value: formatMoneyShort(promisedMinor)),
              DsLegendItem(swatch: DsSwatch.free, label: 'Free', value: formatMoneyShort(freeMinor)),
              if (expected != null) const DsLegendItem(swatch: DsSwatch.today, label: 'Where you should be today'),
            ],
          ),
          if (pace != null) ...[
            const SizedBox(height: 14),
            PaceBanner(pace: pace),
          ],
          if (budget.categories.isNotEmpty || showUnassigned) ...[
            const SizedBox(height: 20),
            Row(
              children: [
                Expanded(
                  child: Text(
                    'Category limits',
                    style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            for (final category in budget.categories)
              _LimitRow(
                name: category.name,
                spentMinor: category.spentMinor,
                limitMinor: category.limitMinor,
                isOver: category.isOver,
                isHigh: category.pace?.isHigh ?? false,
                today: todayFraction,
              ),
            if (showUnassigned)
              _LimitRow(
                name: 'Unplanned',
                spentMinor: unassigned.spentMinor,
                limitMinor: unassigned.amountMinor,
                isOver: unassigned.isOver,
                isHigh: unassigned.pace?.isHigh ?? false,
                today: todayFraction,
                note: unassigned.categories.isEmpty
                    ? 'Everything without a limit of its own'
                    : 'Mostly ${unassigned.categories.take(2).map((x) => x.name).join(' and ')}',
              ),
          ],
          if (budget.bucket.configured) ...[
            const SizedBox(height: 4),
            Divider(height: 24, color: c.ln),
            _BucketRow(bucket: budget.bucket),
          ],
          if (subscriptions != null && !subscriptions!.isEmpty) ...[
            if (!budget.bucket.configured) const SizedBox(height: 4),
            Divider(height: 24, color: c.ln),
            SubscriptionsRow(totals: subscriptions!, onTap: onSubscriptions),
          ],
        ],
      ),
    );
  }
}

/// What renews: the monthly total, and what this month still takes.
class SubscriptionsRow extends StatelessWidget {
  const SubscriptionsRow({super.key, required this.totals, this.onTap});

  final SubscriptionTotals totals;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final count = totals.dueThisMonthCount;
    final foot = count == 0
        ? 'Nothing renews this month'
        : '$count ${count == 1 ? 'renewal' : 'renewals'} this month'
            '${totals.upcomingThisMonthMinor > 0 ? ' · ${formatMoneyShort(totals.upcomingThisMonthMinor)} still to come' : ''}'
            '${totals.alertCount > 0 ? ' · ${totals.alertCount} need${totals.alertCount == 1 ? 's' : ''} a look' : ''}';
    return InkWell(
      key: const ValueKey('budget-subscriptions-row'),
      onTap: onTap,
      borderRadius: BorderRadius.circular(Ds.rMd),
      child: Row(
        children: [
          DsIconTile(DsIcons.repeat, tone: DsTone.neutral, color: c.tx2, size: 36, iconSize: 18),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Subscriptions', style: TextStyle(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w500, color: c.tx)),
                const SizedBox(height: 2),
                Text(foot, style: TextStyle(fontSize: 12, height: 16 / 12, color: totals.alertCount > 0 ? c.warn : c.tx3)),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Text(
            '${formatMoneyShort(totals.monthlyMinor)}/mo',
            style: kNum.copyWith(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
          ),
          if (onTap != null) ...[const SizedBox(width: 4), DsIcon(DsIcons.chevronRight, size: 18, color: c.tx3)],
        ],
      ),
    );
  }
}

/// The pace sentence, as a callout tinted by how worried it should make you.
class PaceBanner extends StatelessWidget {
  const PaceBanner({super.key, required this.pace});

  final MonthPace pace;

  @override
  Widget build(BuildContext context) {
    final tone = switch (pace.status) {
      'over' => DsTone.crit,
      'high' => DsTone.warn,
      _ => DsTone.good,
    };
    return DsCallout(title: paceMessage(pace), tone: tone);
  }
}

/// One category limit: a 10 px limit bar, green while on pace and red once
/// over pace or over the limit, with the same today tick as the pace bar.
class _LimitRow extends StatelessWidget {
  const _LimitRow({
    required this.name,
    required this.spentMinor,
    required this.limitMinor,
    required this.isOver,
    required this.isHigh,
    this.today,
    this.note,
  });

  final String name;
  final int spentMinor;
  final int limitMinor;
  final bool isOver;
  final bool isHigh;
  final double? today;
  final String? note;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final fraction = limitMinor > 0 ? (spentMinor / limitMinor).clamp(0.0, 1.0) : (spentMinor > 0 ? 1.0 : 0.0);
    final problem = isOver || isHigh;
    final percent = limitMinor > 0 ? (spentMinor * 100 / limitMinor).round() : null;
    final leftMinor = limitMinor - spentMinor;

    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: Text(
                  name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w500, color: c.tx),
                ),
              ),
              const SizedBox(width: 8),
              Text.rich(
                TextSpan(children: [
                  TextSpan(
                    text: formatMoneyShort(spentMinor),
                    style: TextStyle(fontWeight: FontWeight.w600, color: c.tx),
                  ),
                  TextSpan(text: ' of ${formatMoneyShort(limitMinor)}'),
                ]),
                style: kNum.copyWith(fontSize: 13, height: 18 / 13, color: c.tx3),
              ),
            ],
          ),
          const SizedBox(height: 6),
          DsMeter(
            value: fraction,
            height: 10,
            color: problem ? c.critFill : c.good,
            today: today,
          ),
          const SizedBox(height: 4),
          if (isOver)
            Text(
              'Over by ${formatMoneyShort(spentMinor - limitMinor)}',
              style: kNum.copyWith(fontSize: 12, height: 16 / 12, fontWeight: FontWeight.w600, color: c.crit),
            )
          else if (percent != null)
            Text(
              '$percent% used · ${formatMoneyShort(leftMinor)} left',
              style: kNum.copyWith(
                fontSize: 12,
                height: 16 / 12,
                fontWeight: isHigh ? FontWeight.w600 : FontWeight.w400,
                color: isHigh ? c.crit : c.tx3,
              ),
            ),
          if (note != null)
            Text(
              note!,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
            ),
        ],
      ),
    );
  }
}

/// The savings bucket, and what this month would add to it.
class _BucketRow extends StatelessWidget {
  const _BucketRow({required this.bucket});

  final BucketSummary bucket;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final change = bucket.thisMonthMinor;

    return Row(
      children: [
        const DsIconTile(DsIcons.piggyBank, tone: DsTone.good, size: 36),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Savings bucket',
                style: TextStyle(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w500, color: c.tx),
              ),
              if (change != 0)
                Text(
                  '${change > 0 ? '+' : '−'}${formatMoneyShort(change.abs())} if the month ended now',
                  style: kNum.copyWith(
                    fontSize: 13,
                    height: 18 / 13,
                    fontWeight: FontWeight.w600,
                    color: change > 0 ? c.good : c.crit,
                  ),
                ),
            ],
          ),
        ),
        const SizedBox(width: 8),
        Text(
          formatMoneyShort(bucket.balanceMinor),
          style: kNum.copyWith(
            fontSize: 17,
            height: 24 / 17,
            fontWeight: FontWeight.w600,
            color: bucket.balanceMinor < 0 ? c.crit : c.tx,
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

    return DsCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const DsIconTile(DsIcons.target, tone: DsTone.ac),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  'Set a monthly budget',
                  style: TextStyle(fontSize: 17, height: 24 / 17, fontWeight: FontWeight.w600, color: c.tx),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Text(
            'One amount for the month, with rent, EMIs and SIPs counted in it. Share it out across dining, '
            'groceries, transport and the rest - whatever is left when the month ends goes to savings.',
            style: TextStyle(fontSize: 14, height: 20 / 14, color: c.tx2),
          ),
          if (suggested != null && suggested > 0) ...[
            const SizedBox(height: 6),
            Text(
              'Your old daily budget comes to about ${formatMoneyShort(suggested)} for this month.',
              style: kNum.copyWith(fontSize: 13, height: 18 / 13, color: c.tx3),
            ),
          ],
          const SizedBox(height: 16),
          FilledButton(
            onPressed: onSetUp,
            child: Text(suggested != null && suggested > 0 ? 'Start with ${formatMoneyShort(suggested)}' : 'Set a budget'),
          ),
        ],
      ),
    );
  }
}

