import 'package:flutter/material.dart';
import '../../models/models.dart';
import '../../theme.dart';
import '../../utils/format.dart';

/// Money on hand, then every account and card as a card of its own in a
/// sideways scroll.
///
/// The savings account is the emergency pot: it sits last, muted, its
/// amount hidden until tapped, and it is never part of the total - seeing
/// it next to the spending money is what makes it look spendable.
class MoneyCarousel extends StatelessWidget {
  const MoneyCarousel({
    super.key,
    required this.money,
    required this.cards,
    required this.onOpenAccounts,
  });

  final MoneyOnHand money;
  final List<CardStatus> cards;

  /// Where a starting balance is set, and where the savings switch lives.
  final VoidCallback onOpenAccounts;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final spending = money.accounts.where((a) => !a.isSavings).toList();
    final savings = money.accounts.where((a) => a.isSavings).toList();

    final tiles = <Widget>[
      for (final account in spending) _AccountCard(account: account, onOpenAccounts: onOpenAccounts),
      for (final card in cards) _CreditCard(card: card),
      for (final account in savings) _SavingsCard(account: account),
    ];

    final parts = <String>[
      'In bank ${formatMoneyShort(money.inBankMinor)}',
      if (money.cashMinor != null) 'Cash ${formatMoneyShort(money.cashMinor!)}',
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'MONEY ON HAND',
          style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w800, letterSpacing: 0.6, color: c.muted),
        ),
        const SizedBox(height: 4),
        Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Flexible(
              child: FittedBox(
                fit: BoxFit.scaleDown,
                alignment: Alignment.centerLeft,
                child: Text(
                  formatMoney(money.onHandMinor),
                  style: kNum.copyWith(fontSize: 28, fontWeight: FontWeight.w800, color: c.ink),
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 2),
        Text(
          savings.isEmpty ? parts.join(' · ') : '${parts.join(' · ')} · savings not counted',
          style: TextStyle(fontSize: 12, color: c.muted),
        ),
        if (money.untracked > 0)
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Text(
              money.untracked == 1
                  ? 'One account has no starting balance yet, so it is not in this.'
                  : '${money.untracked} accounts have no starting balance yet, so they are not in this.',
              style: TextStyle(fontSize: 11.5, color: c.warn),
            ),
          ),
        if (tiles.isNotEmpty) ...[
          const SizedBox(height: 12),
          SizedBox(
            height: 126,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              itemCount: tiles.length,
              separatorBuilder: (_, __) => const SizedBox(width: 10),
              itemBuilder: (_, i) => SizedBox(width: 168, child: tiles[i]),
            ),
          ),
        ],
      ],
    );
  }
}

/// The shared look of one card in the scroll.
class _Frame extends StatelessWidget {
  const _Frame({
    required this.icon,
    required this.title,
    required this.children,
    this.onTap,
    this.muted = false,
  });

  final IconData icon;
  final String title;
  final List<Widget> children;
  final VoidCallback? onTap;
  final bool muted;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(T.rMd),
        child: Ink(
          padding: const EdgeInsets.all(13),
          decoration: BoxDecoration(
            color: muted ? c.paper : c.surface,
            border: Border.all(color: muted ? c.lineStrong : c.line),
            borderRadius: BorderRadius.circular(T.rMd),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(icon, size: 15, color: muted ? c.mutedLight : c.brand),
                  const SizedBox(width: 7),
                  Expanded(
                    child: Text(
                      title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 12.5,
                        fontWeight: FontWeight.w700,
                        color: muted ? c.muted : c.ink70,
                      ),
                    ),
                  ),
                ],
              ),
              const Spacer(),
              ...children,
            ],
          ),
        ),
      ),
    );
  }
}

String _name(String name, String? last4) => last4 == null ? name : '$name ••$last4';

class _AccountCard extends StatelessWidget {
  const _AccountCard({required this.account, required this.onOpenAccounts});

