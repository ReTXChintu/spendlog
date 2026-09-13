import 'package:flutter/material.dart';
import '../models/models.dart';
import '../theme.dart';
import '../utils/format.dart';

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
  final BudgetPace? pace;

  const CardStrip({super.key, required this.cards, this.pace});

  @override
  Widget build(BuildContext context) {
    final warnings = cards.where((c) => c.state == 'over' || c.state == 'close').toList();
    final paceWarning = (pace?.configured ?? false) && pace!.state != 'ok' ? pace : null;

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
              state: paceWarning.state == 'over' ? 'over' : 'close',
              icon: Icons.trending_up,
              text: paceWarning.state == 'over'
                  ? "Past this period's salary by "
                      '${formatMoney(-paceWarning.remainingMinor)}.'
                  : '${formatMoney(paceWarning.perDayMinor)} a day left over '
                      '${paceWarning.daysLeft} days — lately it has been '
                      '${formatMoney(paceWarning.recentPerDayMinor)}.',
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
