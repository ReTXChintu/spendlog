import 'package:flutter/material.dart';
import '../../models/models.dart';
import '../../theme.dart';
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
      icon: Icons.savings_outlined,
      onTap: () => _showAll(context),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TileFigure(formatMoney(earmarks.totalMinor)),
          const SizedBox(height: 2),
          Text(
            earmarks.count == 1 ? 'for one purchase to come' : 'for ${earmarks.count} purchases to come',
            style: TextStyle(fontSize: 11.5, color: c.muted),
          ),
          const SizedBox(height: 8),
          for (final item in earmarks.items.take(_shown))
            Padding(
              padding: const EdgeInsets.only(bottom: 3),
              child: Text(
                '${item.label} · ${formatMoneyShort(item.leftMinor)} left',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 11.5, color: c.ink70),
              ),
            ),
          if (earmarks.items.length > _shown)
            Text('+${earmarks.items.length - _shown} more', style: TextStyle(fontSize: 11, color: c.mutedLight)),
        ],
      ),
    );
  }

  void _showAll(BuildContext context) {
    final c = context.c;
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
          children: [
            Text('Set aside for later', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800, color: c.ink)),
            const SizedBox(height: 4),
            Text(
              'Money you received for something still to buy. It is not counted as income; link the '
              'purchase to it from the transaction once you make it.',
              style: TextStyle(fontSize: 12, height: 1.45, color: c.muted),
            ),
            const SizedBox(height: 14),
            for (final item in earmarks.items)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
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
                            style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: c.ink),
                          ),
                        ),
                        Text(formatMoney(item.leftMinor), style: kNum.copyWith(fontSize: 13, color: c.ink)),
                      ],
                    ),
                    const SizedBox(height: 5),
                    ClipRRect(
                      borderRadius: BorderRadius.circular(100),
                      child: LinearProgressIndicator(
                        value: item.amountMinor > 0 ? (item.spentMinor / item.amountMinor).clamp(0.0, 1.0) : 0,
                        minHeight: 5,
                        backgroundColor: c.track,
                        valueColor: AlwaysStoppedAnimation(c.brand),
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      [
                        '${formatMoneyShort(item.spentMinor)} of ${formatMoneyShort(item.amountMinor)} used',
                        if (item.occurredAt != null) 'received ${formatShortDate(item.occurredAt!)}',
                      ].join(' · '),
                      style: TextStyle(fontSize: 11.5, color: c.muted),
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
