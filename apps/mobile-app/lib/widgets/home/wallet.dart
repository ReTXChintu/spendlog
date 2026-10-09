import 'package:flutter/material.dart';
import '../../models/models.dart';
import '../../theme.dart';
import '../../utils/format.dart';
import '../pocket_money.dart';
import 'card_face.dart';
import 'home_grid.dart';

/// Every card and account on Home, so finding where one stands no longer
/// means going in, and in again.
///
/// Money on hand first, then the credit cards as cards - swiped sideways,
/// the next one peeking in from the edge - and the bank accounts as tiles
/// under them. The savings account is the emergency pot: it sits last, its
/// balance hidden until tapped, and it is never part of the total - seeing
/// it next to the spending money is what makes it look spendable.
class WalletSection extends StatelessWidget {
  const WalletSection({
    super.key,
    required this.money,
    required this.wallet,
    required this.onOpenCard,
    required this.onOpenAccount,
    this.onEditAccount,
    required this.onManage,
  });

  final MoneyOnHand money;
  final Wallet wallet;

  /// A card's transactions, this statement cycle.
  final void Function(CardFace card) onOpenCard;

  /// An account's own page - its balance, its stored details.
  final void Function(String accountId) onOpenAccount;

  /// An account's editor - for a card with no limit of either kind, to
  /// set one. Its page instead when not given.
  final void Function(String accountId)? onEditAccount;

  /// Every account, for adding one.
  final VoidCallback onManage;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final hasSavings = wallet.banks.any((bank) => bank.isSavings);
    final parts = <String>[
      'In bank ${formatMoneyShort(money.inBankMinor)}',
      if (money.cashMinor != null) 'Cash ${formatMoneyShort(money.cashMinor!)}',
      if (hasSavings) 'savings not counted',
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'MONEY ON HAND',
                    style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w800, letterSpacing: 0.6, color: c.muted),
                  ),
                  const SizedBox(height: 4),
                  FittedBox(
                    fit: BoxFit.scaleDown,
                    alignment: Alignment.centerLeft,
                    child: Text(
                      formatMoney(money.onHandMinor),
                      style: kNum.copyWith(fontSize: 28, fontWeight: FontWeight.w800, color: c.ink),
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(parts.join(' · '), style: TextStyle(fontSize: 12, color: c.muted)),
                ],
              ),
            ),
            TextButton(onPressed: onManage, child: const Text('Manage')),
          ],
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
        if (wallet.isEmpty) ...[
          const SizedBox(height: 12),
          HomeTile(
            label: 'Cards and accounts',
            icon: Icons.account_balance_wallet_outlined,
            onTap: onManage,
            child: Text(
              'They appear here on their own the first time a bank texts you. Add one by hand for '
              'anything that never sends alerts.',
              style: TextStyle(fontSize: 12, height: 1.45, color: c.muted),
            ),
          ),
        ],
        if (wallet.cards.isNotEmpty) ...[
          const SizedBox(height: 14),
          CardPager(
            cards: wallet.cards,
            onOpenCard: onOpenCard,
            onAddDetails: onOpenAccount,
            onSetLimit: onEditAccount ?? onOpenAccount,
          ),
        ],
        if (wallet.banks.isNotEmpty) ...[
          const SizedBox(height: 14),
          HomeGrid(
            squareness: 0,
            items: [
              for (final bank in wallet.banks)
                GridItem(
                  BankTile(bank: bank, onOpen: () => onOpenAccount(bank.accountId)),
                  span: bank.pocket != null ? 2 : 1,
                ),
            ],
          ),
        ],
      ],
    );
  }
}

/// The credit cards, one face at a time, swiped sideways.
class CardPager extends StatefulWidget {
  const CardPager({
    super.key,
    required this.cards,
    required this.onOpenCard,
    required this.onAddDetails,
    this.onSetLimit,
  });

  final List<CardFace> cards;
  final void Function(CardFace card) onOpenCard;
  final void Function(String accountId) onAddDetails;

  /// Where a card with no limit of either kind gets one. The account's
  /// page, like [onAddDetails], when not given.
  final void Function(String accountId)? onSetLimit;

