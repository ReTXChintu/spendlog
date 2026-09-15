import 'package:flutter/material.dart';
import '../models/models.dart';
import '../theme.dart';
import '../utils/format.dart';

/// Where every credit card stands, as a bar each.
///
/// Two different limits sit on one bar, and keeping them apart is the whole
/// point of it. The bar's length is spending against the *credit* limit,
/// which is the bank's answer to how far the card goes. The mark on it is
/// your own limit, which is the answer that changes what you do at a till —
/// being 30% through a credit limit tells you nothing, and being 90%
/// through what you meant to spend tells you to stop.
///
/// So the colour follows the mark rather than the length: a card can sit
/// comfortably inside what the bank allows and well past what you allowed.
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
        for (final card in cards)
          Padding(
            padding: const EdgeInsets.only(bottom: 16),
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

    // Against the credit limit where there is one, and against your own
    // where there is not. A bar needs something to be a fraction of.
    final scale = card.creditLimitMinor ?? card.limitMinor;
    final used = (scale != null && scale > 0) ? (card.spentMinor / scale).clamp(0.0, 1.0) : null;
    final percent = (scale != null && scale > 0) ? ((card.spentMinor / scale) * 100).round() : null;

    final limit = card.limitMinor;
    final over = limit != null && card.spentMinor > limit;
    final close = limit != null && !over && card.spentMinor >= limit * _closeFraction;
    final tint = over ? c.debit : (close ? c.warn : c.brand);

    // Where your own limit falls along the bar. Only worth drawing when it
    // sits inside it — one above the credit limit is a mistake, not a mark,
    // and a line pinned to the far end would look like neither.
    final markAt = (limit != null && scale != null && scale > 0 && limit < scale)
        ? limit / scale
        : null;

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
            Text(formatMoney(card.spentMinor), style: kNum.copyWith(fontSize: 13.5)),
            if (scale != null) ...[
              const SizedBox(width: 5),
              Text('of ${formatMoneyShort(scale)}',
                  style: TextStyle(fontSize: 11.5, color: c.muted)),
              const SizedBox(width: 6),
              Text('$percent%',
                  style: kNum.copyWith(
                    fontSize: 12,
                    color: over || close ? tint : c.muted,
                  )),
            ],
          ],
        ),
        const SizedBox(height: 7),
        SizedBox(
          height: 9,
          child: LayoutBuilder(
            builder: (context, box) => Stack(
              clipBehavior: Clip.none,
              children: [
                ClipRRect(
                  borderRadius: BorderRadius.circular(100),
                  child: LinearProgressIndicator(
                    value: used ?? 0,
                    minHeight: 9,
                    backgroundColor: c.track,
                    valueColor: AlwaysStoppedAnimation(tint),
                  ),
                ),
                if (markAt != null)
                  Positioned(
                    left: box.maxWidth * markAt - 1,
                    top: -3,
                    bottom: -3,
                    child: Container(
                      width: 2,
                      decoration: BoxDecoration(
                        color: over ? c.debit : c.ink,
                        borderRadius: BorderRadius.circular(2),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 6),
        Text(
          _note(card, over: over, close: close),
          style: TextStyle(
            fontSize: 11.5,
            color: over ? c.debit : c.muted,
            fontWeight: over ? FontWeight.w700 : FontWeight.w400,
          ),
        ),
      ],
    );
  }

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
