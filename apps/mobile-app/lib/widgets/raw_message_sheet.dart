import 'package:flutter/material.dart';
import '../models/models.dart';
import '../utils/format.dart';
import 'ds/ds.dart';

String _labelFor(String source) => switch (source) {
      'MANUAL' => 'Added by hand',
      'STATEMENT' => 'Statement',
      'EMAIL' => 'Email',
      _ => 'SMS',
    };

DsGlyph _iconFor(String source) => switch (source) {
      'MANUAL' => DsIcons.pencil,
      'STATEMENT' => DsIcons.list,
      'EMAIL' => DsIcons.mail,
      _ => DsIcons.message,
    };

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
    isScrollControlled: true,
    builder: (context) {
      final c = context.c;
      return SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const DsDragHandle(),
              const SizedBox(height: 4),
              DsSheetHeader(
                title: sources.length > 1 ? 'Original messages' : 'Original message',
                subtitle: sources.length > 1 ? 'This transaction was reported ${sources.length} times.' : null,
                icon: DsIcons.message,
              ),
              const SizedBox(height: 16),
              for (final entry in sources) ...[
                Row(
                  children: [
                    DsIcon(_iconFor(entry.source), size: 16, color: c.tx3),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        '${_labelFor(entry.source)} · ${formatDateTime(entry.receivedAt)}',
                        style: kNum.copyWith(fontSize: 12, height: 16 / 12, color: c.tx3),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                Container(
                  width: double.infinity,
                  constraints: const BoxConstraints(maxHeight: 240),
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                  decoration: BoxDecoration(
                    color: c.sf2,
                    border: Border.all(color: c.ln),
                    borderRadius: BorderRadius.circular(Ds.rLg),
                  ),
                  child: SingleChildScrollView(
                    child: entry.rawText == null
                        ? Text(
                            'No original message stored for this transaction.',
                            style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3),
                          )
                        : Text(
                            entry.rawText!,
                            style: kMono.copyWith(fontSize: 13, height: 20 / 13, color: c.tx),
                          ),
                  ),
                ),
                const SizedBox(height: 16),
              ],
            ],
          ),
        ),
      );
    },
  );
}
