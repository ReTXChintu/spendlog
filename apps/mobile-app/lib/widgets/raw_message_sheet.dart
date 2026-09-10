import 'package:flutter/material.dart';
import '../models/models.dart';
import '../theme.dart';
import '../utils/format.dart';

String _labelFor(String source) {
  if (source == 'MANUAL') return 'Added by hand';
  return source == 'EMAIL' ? 'Email' : 'SMS';
}

IconData _iconFor(String source) {
  if (source == 'MANUAL') return Icons.edit_outlined;
  return source == 'EMAIL' ? Icons.mail_outline : Icons.sms_outlined;
}

/// Shows the messages a transaction was parsed from. Rows appear without the
/// user entering them, so being able to check where a figure came from is
/// what makes an automatic ledger trustworthy.
///
/// Usually there is more than one: the same payment arrives as an SMS and
/// then as a bank email, and both are kept.
Future<void> showRawMessageSheet(BuildContext context, Transaction transaction) {
  // Older rows predate the per-message list and carry a single message at
  // the top level.
  final sources = transaction.sources.isNotEmpty
      ? transaction.sources
      : [
          TransactionSourceEntry(
            source: transaction.source,
            rawText: transaction.rawText,
            receivedAt: transaction.occurredAt,
          ),
        ];

  return showModalBottomSheet<void>(
    context: context,
    backgroundColor: context.c.surface,
    isScrollControlled: true,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(T.rLg)),
    ),
    builder: (context) => SafeArea(
      child: SingleChildScrollView(
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
              sources.length > 1 ? 'Original messages' : 'Original message',
              style: TextStyle(fontWeight: FontWeight.w800, fontSize: 15, color: context.c.ink),
            ),
            if (sources.length > 1) ...[
              const SizedBox(height: 4),
              Text(
                'This transaction was reported ${sources.length} times.',
                style: TextStyle(fontSize: 12, color: context.c.muted),
              ),
            ],
            const SizedBox(height: 14),
            for (final entry in sources) ...[
              Row(
                children: [
                  Icon(_iconFor(entry.source), size: 13, color: context.c.muted),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      '${_labelFor(entry.source)} · ${formatDateTime(entry.receivedAt)}',
                      style: TextStyle(fontSize: 12, color: context.c.muted),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Container(
                width: double.infinity,
                constraints: const BoxConstraints(maxHeight: 240),
                padding: const EdgeInsets.all(13),
                decoration: BoxDecoration(
                  color: context.c.darkPanel,
                  border: Border.all(color: context.c.darkPanel),
                  borderRadius: BorderRadius.circular(T.rSm),
                ),
                child: SingleChildScrollView(
                  child: Text(
                    entry.rawText ?? 'No original message stored for this transaction.',
                    style: kNum.copyWith(fontSize: 12, height: 1.5, color: context.c.darkPanelText),
                  ),
                ),
              ),
              const SizedBox(height: 14),
            ],
          ],
        ),
      ),
    ),
  );
}
