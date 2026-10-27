import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../utils/format.dart';
import '../widgets/ds/ds.dart';
import '../widgets/edit_transaction_sheet.dart';
import '../widgets/state_block.dart';

/// One entry the AI check doubts: the row as recorded, and why.
class FlaggedEntry {
  final Transaction transaction;
  final String kind;
  final String reason;

  const FlaggedEntry({required this.transaction, required this.kind, required this.reason});

  factory FlaggedEntry.fromJson(Map<String, dynamic> json) {
    final flag = json['aiFlag'] is Map<String, dynamic> ? json['aiFlag'] as Map<String, dynamic> : const {};
    return FlaggedEntry(
      transaction: Transaction.fromJson(json),
      kind: flag['kind'] as String? ?? '',
      reason: flag['reason'] as String? ?? '',
    );
  }

  /// The kind as the user would say it.
  String get kindLabel => switch (kind) {
        'NOT_A_TRANSACTION' => 'Not a payment',
        'WRONG_AMOUNT' => 'Amount looks wrong',
        'WRONG_DIRECTION' => 'In and out swapped',
        'DUPLICATE' => 'Recorded twice',
        _ => 'Looks wrong',
      };

  /// What to do about it, first: an advert or a repeat goes, a misread
  /// amount or direction is fixed.
  bool get deleteFirst => kind == 'NOT_A_TRANSACTION' || kind == 'DUPLICATE';
}

/// The entries the AI check thinks were read wrong - an advert recorded as
/// a payment, an amount or a direction misread, a payment recorded twice -
/// each to delete, fix, or say is right. Nothing is changed until the user
/// says so.
class FlaggedEntriesScreen extends StatefulWidget {
  const FlaggedEntriesScreen({super.key});

  @override
  State<FlaggedEntriesScreen> createState() => _FlaggedEntriesScreenState();
}

class _FlaggedEntriesScreenState extends State<FlaggedEntriesScreen> {
  List<FlaggedEntry>? _entries;
  bool _error = false;
  bool _checking = false;
  final Set<String> _busy = {};

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final result = await ApiClient.instance.get('/transactions/flagged') as List<dynamic>;
      if (!mounted) return;
      setState(() {
        _entries = result.map((row) => FlaggedEntry.fromJson(row as Map<String, dynamic>)).toList();
        _error = false;
      });
    } catch (_) {
      if (mounted) setState(() => _error = true);
    }
  }

  /// Read anything new now, rather than waiting for the morning's check.
  Future<void> _checkNow() async {
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _checking = true);
    try {
      final result = await ApiClient.instance.post('/transactions/check') as Map<String, dynamic>;
      final checked = result['checked'] as int? ?? 0;
      final flagged = result['flagged'] as int? ?? 0;
      messenger.showSnackBar(SnackBar(
        content: Text(checked == 0
            ? 'Nothing new to check'
            : 'Checked $checked ${checked == 1 ? 'entry' : 'entries'} · '
                '${flagged == 0 ? 'all look right' : '$flagged ${flagged == 1 ? 'looks' : 'look'} wrong'}'),
      ));
      await _load();
    } on ApiException catch (error) {
      messenger.showSnackBar(SnackBar(content: Text(error.message)));
    } catch (_) {
      messenger.showSnackBar(const SnackBar(content: Text("Couldn't run the check. Try again.")));
    } finally {
      if (mounted) setState(() => _checking = false);
    }
  }

  Future<void> _act(FlaggedEntry entry, Future<void> Function() action, String done) async {
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _busy.add(entry.transaction.id));
    try {
      await action();
      messenger.showSnackBar(SnackBar(content: Text(done)));
      await _load();
    } catch (_) {
      messenger.showSnackBar(const SnackBar(content: Text("Couldn't save that. Try again.")));
    } finally {
      if (mounted) setState(() => _busy.remove(entry.transaction.id));
    }
  }

  Future<void> _delete(FlaggedEntry entry) async {
    final t = entry.transaction;
    final sure = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete this entry?'),
        content: Text('${t.merchant ?? 'Payment'} · ${formatMoney(t.amountMinor)} comes out of your totals and balances.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Keep')),
          FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Delete')),
        ],
      ),
    );
    if (sure != true) return;
    await _act(entry, () => ApiClient.instance.delete('/transactions/${t.id}'), 'Deleted');
  }

  Future<void> _dismiss(FlaggedEntry entry) =>
      _act(entry, () => ApiClient.instance.post('/transactions/${entry.transaction.id}/flag/dismiss'), 'Kept as it is');

  Future<void> _edit(FlaggedEntry entry) async {
    final saved = await showEditTransactionById(context, entry.transaction.id);
    if (saved == true) await _load();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final entries = _entries;

    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: const Text('Entries to check'),
        actions: [
          TextButton.icon(
            onPressed: _checking ? null : _checkNow,
            icon: _checking
                ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                : const DsIcon(DsIcons.sparkles, size: 18),
            label: const Text('Check now'),
          ),
          const SizedBox(width: 4),
        ],
      ),
      body: _error
          ? StateBlock(
              icon: Icons.wifi_off,
              warn: true,
              title: "Couldn't load the entries to check",
              body: 'The connection failed. Check your internet and try again.',
              actionLabel: 'Retry',
              onAction: _load,
            )
          : entries == null
              ? const Padding(padding: EdgeInsets.fromLTRB(16, 16, 16, 0), child: DsSkeletonRows(count: 3))
              : entries.isEmpty
                  ? StateBlock(
                      icon: DsIcons.check,
                      title: 'Nothing looks wrong',
                      body: 'Every morning SpendLog\'s AI reads the new entries against the messages they came '
                          'from, and lists here anything that looks misread.',
                      actionLabel: 'Check now',
                      onAction: _checking ? null : _checkNow,
                    )
                  : RefreshIndicator(
                      onRefresh: _load,
                      child: ListView(
                        padding: kPagePad,
                        children: [
                          Text(
                            'The AI check thinks these were read wrong. Nothing changes until you choose.',
                            style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2),
                          ),
                          const SizedBox(height: 12),
                          for (final entry in entries) ...[
                            FlaggedEntryCard(
                              entry: entry,
                              busy: _busy.contains(entry.transaction.id),
                              onDelete: () => _delete(entry),
                              onEdit: () => _edit(entry),
                              onDismiss: () => _dismiss(entry),
                            ),
                            const SizedBox(height: kCardGap),
                          ],
                        ],
                      ),
                    ),
    );
  }
}