  @override
  State<CardPager> createState() => _CardPagerState();
}

class _CardPagerState extends State<CardPager> {
  /// Wide enough to read as a card in the hand, never so wide on a tablet
  /// that one card fills the screen; the rest of the width shows the next.
  static const _maxCardWidth = 380.0;
  static const _gap = 12.0;

  PageController? _controller;
  double _fraction = 0;
  int _page = 0;

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  PageController _controllerFor(double fraction) {
    if (_controller == null || (fraction - _fraction).abs() > 0.001) {
      final old = _controller;
      _controller = PageController(viewportFraction: fraction, initialPage: _page);
      _fraction = fraction;
      if (old != null) WidgetsBinding.instance.addPostFrameCallback((_) => old.dispose());
    }
    return _controller!;
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final cards = widget.cards;
    final captionLine = MediaQuery.textScalerOf(context).scale(17);

    return LayoutBuilder(builder: (context, constraints) {
      final width = constraints.maxWidth;
      // One card takes the width; with more, each leaves room for the next
      // to peek in, which is what says "swipe".
      final cardWidth = cards.length == 1
          ? width.clamp(0.0, _maxCardWidth)
          : (width * 0.86).clamp(0.0, _maxCardWidth);
      final fraction = ((cardWidth + _gap) / width).clamp(0.1, 1.0);
      final height = (cardWidth / kCardAspect) + 10 + captionLine * 2 + 6;
      final controller = _controllerFor(fraction);

      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            height: height,
            child: PageView.builder(
              controller: controller,
              padEnds: false,
              itemCount: cards.length,
              onPageChanged: (page) => setState(() => _page = page),
              itemBuilder: (context, i) {
                final card = cards[i];
                return Padding(
                  padding: const EdgeInsets.only(right: _gap),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      CardFaceView(
                        key: ValueKey(card.accountId),
                        card: card,
                        onOpen: () => widget.onOpenCard(card),
                        onAddDetails: () => widget.onAddDetails(card.accountId),
                      ),
                      const SizedBox(height: 10),
                      _CardCaption(
                        card: card,
                        onSetLimit: () => (widget.onSetLimit ?? widget.onAddDetails)(card.accountId),
                      ),
                    ],
                  ),
                );
              },
            ),
          ),
          if (cards.length > 1) ...[
            const SizedBox(height: 4),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                for (var i = 0; i < cards.length; i++)
                  AnimatedContainer(
                    duration: const Duration(milliseconds: 200),
                    margin: const EdgeInsets.symmetric(horizontal: 3),
                    width: i == _page ? 18 : 6,
                    height: 6,
                    decoration: BoxDecoration(
                      color: i == _page ? c.brand : c.lineStrong,
                      borderRadius: BorderRadius.circular(100),
                    ),
                  ),
              ],
            ),
          ],
        ],
      );
    });
  }
}

/// The bank's limit in words, under the face. With no limit of either kind
/// it is only the cycle's spend: the caption offers to set one after it.
String cardLimitLine(CardFace card) {
  final limit = card.creditLimitMinor;
  if (limit == null || limit <= 0) {
    final spent = '${formatMoneyShort(card.cycleSpentMinor)} spent this cycle';
    return cardBar(card).basis == CardBarBasis.none ? spent : '$spent · no credit limit set';
  }
  final used = creditUsedMinor(card);
  final available = card.availableMinor ?? limit - used;
  return '${formatMoneyShort(used)} of ${formatMoneyShort(limit)} credit used · '
      '${formatMoneyShort(available)} free';
}

