import 'package:flutter/material.dart';
import '../models/models.dart';
import 'ds/ds.dart';
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
            final width = (constraints.maxWidth - (columns - 1) * 12) / columns;
            return Wrap(
              spacing: 12,
              runSpacing: 12,
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
            style: TextStyle(fontSize: 12, height: 17 / 12, color: c.tx3),
          ),
        ],
      ],
    );
  }
}


/// One network's answer: an inner tile on `sf2` (the best one is the
/// selected-item style: `acSoft` with an `acLine` ring), the network as a
/// label, the card, and the days of float as the figure.
class _Tile extends StatelessWidget {
  final String label;
  final CardStatus card;
  final bool isBest;

  const _Tile({required this.label, required this.card, required this.isBest});

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: isBest ? c.acSoft : c.sf2,
        border: Border.all(color: isBest ? c.acLine : c.ln),
        borderRadius: BorderRadius.circular(Ds.rXl),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              DsIcon(DsIcons.creditCard, size: 16, color: isBest ? c.ac : c.tx2),
              const SizedBox(width: 8),
              Expanded(child: DsLabel(label)),
              if (isBest) const DsBadge('Best', tone: DsTone.ac, onTinted: true),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            card.name,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
          ),
          const SizedBox(height: 4),
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Text(
                '${card.floatDays}',
                style: kNum.copyWith(fontSize: 22, height: 28 / 22, fontWeight: FontWeight.w600, color: c.tx),
              ),
              const SizedBox(width: 6),
              Text(
                'days to pay',
                style: TextStyle(fontSize: 13, fontWeight: FontWeight.w500, color: c.tx3),
              ),
            ],
          ),
          if (card.state == 'close' && card.availableMinor != null) ...[
            const SizedBox(height: 6),
            Row(
              children: [
                DsIcon(DsIcons.alertTriangle, size: 14, color: c.warn),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    '${formatMoney(card.availableMinor!)} of credit left',
                    style: TextStyle(
                      fontSize: 12,
                      height: 16 / 12,
                      fontWeight: FontWeight.w500,
                      color: c.warn,
                      fontFeatures: Ds.tabular,
                    ),
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

/// A quiet line with one verb-led action after it.
class _Note extends StatelessWidget {
  final String text;
  final String actionLabel;
  final VoidCallback? onTap;

  const _Note({required this.text, required this.actionLabel, this.onTap});

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        Expanded(
          child: Text(text, style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3)),
        ),
        if (onTap != null)
          TextButton(
            onPressed: onTap,
            style: TextButton.styleFrom(
              padding: const EdgeInsets.symmetric(horizontal: 8),
              minimumSize: const Size(0, 36),
            ),
            child: Text(actionLabel),
          ),
      ],
    );
  }
}