/// One doubted entry: what was recorded, why it looks wrong, the message it
/// came from, and the three answers.
class FlaggedEntryCard extends StatelessWidget {
  const FlaggedEntryCard({
    super.key,
    required this.entry,
    required this.onDelete,
    required this.onEdit,
    required this.onDismiss,
    this.busy = false,
  });

  final FlaggedEntry entry;
  final VoidCallback onDelete;
  final VoidCallback onEdit;
  final VoidCallback onDismiss;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final t = entry.transaction;
    final isOut = t.type == 'DEBIT';
    final meta = [
      formatDateTime(t.occurredAt),
      if (t.account != null) t.account!.label,
    ].join(' · ');
    final message = t.rawText?.trim();

    final delete = entry.deleteFirst
        ? FilledButton.icon(
            onPressed: busy ? null : onDelete,
            icon: const DsIcon(DsIcons.trash, size: 16),
            label: const Text('Delete'),
          )
        : OutlinedButton.icon(
            onPressed: busy ? null : onDelete,
            icon: const DsIcon(DsIcons.trash, size: 16),
            label: const Text('Delete'),
          );
    final edit = entry.deleteFirst
        ? OutlinedButton.icon(
            onPressed: busy ? null : onEdit,
            icon: const DsIcon(DsIcons.pencil, size: 16),
            label: const Text('Fix'),
          )
        : FilledButton.icon(
            onPressed: busy ? null : onEdit,
            icon: const DsIcon(DsIcons.pencil, size: 16),
            label: const Text('Fix'),
          );

    return DsCard(
      key: ValueKey('flagged-${t.id}'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      t.merchant ?? 'Payment',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
                    ),
                    const SizedBox(height: 2),
                    Text(meta, style: kNum.copyWith(fontSize: 12, height: 16 / 12, color: c.tx3)),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              Text(
                '${isOut ? '' : '+'}${formatMoney(t.amountMinor)}',
                style: kNum.copyWith(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: isOut ? c.tx : c.good),
              ),
            ],
          ),
          const SizedBox(height: 10),
          DsCallout(title: entry.kindLabel, detail: entry.reason, tone: DsTone.warn),
          if (message != null && message.isNotEmpty) ...[
            const SizedBox(height: 10),
            const DsLabel('From the message'),
            const SizedBox(height: 4),
            Text(
              message,
              maxLines: 5,
              overflow: TextOverflow.ellipsis,
              style: kNum.copyWith(fontSize: 12, height: 17 / 12, color: c.tx2),
            ),
          ],
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              delete,
              edit,
              TextButton(onPressed: busy ? null : onDismiss, child: const Text("It's right")),
            ],
          ),
        ],
      ),
    );
  }
}