/// The limit you set yourself, which is the one that should change what
/// you do at the till; else the last bill when it is still unpaid.
String? cardSecondLine(CardFace card) {
  final own = card.spendLimitMinor;
  if (own != null && own > 0) {
    final left = own - card.cycleSpentMinor;
    return left < 0
        ? '${formatMoneyShort(-left)} past your ${formatMoneyShort(own)} limit this cycle'
        : '${formatMoneyShort(left)} left of your ${formatMoneyShort(own)} limit this cycle';
  }
  final bill = card.lastStatement;
  if (bill != null && bill.isPaid == false && (bill.owedMinor ?? bill.amountMinor) > 0) {
    final minimum = bill.minimumDueMinor;
    return 'Bill ${formatMoneyShort(bill.owedMinor ?? bill.amountMinor)} unpaid'
        '${minimum != null && minimum > 0 ? ' · minimum ${formatMoneyShort(minimum)}' : ''}';
  }
  if (card.sharesLimitWith.isNotEmpty) return 'Limit shared with ${card.sharesLimitWith.join(', ')}';
  return null;
}

/// Two lines under a face. The line that matches the bar is the one
/// coloured with it: your own limit's line when the bar measures that, the
/// credit line's when it measures the bank's limit.
class _CardCaption extends StatelessWidget {
  const _CardCaption({required this.card, required this.onSetLimit});

  final CardFace card;

  /// The card's account, to put a limit on it.
  final VoidCallback onSetLimit;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final second = cardSecondLine(card);
    final bar = cardBar(card);
    final warning = bar.state == 'over' || bar.state == 'close';
    final tint = switch (bar.state) {
      'over' => c.debit,
      'close' => c.warn,
      _ => null,
    };
    final onCredit = bar.basis == CardBarBasis.creditLimit;
    final onOwn = bar.basis == CardBarBasis.ownLimit;

    final first = Text(
      cardLimitLine(card),
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: kNum.copyWith(
        fontSize: 12,
        fontWeight: onCredit && warning ? FontWeight.w700 : FontWeight.w600,
        color: (onCredit ? tint : null) ?? c.ink70,
      ),
    );

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (bar.basis == CardBarBasis.none)
            Row(
              children: [
                Flexible(child: first),
                Text(' · ', style: TextStyle(fontSize: 12, color: c.muted)),
                Semantics(
                  button: true,
                  child: InkWell(
                    onTap: onSetLimit,
                    borderRadius: BorderRadius.circular(4),
                    child: Text(
                      'Set a credit limit',
                      maxLines: 1,
                      style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: c.brandDark),
                    ),
                  ),
                ),
              ],
            )
          else
            first,
          if (second != null)
            Text(
              second,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 11.5,
                fontWeight: onOwn && warning ? FontWeight.w700 : FontWeight.w500,
                color: (onOwn ? tint : null) ?? c.muted,
              ),
            ),
        ],
      ),
    );
  }
}

/// A bank account, or cash, as a tile: what it holds, its debit cards,
/// and its pocket money when it is that.
class BankTile extends StatefulWidget {
  const BankTile({super.key, required this.bank, required this.onOpen});

  final BankFace bank;
  final VoidCallback onOpen;

  @override
  State<BankTile> createState() => _BankTileState();
}

class _BankTileState extends State<BankTile> {
  /// Savings only: hidden until asked for, an emergency fund glanced at
  /// every day starts to feel like spending money.
  bool _shown = false;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final bank = widget.bank;
    final savings = bank.isSavings;
    final gradient = cardGradient(color: bank.color, bankName: bank.bankName);
    final balance = bank.balanceMinor;

