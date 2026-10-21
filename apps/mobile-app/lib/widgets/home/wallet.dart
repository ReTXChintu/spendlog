import 'dart:math' as math;
import 'package:flutter/material.dart';
import '../../models/models.dart';
import '../ds/ds.dart';
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
    this.onOpenPassbook,
    required this.onManage,
  });

  final MoneyOnHand money;
  final Wallet wallet;

  /// A card's transactions, this statement cycle.
  final void Function(CardFace card) onOpenCard;

  /// An account's own page - its balance, its stored details.
  final void Function(String accountId) onOpenAccount;

  /// An account's passbook: its running balance beside the bank's, row by
  /// row. From the drift chip on a tile that is off, and the link on one
  /// that is not.
  final void Function(String accountId)? onOpenPassbook;

  /// An account's editor - for a card with no billing date or no credit
  /// limit, to set it. Its page instead when not given.
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
                  const DsLabel('Money on hand'),
                  const SizedBox(height: 4),
                  FittedBox(
                    fit: BoxFit.scaleDown,
                    alignment: Alignment.centerLeft,
                    child: Text(
                      formatMoney(money.onHandMinor),
                      style: kNum.copyWith(
                        fontSize: 28,
                        height: 34 / 28,
                        fontWeight: FontWeight.w600,
                        letterSpacing: 28 * -0.02,
                        color: c.tx,
                      ),
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    parts.join(' · '),
                    style: kNum.copyWith(fontSize: 13, height: 18 / 13, color: c.tx3),
                  ),
                ],
              ),
            ),
            TextButton(onPressed: onManage, child: const Text('Manage')),
          ],
        ),
        if (money.untracked > 0)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(
              money.untracked == 1
                  ? 'One account has no starting balance yet, so it is not in this.'
                  : '${money.untracked} accounts have no starting balance yet, so they are not in this.',
              style: TextStyle(fontSize: 12, height: 16 / 12, fontWeight: FontWeight.w500, color: c.warn),
            ),
          ),
        if (wallet.isEmpty) ...[
          const SizedBox(height: 12),
          HomeTile(
            label: 'Cards and accounts',
            icon: DsIcons.banknote,
            onTap: onManage,
            child: Text(
              'They appear here on their own the first time a bank texts you. Add one by hand for '
              'anything that never sends alerts.',
              style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3),
            ),
          ),
        ],
        if (wallet.cards.isNotEmpty) ...[
          const SizedBox(height: 16),
          CardPager(
            cards: wallet.cards,
            onOpenCard: onOpenCard,
            onAddDetails: onOpenAccount,
            onEdit: onEditAccount ?? onOpenAccount,
          ),
        ],
        if (wallet.banks.isNotEmpty) ...[
          const SizedBox(height: 16),
          HomeGrid(
            squareness: 0,
            items: [
              for (final bank in wallet.banks)
                GridItem(
                  BankTile(
                    bank: bank,
                    onOpen: () => onOpenAccount(bank.accountId),
                    onOpenPassbook: onOpenPassbook == null ? null : () => onOpenPassbook!(bank.accountId),
                  ),
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
    this.onEdit,
  });

  final List<CardFace> cards;
  final void Function(CardFace card) onOpenCard;
  final void Function(String accountId) onAddDetails;

  /// Where a card with no billing date or credit limit gets one. The
  /// account's page, like [onAddDetails], when not given.
  final void Function(String accountId)? onEdit;

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
    final captionLine = MediaQuery.textScalerOf(context).scale(16);

    return LayoutBuilder(builder: (context, constraints) {
      final width = constraints.maxWidth;
      // One card takes the width; with more, each is 85% of it (§6.3) and
      // leaves room for the next to peek in, which is what says "swipe".
      final cardWidth = cards.length == 1
          ? width.clamp(0.0, _maxCardWidth)
          : (width * 0.85).clamp(0.0, _maxCardWidth);
      final fraction = ((cardWidth + _gap) / width).clamp(0.1, 1.0);
      // A line for the limit, and up to two for the bill and the cycle.
      final height = (cardWidth / kCardAspect) + 10 + captionLine * 3 + 6;
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
                        onEdit: () => (widget.onEdit ?? widget.onAddDetails)(card.accountId),
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
                    duration: Ds.dur,
                    curve: Ds.ease,
                    margin: const EdgeInsets.symmetric(horizontal: 3),
                    width: i == _page ? 18 : 6,
                    height: 6,
                    decoration: BoxDecoration(
                      color: i == _page ? c.ac : c.ln2,
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

/// The first line under a face: credit used against the limit, and what is
/// left of it. With no credit limit only what is used; with no billing
/// date, nothing that depends on one - the caption offers to set whichever
/// is missing after it.
String cardLimitLine(CardFace card) {
  final limit = card.creditLimitMinor;
  if (!card.cycleKnown) {
    return limit != null && limit > 0 ? '${formatMoneyShort(limit)} credit limit' : 'Cycle unknown';
  }
  final used = creditUsedMinor(card);
  if (limit == null || limit <= 0) return '${formatMoneyShort(used)} used';
  final available = card.availableMinor ?? math.max(0, limit - used);
  return '${formatMoneyShort(used)} of ${formatMoneyShort(limit)} used · '
      '${formatMoneyShort(available)} available';
}

/// The last bill, if any of it is still to pay.
bool _billOwing(CardFace card) {
  final bill = card.lastStatement;
  return bill != null && bill.isPaid == false && (bill.owedMinor ?? bill.amountMinor) > 0;
}

/// "in 3 days", "today", "2 days late" - how soon an unpaid bill is due.
String? _dueIn(int? days) {
  if (days == null) return null;
  if (days < 0) return days == -1 ? '1 day late' : '${-days} days late';
  if (days == 0) return 'due today';
  if (days == 1) return 'tomorrow';
  return 'in $days days';
}

/// The second line: the bill and the cycle. Until the last bill is paid,
/// what is left of it and when it is due, then what has been charged since
/// it was drawn; once it is paid, only the running cycle and when it
/// closes. Nothing for a card with no cycle to speak of.
String? cardSecondLine(CardFace card) {
  if (!card.cycleKnown) return null;
  final bill = card.lastStatement;
  final unbilled = formatMoneyShort(card.unbilledMinor ?? 0);

  if (bill != null && _billOwing(card)) {
    final owed = bill.owedMinor ?? bill.amountMinor;
    final due = formatCardDate(bill.dueOn ?? card.nextDueOn);
    final when = _dueIn(card.daysToDue);
    return [
      'Bill ${bill.isEstimate ? 'about ' : ''}${formatMoneyShort(owed)}${due.isEmpty ? ' unpaid' : ' due $due'}',
      if (when != null) when,
      '$unbilled spent since statement',
    ].join(' · ');
  }

  final closes = formatCardDate(card.cycleEnd);
  final cycle = '$unbilled spent this cycle${closes.isEmpty ? '' : ' (closes $closes)'}';
  return bill != null && bill.amountMinor > 0 ? 'Bill paid · $cycle' : 'No bill due · $cycle';
}

/// Whether the unpaid bill is due within three days, or late: the second
/// line goes red.
bool cardBillUrgent(CardFace card) {
  final days = card.daysToDue;
  return card.cycleKnown && _billOwing(card) && days != null && days <= 3;
}

/// Two lines under a face. The first is coloured by the bar - how much of
/// the credit limit is gone - and the second goes red when the bill is
/// close to due or late. A card missing what its figures need - a billing
/// date, a credit limit - says so, with a way straight to its editor.
class _CardCaption extends StatelessWidget {
  const _CardCaption({required this.card, required this.onEdit});

  final CardFace card;

  /// The card's editor, to set its billing date or its credit limit.
  final VoidCallback onEdit;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final second = cardSecondLine(card);
    final bar = cardBar(card);
    // Near the credit line is a problem (crit); getting close is a heads-up.
    final tint = switch (bar.state) {
      'over' => c.crit,
      'close' => c.warn,
      _ => null,
    };
    final urgent = cardBillUrgent(card);
    final action = !card.cycleKnown
        ? 'Set billing date'
        : bar.basis == CardBarBasis.none
            ? 'Set a credit limit'
            : null;

    final first = Text(
      cardLimitLine(card),
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: kNum.copyWith(
        fontSize: 12,
        height: 16 / 12,
        fontWeight: tint != null ? FontWeight.w600 : FontWeight.w500,
        color: tint ?? c.tx2,
      ),
    );

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 2),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (action != null)
            Row(
              children: [
                Flexible(child: first),
                Text(' · ', style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3)),
                Semantics(
                  button: true,
                  child: InkWell(
                    onTap: onEdit,
                    borderRadius: BorderRadius.circular(4),
                    child: Text(
                      action,
                      maxLines: 1,
                      style: TextStyle(fontSize: 13, height: 16 / 13, fontWeight: FontWeight.w600, color: c.ac),
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
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: kNum.copyWith(
                fontSize: 12,
                height: 16 / 12,
                fontWeight: urgent ? FontWeight.w600 : FontWeight.w400,
                color: urgent ? c.crit : c.tx3,
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
  const BankTile({super.key, required this.bank, required this.onOpen, this.onOpenPassbook});

  final BankFace bank;
  final VoidCallback onOpen;

  /// The passbook, from the drift chip or the link under the balance.
  final VoidCallback? onOpenPassbook;

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
    final drift = bank.drift;
    final radius = BorderRadius.circular(Ds.rXl);
    // An account with no starting balance has no data yet: a dashed edge.
    final noData = !savings && balance == null;

    Widget tile = Material(
      color: Colors.transparent,
      child: InkWell(
        // Savings toggles in place; anything else opens its page.
        onTap: savings ? () => setState(() => _shown = !_shown) : widget.onOpen,
        borderRadius: radius,
        child: Ink(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: c.sf2,
            border: noData ? null : Border.all(color: c.ln),
            borderRadius: radius,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                children: [
                  Container(
                    width: 24,
                    height: 24,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(6),
                      gradient: savings
                          ? null
                          : LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: gradient),
                      color: savings ? c.sunk : null,
                    ),
                    child: DsIcon(
                      savings ? DsIcons.lock : (bank.isCash ? DsIcons.banknote : DsIcons.bank),
                      size: 14,
                      color: savings ? c.tx3 : Colors.white,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      bank.isCash ? 'Cash' : bank.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 13,
                        height: 18 / 13,
                        fontWeight: FontWeight.w600,
                        color: savings ? c.tx2 : c.tx,
                      ),
                    ),
                  ),
                  if (bank.last4 != null)
                    Text('••${bank.last4}', style: kNum.copyWith(fontSize: 12, height: 16 / 12, color: c.tx3)),
                ],
              ),
              const SizedBox(height: 10),
              if (savings) ...[
                Text(
                  _shown ? (balance == null ? 'No balance set' : formatMoney(balance)) : '₹ • • • •',
                  style: kNum.copyWith(fontSize: 17, height: 24 / 17, fontWeight: FontWeight.w600, color: c.tx3),
                ),
                const SizedBox(height: 2),
                Text(
                  _shown ? 'Savings · not counted · tap to hide' : 'Savings · tap to show',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
                ),
                if (_shown && drift != null) ...[
                  const SizedBox(height: 6),
                  _DriftChip(drift: drift, onTap: widget.onOpenPassbook),
                ],
              ] else if (balance == null) ...[
                Text('No starting balance', style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3)),
                const SizedBox(height: 4),
                Text(
                  'Set balance',
                  style: TextStyle(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w600, color: c.ac),
                ),
              ] else ...[
                FittedBox(
                  fit: BoxFit.scaleDown,
                  alignment: Alignment.centerLeft,
                  child: Text(
                    formatMoney(balance),
                    // Below zero on a bank account is a problem; otherwise ink.
                    style: kNum.copyWith(
                      fontSize: 17,
                      height: 24 / 17,
                      fontWeight: FontWeight.w600,
                      color: balance < 0 ? c.crit : c.tx,
                    ),
                  ),
                ),
                const SizedBox(height: 4),
                // Off from the bank: the gap, red, and the way to the
                // passbook that says where. In step: a quiet link to it.
                if (drift != null)
                  _DriftChip(drift: drift, onTap: widget.onOpenPassbook)
                // In step with the bank only because money nobody has
                // explained is counted in: say so, amber, into the passbook.
                else if (bank.provisionalMinor > 0)
                  InkWell(
                    onTap: widget.onOpenPassbook,
                    borderRadius: BorderRadius.circular(4),
                    child: Text(
                      'incl. ${formatMoneyShort(bank.provisionalMinor)} unexplained ›',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: kNum.copyWith(fontSize: 12, height: 16 / 12, fontWeight: FontWeight.w600, color: c.warn),
                    ),
                  )
                else
                  Row(
                    children: [
                      Text(
                        bank.isCash ? 'in hand' : 'balance',
                        style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
                      ),
                      if (widget.onOpenPassbook != null) ...[
                        Text(' · ', style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3)),
                        Flexible(
                          child: InkWell(
                            onTap: widget.onOpenPassbook,
                            borderRadius: BorderRadius.circular(4),
                            child: Text(
                              'Passbook ›',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(fontSize: 12, height: 16 / 12, fontWeight: FontWeight.w600, color: c.ac),
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
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
    if (noData) tile = DsDashedBorder(radius: Ds.rXl, child: tile);
    return tile;
  }
}

/// How far the tile's figure is from the bank's: "₹3,000 off", a crit
/// badge, and the way into the passbook that says where it went wrong.
class _DriftChip extends StatelessWidget {
  const _DriftChip({required this.drift, this.onTap});

  final BalanceDrift drift;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Align(
      alignment: Alignment.centerLeft,
      child: Semantics(
        button: onTap != null,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(Ds.rSm),
          child: Container(
            constraints: const BoxConstraints(minHeight: 24),
            padding: EdgeInsets.fromLTRB(8, 3, onTap != null ? 4 : 8, 3),
            decoration: BoxDecoration(color: c.critSoft, borderRadius: BorderRadius.circular(Ds.rSm)),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Flexible(
                  child: Text(
                    '${formatMoneyShort(drift.minor.abs())} off',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: kNum.copyWith(fontSize: 12, height: 16 / 12, fontWeight: FontWeight.w600, color: c.crit),
                  ),
                ),
                if (onTap != null) ...[
                  const SizedBox(width: 2),
                  DsIcon(DsIcons.chevronRight, size: 14, color: c.crit),
                ],
              ],
            ),
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
        borderRadius: BorderRadius.circular(Ds.rSm),
        gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: gradient),
      ),
      // Shrinks rather than overflows in a half-width tile.
      child: FittedBox(
        fit: BoxFit.scaleDown,
        alignment: Alignment.centerLeft,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (card.network != null) ...[
              NetworkMark(network: card.network, color: Colors.white, scale: 0.6),
              const SizedBox(width: 6),
            ] else
              const Padding(
                padding: EdgeInsets.only(right: 4),
                child: DsIcon(DsIcons.creditCard, size: 12, color: Colors.white),
              ),
            Text(
              card.last4 == null ? 'Debit' : '••${card.last4}',
              style: kNum.copyWith(fontSize: 11, fontWeight: FontWeight.w600, color: Colors.white),
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
    final strong = due ? c.warn : c.ac;

    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: due ? c.warnSoft : c.acSoft,
        borderRadius: BorderRadius.circular(Ds.rLg),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              DsIcon(DsIcons.piggyBank, size: 16, color: strong),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  pocketTitle(pocket.holder),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 13, height: 18 / 13, fontWeight: FontWeight.w600, color: strong),
                ),
              ),
              Text(
                due ? 'Top up ${formatMoneyShort(pocket.lastMonthSpentMinor)} today' : pocketRenews(pocket),
                style: kNum.copyWith(
                  fontSize: 12,
                  height: 16 / 12,
                  fontWeight: due ? FontWeight.w600 : FontWeight.w400,
                  color: due ? c.warn : c.tx3,
                ),
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
