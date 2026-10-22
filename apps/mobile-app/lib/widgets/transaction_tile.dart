import 'package:flutter/material.dart';
import '../models/models.dart';
import '../utils/format.dart';
import 'category_sheet.dart';
import 'ds/ds.dart';
import 'raw_message_sheet.dart';

/// One transaction: the phone ledger row (§7.6). The category is set from
/// the tile on the left, matching the web app — a list of these reads as a
/// ledger rather than a column of form controls.
class TransactionTile extends StatelessWidget {
  final Transaction transaction;
  final List<Category> categories;
  final ValueChanged<Transaction> onUpdated;
  /// Opens the full edit form. Parsing gets most things right but not all,
  /// so every row has to be correctable by hand.
  final VoidCallback? onEdit;
  /// While picking rows to merge, the whole tile becomes the checkbox.
  final bool selectable;
  final bool selected;
  final VoidCallback? onToggleSelected;
  final VoidCallback? onLongPress;

  const TransactionTile({
    super.key,
    required this.transaction,
    required this.categories,
    required this.onUpdated,
    this.onEdit,
    this.selectable = false,
    this.selected = false,
    this.onToggleSelected,
    this.onLongPress,
  });

  /// "Category · Account · 8:52 pm".
  String get _meta {
    final account = transaction.account;
    final category = transaction.isTransfer ? null : transaction.category?.name;
    final parts = <String>[
      if (category != null && category.isNotEmpty) category,
      if (account != null) account.label else transaction.source,
      _time(transaction.occurredAt),
    ];
    return parts.join(' · ');
  }

  /// Times in lower case, as the design writes them ("8:52 pm").
  static String _time(DateTime at) => formatTime(at).replaceAll('AM', 'am').replaceAll('PM', 'pm');

  /// A row that is waiting on the user: no category yet, or written in to
  /// match the bank and still unexplained.
  bool get _needsAttention =>
      !transaction.isTransfer && (transaction.category == null || transaction.needsExplanation);

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final isDebit = transaction.type == 'DEBIT';
    final isTransfer = transaction.isTransfer;
    final pocket = transaction.account?.pocketMoney;
    final attention = _needsAttention && !selected;

    // Spending is ink, money in is green, and a transfer between your own
    // accounts is not counted, so it is grey and carries no sign.
    final Color amountColor;
    final String amountText;
    final money = formatMoney(transaction.amountMinor, transaction.currency);
    if (isTransfer) {
      amountColor = c.moneyNeutral;
      amountText = money;
    } else if (isDebit) {
      amountColor = c.moneyOut;
      amountText = '$kMinus$money';
    } else {
      amountColor = c.moneyIn;
      amountText = '+$money';
    }

    final background = selected ? c.acSoft : (attention ? c.warnSoft : c.sf);

