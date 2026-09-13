import 'package:flutter/material.dart';
import '../models/models.dart';
import '../theme.dart';
import '../utils/format.dart';

/// Which card to reach for, one answer per network.
///
/// The question at a till is not "which card" but "which card that this
/// place takes", and in India that is mostly a question about networks — a
/// RuPay credit card pays over UPI and a Visa one does not. So a single
/// best card was always the wrong shape of answer.
class CardPicker extends StatelessWidget {
  final CardPicks picks;
  final VoidCallback? onOpenAccounts;

  const CardPicker({super.key, required this.picks, this.onOpenAccounts});

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    if (picks.best == null && picks.byNetwork.isEmpty) {
      return _Note(
        text: 'No card has a statement day set, so there is nothing to work out yet.',
        actionLabel: 'Add one',
        onTap: onOpenAccounts,
      );
    }

    final tiles = picks.byNetwork.isNotEmpty
        ? picks.byNetwork
            .map((row) => _Tile(
                  label: networkLabels[row.network] ?? row.network,
                  card: row.card,
                  isBest: row.card.accountId == picks.best?.accountId,
                ))
            .toList()
        : [_Tile(label: 'Best today', card: picks.best!, isBest: true)];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // Side by side while they fit, stacked when they do not. A card name
        // and a day count are both short, so two across is usually right.
        LayoutBuilder(
          builder: (context, constraints) {
            final columns = constraints.maxWidth > 380 ? 2 : 1;
            final width = (constraints.maxWidth - (columns - 1) * 10) / columns;
            return Wrap(
              spacing: 10,
              runSpacing: 10,
              children: tiles.map((tile) => SizedBox(width: width, child: tile)).toList(),
            );
          },
        ),
        if (picks.unknownNetwork.isNotEmpty) ...[
          const SizedBox(height: 10),
          _Note(
            text: picks.unknownNetwork.length == 1
                ? '${picks.unknownNetwork.first.name} has no network set, so it never appears above.'
                : '${picks.unknownNetwork.length} cards have no network set, so they never appear above.',
            actionLabel: 'Set it',
            onTap: onOpenAccounts,
          ),
        ],
        if (picks.byNetwork.isEmpty && picks.best != null) ...[
          const SizedBox(height: 8),
          Text(
            'Set a network on each card and this becomes one answer per network.',
            style: TextStyle(fontSize: 11.5, height: 1.45, color: c.mutedLight),
          ),
        ],
      ],
    );
  }
}

class _Tile extends StatelessWidget {
  final String label;
  final CardStatus card;
  final bool isBest;

  const _Tile({required this.label, required this.card, required this.isBest});

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    return Container(
      padding: const EdgeInsets.all(13),
      decoration: BoxDecoration(
        color: isBest ? c.brand50 : c.surface,
        border: Border.all(color: isBest ? c.brand : c.line),
        borderRadius: BorderRadius.circular(T.rMd),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  label.toUpperCase(),
                  style: TextStyle(
                    fontSize: 10.5,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 0.5,
                    color: c.muted,
                  ),
                ),
              ),
              if (isBest)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  decoration: BoxDecoration(color: c.brand, borderRadius: BorderRadius.circular(100)),
                  child: Text(
                    'BEST',
                    style: TextStyle(
                      fontSize: 8.5,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 0.4,
                      color: c.surface,
                    ),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 5),
          Text(
            card.name,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: c.ink),
          ),
          const SizedBox(height: 3),
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Text(
                '${card.floatDays}',
                style: kNum.copyWith(fontSize: 19, fontWeight: FontWeight.w800, color: c.ink),
              ),
              const SizedBox(width: 5),
              Text(
                'days to pay',
                style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: c.muted),
              ),
            ],
          ),
          if (card.state == 'close' && card.remainingMinor != null) ...[
            const SizedBox(height: 5),
            Row(
              children: [
                Icon(Icons.error_outline, size: 12, color: c.warn),
                const SizedBox(width: 5),
                Expanded(
                  child: Text(
                    '${formatMoney(card.remainingMinor!)} left of its limit',
                    style: TextStyle(fontSize: 11, color: c.warn),
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

class _Note extends StatelessWidget {
  final String text;
  final String actionLabel;
  final VoidCallback? onTap;

  const _Note({required this.text, required this.actionLabel, this.onTap});

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Text(text, style: TextStyle(fontSize: 12, height: 1.45, color: c.muted)),
        ),
        if (onTap != null)
          TextButton(
            onPressed: onTap,
            style: TextButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 8)),
            child: Text(actionLabel),
          ),
      ],
    );
  }
}
