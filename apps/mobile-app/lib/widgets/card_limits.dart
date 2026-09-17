import 'package:flutter/material.dart';
import '../models/models.dart';
import '../theme.dart';
import '../utils/format.dart';

/// Where every credit card stands.
///
/// Two questions, and they are genuinely different: how much of the card is
/// left, and how much of what you meant to spend is left. They used to
/// share one bar, the second as a mark on the first, and the second is the
/// one that changes what you do at a till - being 30% through a credit
/// limit tells you nothing, being 90% through your own budget tells you to
/// stop. As a mark it read as a footnote. So: a bar each.
///
/// The bank's bar has two pieces, because a credit limit is not spent only
/// by spending. Last month's bill is still holding part of it until it is
/// paid, and a card that showed the whole limit as free on the morning the
/// bill arrives was wrong by the size of the bill.
///
/// The colour follows the budget throughout: a card can sit comfortably
/// inside what the bank allows and well past what you allowed.
class CardLimits extends StatelessWidget {
  const CardLimits({super.key, required this.cards, this.onOpenAccounts});

  final List<CardStatus> cards;
  final VoidCallback? onOpenAccounts;

  /// Where a limit stops being a number and starts being a warning.
  static const _closeFraction = 0.8;

  @override
  Widget build(BuildContext context) {
    if (cards.isEmpty) return const SizedBox.shrink();

    final c = context.c;
    final noLimit = cards.where((card) => card.limitMinor == null).toList();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // A box each. Four cards in a column, each with a bar, a legend and
        // a second bar, ran together into one wall of lines - the last line
        // of one card sat closer to the next card's name than to its own,
        // and there was no telling which belonged to which.
        for (final card in cards)
          Container(
            margin: const EdgeInsets.only(bottom: 10),
            padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 12),
            decoration: BoxDecoration(
              color: c.surface,
              border: Border.all(color: c.line),
              borderRadius: BorderRadius.circular(T.rMd),
            ),
            child: _bar(context, card),
          ),
        if (noLimit.isNotEmpty)
          GestureDetector(
            onTap: onOpenAccounts,
            child: Text(
              noLimit.length == 1
                  ? '${noLimit.first.name} has no monthly limit set, so nothing can warn you about it.'
                  : '${noLimit.length} cards have no monthly limit set, so nothing can warn you about them.',
              style: TextStyle(fontSize: 11.5, height: 1.45, color: c.mutedLight),
            ),
          ),
      ],
    );
  }

  Widget _bar(BuildContext context, CardStatus card) {
    final c = context.c;

    final limit = card.limitMinor;
    final over = limit != null && card.spentMinor > limit;
    final close = limit != null && !over && card.spentMinor >= limit * _closeFraction;
    final tint = over ? c.debit : (close ? c.warn : c.brand);

    // The bank's bar, in two pieces: what last month's bill is still
    // holding, then what this cycle has added on top of it. Clamped as a
    // pair so a card over its credit limit fills the bar rather than
    // overflowing it.
    final scale = card.creditLimitMinor;
    final outstanding = card.outstandingMinor ?? 0;
    final billAt = (scale != null && scale > 0) ? (outstanding / scale).clamp(0.0, 1.0) : 0.0;
    final spendAt = (scale != null && scale > 0)
        ? (card.spentMinor / scale).clamp(0.0, 1.0 - billAt)
        : 0.0;

    final budgetAt =
        (limit != null && limit > 0) ? (card.spentMinor / limit).clamp(0.0, 1.0) : 0.0;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Expanded(
              child: Row(
                children: [
                  Flexible(
                    child: Text(
                      card.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700),
                    ),
                  ),
                  if (card.last4 != null) ...[
                    const SizedBox(width: 7),
                    Text('••${card.last4}', style: kNum.copyWith(fontSize: 11, color: c.muted)),
                  ],
                ],
              ),
            ),
            const SizedBox(width: 8),
            if (card.availableMinor != null && scale != null) ...[
              Text(formatMoney(card.availableMinor!), style: kNum.copyWith(fontSize: 13.5)),
              const SizedBox(width: 5),
              Text('left of ${formatMoneyShort(scale)}',
                  style: TextStyle(fontSize: 11.5, color: c.muted)),
            ] else ...[
              Text(formatMoney(card.spentMinor), style: kNum.copyWith(fontSize: 13.5)),
              const SizedBox(width: 5),
              Text('this cycle', style: TextStyle(fontSize: 11.5, color: c.muted)),
            ],
          ],
        ),

        // What the bank allows, and how much of it is already spoken for.
        if (scale != null) ...[
          const SizedBox(height: 7),
          ClipRRect(
            borderRadius: BorderRadius.circular(100),
            child: SizedBox(
              height: 9,
              child: Row(
                children: [
                  if (billAt > 0)
                    Expanded(
                      flex: (billAt * 1000).round(),
                      child: ColoredBox(color: c.muted.withValues(alpha: .5)),
                    ),
                  if (spendAt > 0)
                    Expanded(flex: (spendAt * 1000).round(), child: ColoredBox(color: tint)),
                  if (billAt + spendAt < 1)
                    Expanded(
                      flex: ((1 - billAt - spendAt) * 1000).round(),
                      child: ColoredBox(color: c.track),
                    ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 5),
          Wrap(
            spacing: 12,
            runSpacing: 2,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              if (outstanding > 0)
                _key(
                  c.muted.withValues(alpha: .5),
                  '${card.outstandingIsEstimate ? 'about ' : ''}'
                      '${formatMoney(outstanding)} bill pending'
                      '${card.billDueOn != null ? ', due ${formatShortDate(card.billDueOn!)}' : ''}',
                  c,
                ),
              _key(tint, '${formatMoney(card.spentMinor)} this cycle', c),
            ],
          ),
        ],

        // And what you allow yourself, which is the one that changes what
        // you do at a till.
        const SizedBox(height: 8),
        if (limit != null) ...[
          ClipRRect(
            borderRadius: BorderRadius.circular(100),
            child: SizedBox(
              height: 5,
              child: LinearProgressIndicator(
                value: budgetAt,
                minHeight: 5,
                backgroundColor: c.track,
                valueColor: AlwaysStoppedAnimation(tint),
              ),
            ),
          ),
          const SizedBox(height: 5),
        ],
        Wrap(
          spacing: 10,
          runSpacing: 2,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Text(
              _note(card, over: over, close: close),
              style: TextStyle(
                fontSize: 11.5,
                color: over ? c.debit : c.muted,
                fontWeight: over ? FontWeight.w700 : FontWeight.w400,
              ),
            ),
            // When the counter goes back to zero: the statement day, which
            // opens a cycle rather than closing one.
            if (card.periodIsCycle && card.statementOn != null)
              Text(
                'resets ${formatShortDate(card.statementOn!)}',
                style: TextStyle(fontSize: 11, color: c.muted.withValues(alpha: .8)),
              ),
          ],
        ),
      ],
    );
  }

  /// A dot and a label, naming one piece of the bank's bar.
  Widget _key(Color colour, String label, SpendColors c) => Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 7,
            height: 7,
            decoration: BoxDecoration(color: colour, shape: BoxShape.circle),
          ),
          const SizedBox(width: 5),
          Text(label, style: TextStyle(fontSize: 11, color: c.muted)),
        ],
      );

  String _note(CardStatus card, {required bool over, required bool close}) {
    final limit = card.limitMinor;
    if (limit == null) {
      return '${card.periodIsCycle ? 'This cycle' : 'This month'} · no limit of your own';
    }

    if (over) {
      return '${formatMoney(card.spentMinor - limit)} over your ${formatMoney(limit)} limit';
    }

    final left = '${formatMoney(limit - card.spentMinor)} left of your ${formatMoney(limit)} limit';
    return close ? '$left — worth slowing down' : left;
  }
}