    return GestureDetector(
      onTap: selectable ? onToggleSelected : null,
      onLongPress: onLongPress,
      child: Container(
        constraints: const BoxConstraints(minHeight: 64),
        foregroundDecoration: selected
            ? BoxDecoration(border: Border.all(color: c.ac, width: 2))
            : null,
        decoration: BoxDecoration(
          color: background,
          border: Border(bottom: BorderSide(color: c.ln)),
        ),
        padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 16),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            if (selectable) ...[
              _Check(on: selected),
              const SizedBox(width: 12),
            ],
            _CategoryChip(
              transaction: transaction,
              categories: categories,
              onUpdated: onUpdated,
              onTinted: attention,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Row(
                    children: [
                      Flexible(
                        child: Text(
                          transaction.merchant ?? 'Unknown',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontWeight: FontWeight.w500, fontSize: 15, height: 20 / 15, color: c.tx),
                        ),
                      ),
                      if (onEdit != null) ...[
                        const SizedBox(width: 6),
                        GestureDetector(
                          onTap: onEdit,
                          child: DsIcon(DsIcons.pencil, size: 14, color: c.tx3),
                        ),
                      ],
                      if (transaction.rawText != null) ...[
                        const SizedBox(width: 6),
                        GestureDetector(
                          onTap: () => showRawMessageSheet(context, transaction),
                          child: DsIcon(DsIcons.info, size: 14, color: c.tx3),
                        ),
                      ],
                    ],
                  ),
                  const SizedBox(height: 2),
                  Row(
                    children: [
                      // One per kind, so a row seen by both SMS and email
                      // says so without being opened.
                      for (final kind in transaction.sourceKinds) ...[
                        DsIcon(
                          switch (kind) {
                            'EMAIL' => DsIcons.mail,
                            'MANUAL' => DsIcons.pencil,
                            'STATEMENT' => DsIcons.list,
                            _ => DsIcons.message,
                          },
                          size: 12,
                          color: c.tx3,
                        ),
                        const SizedBox(width: 3),
                      ],
                      const SizedBox(width: 2),
                      Flexible(
                        child: Text(
                          _meta,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: kNum.copyWith(fontSize: 13, height: 18 / 13, color: c.tx3),
                        ),
                      ),
                    ],
                  ),
                  if (isTransfer ||
                      transaction.autoLeg ||
                      pocket != null ||
                      transaction.accountUnknown ||
                      transaction.needsExplanation ||
                      transaction.isAdjustment ||
                      transaction.groupName != null ||
                      transaction.offLedger ||
                      transaction.refundOf.isNotEmpty ||
                      transaction.refundedMinor > 0 ||
                      transaction.emiRole != null ||
                      transaction.split != null ||
                      transaction.isSettlement ||
                      transaction.byKidName != null ||
                      transaction.editedAt != null) ...[
                    const SizedBox(height: 6),
                    Wrap(
                      spacing: 6,
                      runSpacing: 6,
                      children: [
                        if (isTransfer) DsBadge('Not counted', onTinted: attention),
                        // SpendLog wrote this side of a transfer in itself -
                        // or a card bill's, on the card - and no message
                        // stands behind it yet.
                        if (transaction.autoLeg)
                          AutoLegChip(forCardBill: transaction.account?.accountType == 'CARD'),
                        // The message named no account, so this is in no
                        // balance until someone says which it was on.
                        if (transaction.accountUnknown) DsBadge('No account', tone: DsTone.ac, onTinted: attention),
                        // Written in to match the bank, and still waiting
                        // to be told what it was.
                        if (transaction.needsExplanation)
                          DsBadge('Unexplained', tone: DsTone.warn, onTinted: attention)
                        else if (transaction.isAdjustment)
                          DsBadge('Written in to match the bank', onTinted: attention),
                        // Marked from the account rather than stored on the
                        // row, so every payment from it - old ones included -
                        // shows whose spending it was.
                        if (pocket != null)
                          DsBadge('Pocket money · ${pocket.holder}', tone: DsTone.warn, onTinted: attention),
                        if (transaction.groupName != null)
                          DsBadge(transaction.groupName!, tone: DsTone.ac, icon: DsIcons.users, onTinted: attention),
                        // Somebody else's money: in no balance of the
                        // user's, only their share counted.
                        if (transaction.offLedger)
                          DsBadge(
                            '${transaction.paidByName != null ? 'Paid by ${transaction.paidByName}' : 'Paid by someone else'}'
                            '${transaction.mirrorOf != null ? ' · your share' : ''}',
                            onTinted: attention,
                          ),
                        if (transaction.refundOf.isNotEmpty)
                          DsBadge('Refund · not income', tone: DsTone.good, onTinted: attention),
                        if (transaction.refundedMinor > 0)
                          DsBadge(
                            '${formatMoney(transaction.refundedMinor)} refunded · '
                            '${formatMoney(transaction.lostMinor)} lost',
                            tone: DsTone.good,
                            onTinted: attention,
                          ),
                        if (transaction.emiRole == 'PARENT')
                          DsBadge('On EMI · not counted here', tone: DsTone.ac, onTinted: attention),
                        if (transaction.emiRole == 'INSTALMENT')
                          DsBadge('EMI payment', tone: DsTone.ac, onTinted: attention),
                        if (transaction.split != null)
                          DsBadge(
                            'My share ${formatMoney(transaction.split!.myShareMinor)}'
                            '${transaction.split!.groupLabel != null ? ' · ${transaction.split!.groupLabel}' : ''}',
                            tone: DsTone.ac,
                            onTinted: attention,
                          ),
                        if (transaction.isSettlement) DsBadge('Settling up', tone: DsTone.good, onTinted: attention),
                        // A kid added or changed this from their own login,
                        // so the owner knows it wasn't the bank or themselves.
                        if (transaction.byKidName != null)
                          DsBadge('by ${transaction.byKidName}', tone: DsTone.warn, onTinted: attention),
                        // Says plainly that these figures are the user's, not
                        // the bank's, so a corrected row isn't second-guessed.
                        if (transaction.editedAt != null) const DsBadge('Edited', outline: true),
                      ],
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(width: 12),
            Text(
              amountText,
              maxLines: 1,
              softWrap: false,
              style: kNum.copyWith(fontWeight: FontWeight.w600, fontSize: 15, height: 20 / 15, color: amountColor),
            ),
          ],
        ),
      ),
    );
  }
}