  final MoneyAccount account;
  final VoidCallback onOpenAccounts;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final balance = account.balanceMinor;
    final isCash = account.accountType == 'CASH';

    return _Frame(
      icon: isCash ? Icons.payments_outlined : Icons.account_balance_outlined,
      title: isCash ? 'Cash' : _name(account.name, account.last4),
      onTap: onOpenAccounts,
      children: [
        if (balance == null) ...[
          Text('No starting balance', style: TextStyle(fontSize: 11.5, color: c.muted)),
          const SizedBox(height: 4),
          Text(
            'Set balance',
            style: TextStyle(fontSize: 14, fontWeight: FontWeight.w800, color: c.brandDark),
          ),
        ] else ...[
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(
              formatMoney(balance),
              style: kNum.copyWith(
                fontSize: 19,
                fontWeight: FontWeight.w800,
                color: balance < 0 ? c.debit : c.ink,
              ),
            ),
          ),
          const SizedBox(height: 2),
          Text(isCash ? 'in hand' : 'balance', style: TextStyle(fontSize: 11.5, color: c.muted)),
        ],
      ],
    );
  }
}

class _CreditCard extends StatelessWidget {
  const _CreditCard({required this.card});

  final CardStatus card;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final limit = card.creditLimitMinor;
    final available = card.availableMinor;

    // Used is whatever the limit has lost: the bill still unpaid plus this
    // cycle, or the shared group's figure when the limit is shared.
    final used = limit != null && available != null
        ? limit - available
        : (card.groupUsedMinor ?? (card.outstandingMinor ?? 0) + card.spentMinor);
    final fraction = limit != null && limit > 0 ? (used / limit).clamp(0.0, 1.0) : 0.0;
    final tint = fraction >= 0.9 ? c.debit : (fraction >= 0.7 ? c.warn : c.brand);

    return _Frame(
      icon: Icons.credit_card,
      title: _name(card.name, card.last4),
      children: [
        FittedBox(
          fit: BoxFit.scaleDown,
          alignment: Alignment.centerLeft,
          child: Text(
            formatMoney(available ?? card.spentMinor),
            style: kNum.copyWith(fontSize: 19, fontWeight: FontWeight.w800, color: c.ink),
          ),
        ),
        const SizedBox(height: 2),
        Text(
          available != null && limit != null
              ? 'available of ${formatMoneyShort(limit)}'
              : 'spent this cycle · no limit set',
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(fontSize: 11.5, color: c.muted),
        ),
        if (limit != null) ...[
          const SizedBox(height: 7),
          ClipRRect(
            borderRadius: BorderRadius.circular(100),
            child: LinearProgressIndicator(
              value: fraction,
              minHeight: 5,
              backgroundColor: c.track,
              valueColor: AlwaysStoppedAnimation(tint),
            ),
          ),
        ],
      ],
    );
  }
}

/// Hidden until asked for: an emergency fund glanced at every day starts
/// to feel like spending money.
class _SavingsCard extends StatefulWidget {
  const _SavingsCard({required this.account});

  final MoneyAccount account;

  @override
  State<_SavingsCard> createState() => _SavingsCardState();
}

class _SavingsCardState extends State<_SavingsCard> {
  bool _shown = false;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final balance = widget.account.balanceMinor;

    return _Frame(
      icon: Icons.lock_outline,
      title: _name(widget.account.name, widget.account.last4),
      muted: true,
      onTap: () => setState(() => _shown = !_shown),
      children: [
        Text(
          _shown ? (balance == null ? 'No balance set' : formatMoney(balance)) : '₹ • • • •',
          style: kNum.copyWith(fontSize: 17, fontWeight: FontWeight.w800, color: c.muted),
        ),
        const SizedBox(height: 2),
        Text(
          _shown ? 'Savings · not counted' : 'Savings · not counted · tap to see',
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(fontSize: 11, color: c.mutedLight),
        ),
      ],
    );
  }
}
