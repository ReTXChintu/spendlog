import 'package:flutter/material.dart';
import '../models/models.dart';
import '../theme.dart';
import '../utils/format.dart';
import 'home/monthly_budget_card.dart';

/// The pace the strip can warn about: the monthly budget's, and only for
/// the month running now. A month that is over has no pace left to keep
/// to - its bar says how it went - and with no budget there is no pace.
MonthPace? currentMonthPace(MonthlyBudgetStatus? budget) {
  if (budget == null || !budget.configured || !budget.month.isCurrent) return null;
  return budget.pace;
}

/// Anything that needs saying before the next payment rather than after it.
///
/// Only warnings. Which card to reach for is a decision, so it lives on the
/// dashboard with the other decisions - two screens answering the same
/// question in different words is worse than either answer.
///
/// Deliberately quiet when nothing is wrong. A warning that is always on
/// screen stops being read, and then so does the real one.
class CardStrip extends StatelessWidget {
  final List<CardStatus> cards;

  /// The monthly budget's pace, for the month running now - the same pace,
  /// in the same words, as the budget card on Home. Null for a past month
  /// or with no budget set, and then there is nothing to warn about.
  final MonthPace? pace;

  const CardStrip({super.key, required this.cards, this.pace});

  @override
  Widget build(BuildContext context) {
    final warnings = cards.where((c) => c.state == 'over' || c.state == 'close').toList();
    final paceWarning = pace != null && (pace!.isHigh || pace!.isOver) ? pace : null;

    if (warnings.isEmpty && paceWarning == null) {
      return const SizedBox.shrink();
    }

    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final card in warnings)
            _Row(
              state: card.state,
              icon: Icons.error_outline,
              text: card.state == 'over'
                  ? '${card.name} is past its ${formatMoneyShort(card.limitMinor ?? 0)} limit '
                      'for this cycle.'
                  : '${card.name} has ${formatMoney(card.remainingMinor ?? 0)} left of its limit '
                      'this cycle.',
            ),
          if (paceWarning != null)
            _Row(
              state: paceWarning.isOver ? 'over' : 'close',
              icon: Icons.trending_up,
              text: paceMessage(paceWarning),
            ),
        ],
      ),
    );
  }
}

class _Row extends StatelessWidget {
  final String state;
  final IconData icon;
  final String text;

  const _Row({required this.state, required this.icon, required this.text});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final (background, foreground) = switch (state) {
      'over' => (c.debit50, c.debit),
      'close' => (c.warnBg, c.warn),
      _ => (c.brand50, c.brandDark),
    };

    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
      decoration: BoxDecoration(color: background, borderRadius: BorderRadius.circular(T.rMd)),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 15, color: foreground),
          const SizedBox(width: 9),
          Expanded(
            child: Text(
              text,
              style: TextStyle(fontSize: 12.5, height: 1.45, color: foreground),
            ),
          ),
        ],
      ),
    );
  }
}
