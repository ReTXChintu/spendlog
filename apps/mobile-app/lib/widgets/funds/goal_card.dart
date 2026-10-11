import 'package:flutter/material.dart';
import '../../models/fund_models.dart';
import '../../theme.dart';
import 'fund_text.dart';
import 'fund_widgets.dart';

/// One goal: the target and the date, how far along, what to put in each
/// month to get there, where, and an example fund or two to start with.
class GoalCard extends StatelessWidget {
  const GoalCard({
    super.key,
    required this.goal,
    this.holdings = const [],
    this.onTap,
    this.onExampleFund,
  });

  final FundGoal goal;

  /// The portfolio, to name the funds counted towards it.
  final List<FundHolding> holdings;
  final VoidCallback? onTap;
  final ValueChanged<ExampleFund>? onExampleFund;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final (tone, barColour) = switch (goal.status) {
      GoalStatus.done => (TagTone.good, c.credit),
      GoalStatus.behind => (TagTone.warn, c.warn),
      _ => (TagTone.brand, c.brand),
    };
    final linked = [
      for (final holding in holdings)
        if (goal.holdingIds.contains(holding.id)) shortSchemeName(holding.schemeName),
    ];
    final actual = goalActualLine(goal);
    final suggestion = goalSuggestionLine(goal);
    final showExamples = goal.status != GoalStatus.done && goal.exampleFunds.isNotEmpty;

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
                  goal.name,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 15.5, fontWeight: FontWeight.w800, color: c.ink),
                ),
              ),
              const SizedBox(width: 8),
              FundTag(goalStatusLabel(goal.status), tone: tone),
            ],
          ),
          const SizedBox(height: 3),
          Text(
            '${goalTargetLine(goal)} · ${monthsLeftLabel(goal.monthsLeft)}',
            style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: c.ink70),
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(100),
                  child: LinearProgressIndicator(
                    value: (goal.progress.percent / 100).clamp(0.0, 1.0),
                    minHeight: 7,
                    backgroundColor: c.track,
                    valueColor: AlwaysStoppedAnimation(barColour),
                  ),
                ),
              ),
              const SizedBox(width: 10),
              Text(
                fundPercent(goal.progress.percent, digits: 0),
                style: kNum.copyWith(fontSize: 12.5, fontWeight: FontWeight.w800, color: c.ink),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(goalSoFarLine(goal), style: TextStyle(fontSize: 11.5, color: c.muted)),
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
            decoration: BoxDecoration(
              color: goal.status == GoalStatus.done ? c.credit50 : c.brand50,
              borderRadius: BorderRadius.circular(T.rSm),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  goalPlanLine(goal),
                  style: kNum.copyWith(
                    fontSize: 16.5,
                    fontWeight: FontWeight.w800,
                    color: goal.status == GoalStatus.done ? c.credit : c.brandDark,
                  ),
                ),
                if (actual != null) ...[
                  const SizedBox(height: 2),
                  Text(actual, style: TextStyle(fontSize: 12, height: 1.35, color: c.ink70)),
                ],
              ],
            ),
          ),
          if (goal.warning != null && goal.status != GoalStatus.done) ...[
            const SizedBox(height: 8),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(padding: const EdgeInsets.only(top: 1), child: Icon(Icons.error_outline, size: 15, color: c.warn)),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    goal.warning!,
                    style: TextStyle(fontSize: 12.5, height: 1.4, fontWeight: FontWeight.w600, color: c.warn),
                  ),
                ),
              ],
            ),
          ],
          if (suggestion != null) ...[
            const SizedBox(height: 10),
            Text(suggestion, style: TextStyle(fontSize: 12, height: 1.45, color: c.ink70)),
          ],
          if (showExamples) ...[
            const SizedBox(height: 8),
            for (final fund in goal.exampleFunds)
              _ExampleFundRow(fund: fund, onTap: onExampleFund == null ? null : () => onExampleFund!(fund)),
          ],
          const SizedBox(height: 8),
          Text(
            linked.isEmpty ? 'No funds counted towards it yet. Tap to pick some.' : 'Counting: ${linked.join(', ')}',
            style: TextStyle(fontSize: 11.5, height: 1.4, color: c.muted),
          ),
        ],
      ),
    );
  }
}

class _ExampleFundRow extends StatelessWidget {
  const _ExampleFundRow({required this.fund, this.onTap});

  final ExampleFund fund;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final returns = [
      if (fund.oneYearPercent != null) '1y ${fundPercent(fund.oneYearPercent)}',
      if (fund.threeYearPercent != null) '3y ${fundPercent(fund.threeYearPercent)}',
    ].join(' · ');
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(T.rSm),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(
          children: [
            Icon(Icons.north_east, size: 14, color: c.mutedLight),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    shortSchemeName(fund.name),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: c.ink),
                  ),
                  if (returns.isNotEmpty) Text(returns, style: kNum.copyWith(fontSize: 11.5, color: c.muted)),
                ],
              ),
            ),
            if (onTap != null) Icon(Icons.add_circle_outline, size: 19, color: c.brand),
          ],
        ),
      ),
    );
  }
}

/// The table of returns the plans assume, in words.
class AssumptionsCard extends StatelessWidget {
  const AssumptionsCard({super.key, required this.assumptions});

  final List<GoalAssumption> assumptions;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    if (assumptions.isEmpty) return const SizedBox.shrink();
    return FundCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('How the plans are worked out', style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w800, color: c.ink)),
          const SizedBox(height: 4),
          Text(
            'What a goal can safely be in depends on how long there is. Each plan assumes a steady, middle-of-the-'
            'road return for that kind of fund - a guide to the monthly figure, not a promise.',
            style: TextStyle(fontSize: 12, height: 1.45, color: c.muted),
          ),
          for (final assumption in assumptions) ...[
            const SizedBox(height: 10),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 92,
                  child: Text(
                    assumptionRange(assumption),
                    style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: c.ink70),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '${assumption.category} · ~${fundPercent(assumption.annualReturnPercent)} a year',
                        style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: c.ink),
                      ),
                      if (assumption.why.isNotEmpty)
                        Text(assumption.why, style: TextStyle(fontSize: 11.5, height: 1.4, color: c.muted)),
                    ],
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
