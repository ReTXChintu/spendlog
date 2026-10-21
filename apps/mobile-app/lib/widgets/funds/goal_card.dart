import 'package:flutter/material.dart';
import '../../models/fund_models.dart';
import '../ds/ds.dart';
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
      GoalStatus.done => (TagTone.good, c.good),
      GoalStatus.behind => (TagTone.warn, c.warnFill),
      _ => (TagTone.good, c.ac),
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
                  style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
                ),
              ),
              const SizedBox(width: 8),
              FundTag(goalStatusLabel(goal.status), tone: tone),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            '${goalTargetLine(goal)} · ${monthsLeftLabel(goal.monthsLeft)}',
            style: kNum.copyWith(fontSize: 13, height: 18 / 13, color: c.tx2),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: DsMeter(
                  value: (goal.progress.percent / 100).clamp(0.0, 1.0),
                  color: barColour,
                  height: 6,
                ),
              ),
              const SizedBox(width: 10),
              Text(
                fundPercent(goal.progress.percent, digits: 0),
                style: kNum.copyWith(fontSize: 13, fontWeight: FontWeight.w600, color: c.tx),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(goalSoFarLine(goal), style: kNum.copyWith(fontSize: 12, height: 16 / 12, color: c.tx3)),
          const SizedBox(height: 12),
          Text(
            goalPlanLine(goal),
            style: kNum.copyWith(
              fontSize: 15,
              height: 20 / 15,
              fontWeight: FontWeight.w600,
              color: goal.status == GoalStatus.done ? c.good : c.tx,
            ),
          ),
          if (actual != null) ...[
            const SizedBox(height: 2),
            Text(actual, style: kNum.copyWith(fontSize: 13, height: 18 / 13, color: c.tx2)),
          ],
          if (goal.warning != null && goal.status != GoalStatus.done) ...[
            const SizedBox(height: 8),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 1),
                  child: DsIcon(DsIcons.alertTriangle, size: 16, color: c.warn),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    goal.warning!,
                    style: kNum.copyWith(fontSize: 13, height: 18 / 13, fontWeight: FontWeight.w500, color: c.warn),
                  ),
                ),
              ],
            ),
          ],
          if (suggestion != null || showExamples) ...[
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.fromLTRB(14, 12, 14, 8),
              decoration: BoxDecoration(
                color: c.sf2,
                border: Border.all(color: c.ln),
                borderRadius: BorderRadius.circular(Ds.rLg),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (suggestion != null) ...[
                    Text(suggestion, style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx2)),
                    const SizedBox(height: 4),
                  ],
                  if (showExamples)
                    for (final fund in goal.exampleFunds)
                      _ExampleFundRow(fund: fund, onTap: onExampleFund == null ? null : () => onExampleFund!(fund)),
                ],
              ),
            ),
          ],
          const SizedBox(height: 10),
          Text(
            linked.isEmpty ? 'No funds counted towards it yet. Tap to pick some.' : 'Counting: ${linked.join(', ')}',
            style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
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
      borderRadius: BorderRadius.circular(Ds.rMd),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(
          children: [
            DsIcon(DsIcons.arrowUpRight, size: 16, color: c.tx3),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    shortSchemeName(fund.name),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 13, height: 18 / 13, fontWeight: FontWeight.w600, color: c.tx),
                  ),
                  if (returns.isNotEmpty) Text(returns, style: kNum.copyWith(fontSize: 12, height: 16 / 12, color: c.tx3)),
                ],
              ),
            ),
            if (onTap != null) DsIcon(DsIcons.plus, size: 20, color: c.ac),
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
          Text(
            'How the plans are worked out',
            style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
          ),
          const SizedBox(height: 4),
          Text(
            'What a goal can safely be in depends on how long there is. Each plan assumes a steady, middle-of-the-'
            'road return for that kind of fund - a guide to the monthly figure, not a promise.',
            style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3),
          ),
          for (final (i, assumption) in assumptions.indexed)
            Container(
              padding: const EdgeInsets.symmetric(vertical: 10),
              decoration: BoxDecoration(
                border: i == 0 ? null : Border(top: BorderSide(color: c.ln)),
              ),
              margin: EdgeInsets.only(top: i == 0 ? 6 : 0),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 96,
                    child: Text(
                      assumptionRange(assumption),
                      style: TextStyle(fontSize: 12, height: 16 / 12, fontWeight: FontWeight.w600, color: c.tx2),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '${assumption.category} · ~${fundPercent(assumption.annualReturnPercent)} a year',
                          style: kNum.copyWith(fontSize: 13, height: 18 / 13, fontWeight: FontWeight.w600, color: c.tx),
                        ),
                        if (assumption.why.isNotEmpty)
                          Text(assumption.why, style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3)),
                      ],
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
