import 'package:flutter/material.dart';
import '../../models/models.dart';
import '../ds/ds.dart';
import '../../utils/format.dart';
import 'home_grid.dart';

/// Money received for a purchase still to come - "Dad sent 8k for the
/// phone" - which is not income and should not look like it.
class EarmarksTile extends StatelessWidget {
  const EarmarksTile({super.key, required this.earmarks});

  final Earmarks earmarks;

  static const _shown = 2;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return HomeTile(
      label: 'Set aside for later',
      icon: DsIcons.piggyBank,
      onTap: () => _showAll(context),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TileFigure(formatMoney(earmarks.totalMinor)),
          const SizedBox(height: 2),
          Text(
            earmarks.count == 1 ? 'for one purchase to come' : 'for ${earmarks.count} purchases to come',
            style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
          ),
          const SizedBox(height: 8),
          for (final item in earmarks.items.take(_shown))
            Padding(
              padding: const EdgeInsets.only(bottom: 3),
              child: Text(
                '${item.label} · ${formatMoneyShort(item.leftMinor)} left',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: kNum.copyWith(fontSize: 13, height: 18 / 13, color: c.tx2),
              ),
            ),
          if (earmarks.items.length > _shown)
            Text('+${earmarks.items.length - _shown} more', style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3)),
        ],
      ),
    );
  }

  void _showAll(BuildContext context) {
    final c = context.c;
    showModalBottomSheet<void>(
      context: context,
      builder: (context) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          children: [
            const DsDragHandle(),
            const SizedBox(height: 4),
            Text(
              'Set aside for later',
              style: TextStyle(fontSize: 19, height: 24 / 19, fontWeight: FontWeight.w600, color: c.tx),
            ),
            const SizedBox(height: 6),
            Text(
              'Money you received for something still to buy. It is not counted as income; link the '
              'purchase to it from the transaction once you make it.',
              style: TextStyle(fontSize: 14, height: 20 / 14, color: c.tx2),
            ),
            const SizedBox(height: 16),
            for (final item in earmarks.items)
              Padding(
                padding: const EdgeInsets.only(bottom: 16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            item.label,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w500, color: c.tx),
                          ),
                        ),
                        Text(
                          formatMoney(item.leftMinor),
                          style: kNum.copyWith(fontSize: 15, fontWeight: FontWeight.w600, color: c.tx),
                        ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    DsMeter(
                      value: item.amountMinor > 0 ? (item.spentMinor / item.amountMinor).clamp(0.0, 1.0) : 0,
                      color: c.ac,
                    ),
                    const SizedBox(height: 4),
                    Text(
                      [
                        '${formatMoneyShort(item.spentMinor)} of ${formatMoneyShort(item.amountMinor)} used',
                        if (item.occurredAt != null) 'received ${formatShortDate(item.occurredAt!)}',
                      ].join(' · '),
                      style: kNum.copyWith(fontSize: 12, height: 16 / 12, color: c.tx3),
                    ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}