    return Material(
      color: Colors.transparent,
      child: InkWell(
        // Savings toggles in place; anything else opens its page.
        onTap: savings ? () => setState(() => _shown = !_shown) : widget.onOpen,
        borderRadius: BorderRadius.circular(T.rMd),
        child: Ink(
          padding: const EdgeInsets.fromLTRB(13, 12, 13, 13),
          decoration: BoxDecoration(
            color: savings ? c.paper : c.surface,
            border: Border.all(color: savings ? c.lineStrong : c.line),
            borderRadius: BorderRadius.circular(T.rMd),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                children: [
                  Container(
                    width: 26,
                    height: 26,
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(7),
                      gradient: savings ? null : LinearGradient(colors: gradient),
                      color: savings ? c.chipNeutral : null,
                    ),
                    child: Icon(
                      savings
                          ? Icons.lock_outline
                          : (bank.isCash ? Icons.payments_outlined : Icons.account_balance_outlined),
                      size: 15,
                      color: savings ? c.muted : Colors.white,
                    ),
                  ),
                  const SizedBox(width: 9),
                  Expanded(
                    child: Text(
                      bank.isCash ? 'Cash' : bank.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 12.8, fontWeight: FontWeight.w700, color: savings ? c.muted : c.ink70),
                    ),
                  ),
                  if (bank.last4 != null)
                    Text('••${bank.last4}', style: kNum.copyWith(fontSize: 11.5, color: c.mutedLight)),
                ],
              ),
              const SizedBox(height: 12),
              if (savings) ...[
                Text(
                  _shown ? (balance == null ? 'No balance set' : formatMoney(balance)) : '₹ • • • •',
                  style: kNum.copyWith(fontSize: 18, fontWeight: FontWeight.w800, color: c.muted),
                ),
                const SizedBox(height: 2),
                Text(
                  _shown ? 'Savings · not counted · tap to hide' : 'Savings · tap to show',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 11, color: c.mutedLight),
                ),
              ] else if (balance == null) ...[
                Text('No starting balance', style: TextStyle(fontSize: 11.5, color: c.muted)),
                const SizedBox(height: 2),
                Text('Set balance', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w800, color: c.brandDark)),
              ] else ...[
                FittedBox(
                  fit: BoxFit.scaleDown,
                  alignment: Alignment.centerLeft,
                  child: Text(
                    formatMoney(balance),
                    style: kNum.copyWith(fontSize: 19, fontWeight: FontWeight.w800, color: balance < 0 ? c.debit : c.ink),
                  ),
                ),
                const SizedBox(height: 2),
                Text(bank.isCash ? 'in hand' : 'balance', style: TextStyle(fontSize: 11.5, color: c.muted)),
              ],
              if (bank.debitCards.isNotEmpty) ...[
                const SizedBox(height: 10),
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: [for (final card in bank.debitCards) _DebitChip(card: card)],
                ),
              ],
              if (bank.pocket != null) ...[
                const SizedBox(height: 12),
                _PocketStrip(pocket: bank.pocket!),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// A debit card on the account: a sliver of card, its network and last four.
class _DebitChip extends StatelessWidget {
  const _DebitChip({required this.card});

  final DebitCardFace card;

  @override
  Widget build(BuildContext context) {
    final gradient = cardGradient(network: card.network);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(5),
        gradient: LinearGradient(colors: gradient),
      ),
      // Shrinks rather than overflows in a half-width tile.
      child: FittedBox(
        fit: BoxFit.scaleDown,
        alignment: Alignment.centerLeft,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (card.network != null) ...[
              NetworkMark(network: card.network, color: Colors.white, scale: 0.5),
              const SizedBox(width: 5),
            ] else
              const Padding(
                padding: EdgeInsets.only(right: 4),
                child: Icon(Icons.credit_card, size: 12, color: Colors.white),
              ),
            Text(
              card.last4 == null ? 'Debit' : '••${card.last4}',
              style: kNum.copyWith(fontSize: 10.5, fontWeight: FontWeight.w700, color: Colors.white),
            ),
          ],
        ),
      ),
    );
  }
}

/// Pocket money on the account: whose, how much of the month's limit is
/// gone, and when it renews.
class _PocketStrip extends StatelessWidget {
  const _PocketStrip({required this.pocket});

  final PocketStatus pocket;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final due = pocket.topUpDue;

    return Container(
      padding: const EdgeInsets.fromLTRB(10, 9, 10, 10),
      decoration: BoxDecoration(
        color: due ? c.warnBg : c.brand50,
        borderRadius: BorderRadius.circular(T.rSm),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.savings_outlined, size: 14, color: due ? c.warn : c.brandDark),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  pocketTitle(pocket.holder),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w800, color: due ? c.warn : c.brandDark),
                ),
              ),
              Text(
                due ? 'Top up ${formatMoneyShort(pocket.lastMonthSpentMinor)} today' : pocketRenews(pocket),
                style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: due ? c.warn : c.muted),
              ),
            ],
          ),
          const SizedBox(height: 8),
          PocketMeter(status: pocket, compact: true),
        ],
      ),
    );
  }
}
