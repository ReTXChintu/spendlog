import 'package:flutter/material.dart';
import '../models/models.dart';
import '../theme.dart';
import '../utils/format.dart';

/// Shows the SMS or email a transaction was parsed from. Rows appear without
/// the user entering them, so being able to check where a figure came from is
/// what makes an automatic ledger trustworthy.
Future<void> showRawMessageSheet(BuildContext context, Transaction transaction) {
  final isEmail = transaction.source == 'EMAIL';
  final sourceLabel = transaction.source == 'MANUAL'
      ? 'Added by hand'
      : isEmail
          ? 'Email'
          : 'SMS';

  return showModalBottomSheet<void>(
    context: context,
    backgroundColor: context.c.surface,
    isScrollControlled: true,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(T.rLg)),
    ),
    builder: (context) => SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Center(
              child: Container(
                width: 38,
                height: 4,
                decoration: BoxDecoration(
                  color: context.c.lineStrong,
                  borderRadius: BorderRadius.circular(100),
                ),
              ),
            ),
            const SizedBox(height: 14),
            Text(
              'Original message',
              style: TextStyle(fontWeight: FontWeight.w800, fontSize: 15, color: context.c.ink),
            ),
            const SizedBox(height: 6),
            Row(
              children: [
                Icon(isEmail ? Icons.mail_outline : Icons.sms_outlined, size: 13, color: context.c.muted),
                const SizedBox(width: 6),
                Text(
                  '$sourceLabel · ${formatDateTime(transaction.occurredAt)}',
                  style: TextStyle(fontSize: 12, color: context.c.muted),
                ),
              ],
            ),
            const SizedBox(height: 14),
            Container(
              width: double.infinity,
              constraints: const BoxConstraints(maxHeight: 260),
              padding: const EdgeInsets.all(13),
              decoration: BoxDecoration(
                color: context.c.darkPanel,
                border: Border.all(color: context.c.darkPanel),
                borderRadius: BorderRadius.circular(T.rSm),
              ),
              child: SingleChildScrollView(
                child: Text(
                  transaction.rawText ?? 'No original message stored for this transaction.',
                  style: kNum.copyWith(fontSize: 12, height: 1.5, color: context.c.darkPanelText),
                ),
              ),
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Icon(Icons.edit_outlined, size: 13, color: context.c.mutedLight),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    'Editing the merchant name from here is coming soon.',
                    style: TextStyle(fontSize: 11.5, color: context.c.mutedLight),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    ),
  );
}
