import 'package:flutter/material.dart';
import '../../models/models.dart';
import '../../utils/format.dart';
import '../ds/ds.dart';
import 'home_grid.dart';

/// The way into savings goals from Home: what is put aside, what a month
/// keeps them on track, and the nearest two - or an invitation to add one.
class SavingsGoalsTile extends StatelessWidget {
  const SavingsGoalsTile({super.key, required this.goals, required this.onTap});

  final SavingsGoalList goals;
  final VoidCallback onTap;

  static const _shown = 2;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final open = goals.open;
    if (open.isEmpty) {
      return HomeTile(
        label: 'Savings goals',
        icon: DsIcons.target,
        onTap: onTap,
        child: Row(
          children: [
            Expanded(
              child: Text(
                'Saving up for something? Add it, and see what to put aside each month.',
                style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3),
              ),
            ),
            const SizedBox(width: 12),
            const DsIconTile(DsIcons.plus, tone: DsTone.ac),
          ],
        ),
      );
    }
    return HomeTile(
      label: open.length == 1 ? 'Savings goal' : 'Savings goals · ${open.length}',
      icon: DsIcons.target,
      onTap: onTap,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TileFigure(formatMoney(goals.savedMinor)),
          const SizedBox(height: 2),
          Text(
            goals.perMonthMinor > 0 ? 'put aside · ${formatMoneyShort(goals.perMonthMinor)} a month to stay on track' : 'put aside',
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: kNum.copyWith(fontSize: 12, height: 16 / 12, color: c.tx3),
          ),
          const SizedBox(height: 10),
          for (final goal in open.take(_shown))
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          goal.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 13, height: 18 / 13, fontWeight: FontWeight.w500, color: c.tx),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Text(
                        '${formatMoneyShort(goal.savedMinor)} / ${formatMoneyShort(goal.targetMinor)}',
                        style: kNum.copyWith(fontSize: 12, height: 16 / 12, color: c.tx2),
                      ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  DsMeter(value: (goal.percent / 100).clamp(0.0, 1.0), color: goal.isDone ? c.good : c.ac, height: 4),
                ],
              ),
            ),
          if (open.length > _shown)
            Text('+${open.length - _shown} more', style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3)),
        ],
      ),
    );
  }
}