/// The custom checkbox (§7.2): 22×22, radius 6, `ln2` edge; checked is an
/// `ac` fill with a white check.
class _Check extends StatelessWidget {
  final bool on;
  const _Check({required this.on});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Container(
      width: 22,
      height: 22,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: on ? c.ac : c.sf,
        borderRadius: BorderRadius.circular(6),
        border: on ? null : Border.all(color: c.ln2, width: 1.5),
      ),
      child: on ? DsIcon(DsIcons.check, size: 14, color: c.acTx) : null,
    );
  }
}

/// The leading tile: a transfer's icon, the merchant's monogram in its
/// category's tint, or — with no category yet — a dashed "add" tile. Tap it
/// to pick the category.
class _CategoryChip extends StatelessWidget {
  final Transaction transaction;
  final List<Category> categories;
  final ValueChanged<Transaction> onUpdated;
  final bool onTinted;

  const _CategoryChip({
    required this.transaction,
    required this.categories,
    required this.onUpdated,
    this.onTinted = false,
  });

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    if (transaction.isTransfer) {
      return const DsIconTile(DsIcons.transfer);
    }

    final category = transaction.category;
    final Widget tile;
    if (category == null) {
      tile = DsDashedBorder(
        radius: Ds.rMd,
        color: onTinted ? c.warn : c.ln2,
        child: Container(
          width: 40,
          height: 40,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: onTinted ? c.sf : Colors.transparent,
            borderRadius: BorderRadius.circular(Ds.rMd),
          ),
          child: DsIcon(DsIcons.plus, size: 20, color: onTinted ? c.warn : c.tx3),
        ),
      );
    } else {
      final tint = parseHexColor(category.color);
      tile = Container(
        width: 40,
        height: 40,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: onTinted ? c.sf : tint.withValues(alpha: c.isDark ? 0.22 : 0.14),
          borderRadius: BorderRadius.circular(Ds.rMd),
        ),
        child: Icon(categoryIcon(category.icon), size: 20, color: tint),
      );
    }

    return GestureDetector(
      onTap: () => showCategorySheet(
        context,
        transaction: transaction,
        categories: categories,
        onUpdated: onUpdated,
      ),
      child: tile,
    );
  }
}

/// What the chip on a written-in transfer leg says when asked.
const kAutoLegHint = "Your bank didn't text this one, so SpendLog added it to match the transfer. "
    'It turns into the real thing if the message comes in later.';

/// The same, for the payment written in on a card when its bill was paid.
const kCardBillLegHint = "Your card company didn't text this one, so SpendLog added it to match the bill "
    'you paid. It turns into the real thing if the message comes in later.';

/// On a row SpendLog wrote in for the other side of a transfer, because
/// that bank never sent a message for it - or, [forCardBill], for the
/// payment arriving on a card whose bill was paid from the bank. Tap or
/// hold for why.
class AutoLegChip extends StatelessWidget {
  final bool forCardBill;

  const AutoLegChip({super.key, this.forCardBill = false});

  @override
  Widget build(BuildContext context) {
    final hint = forCardBill ? kCardBillLegHint : kAutoLegHint;
    return Tooltip(
      message: hint,
      triggerMode: TooltipTriggerMode.tap,
      showDuration: const Duration(seconds: 5),
      child: Semantics(
        hint: hint,
        // Outline: a note about where the row came from, not a status.
        child: DsBadge(
          forCardBill ? 'Added for your bill payment' : 'Added for your transfer',
          outline: true,
          icon: DsIcons.info,
        ),
      ),
    );
  }
}
