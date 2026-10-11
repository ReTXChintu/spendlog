import 'dart:async';
import 'package:flutter/material.dart';
import '../../models/fund_models.dart';
import '../../models/models.dart' show Transaction;
import '../../services/api_client.dart';
import '../../theme.dart';
import '../../utils/format.dart';
import '../../widgets/funds/fund_text.dart';
import '../../widgets/funds/fund_widgets.dart';

/// Connecting money SpendLog already saw go out to the funds it bought:
/// the debits that look like SIP instalments, the SIP commitments that
/// could be a fund's, and - from a fund's page - any recent debit.
///
/// Linking never changes the transaction itself; it still counts against
/// the monthly budget exactly as before.

/// "Fund house named", "Same amount as the SIP", ...
String linkReasonLabel(String reason) => switch (reason) {
      'sip_words' => 'Looks like a fund purchase',
      'fund_house' => 'Names the fund house',
      'amount' => 'Same amount as the SIP',
      'amount_near' => 'Close to the SIP amount',
      'day' => 'On the SIP day',
      'day_near' => 'Near the SIP day',
      _ => reason,
    };

/// Every suggestion, grouped by fund, with commitments to connect below.
/// Pops `true` when anything was linked or connected.
Future<bool> showLinkSuggestionsSheet(
  BuildContext context, {
  required LinkSuggestions links,
  required List<FundHolding> holdings,
}) async {
  final changed = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: context.c.paper,
    shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(T.rLg))),
    builder: (_) => _LinkSheet(links: links, holdings: holdings),
  );
  return changed == true;
}

class _LinkSheet extends StatefulWidget {
  const _LinkSheet({required this.links, required this.holdings});

  final LinkSuggestions links;
  final List<FundHolding> holdings;

  @override
  State<_LinkSheet> createState() => _LinkSheetState();
}

class _LinkSheetState extends State<_LinkSheet> {
  /// Done here: transaction ids linked, commitment ids connected.
  final _linked = <String>{};
  final _connected = <String, String>{};
  final _busy = <String>{};
  String? _error;

  FundHolding? _holding(String? id) {
    for (final holding in widget.holdings) {
      if (holding.id == id) return holding;
    }
    return null;
  }

  Future<void> _link(LinkSuggestion suggestion) async {
    setState(() {
      _busy.add(suggestion.transactionId);
      _error = null;
    });
    try {
      await ApiClient.instance.post(
        '/funds/holdings/${suggestion.holdingId}/link',
        {'transactionId': suggestion.transactionId},
      );
      if (mounted) setState(() => _linked.add(suggestion.transactionId));
    } catch (error) {
      if (mounted) setState(() => _error = error is ApiException ? error.message : "Couldn't link that payment.");
    } finally {
      if (mounted) setState(() => _busy.remove(suggestion.transactionId));
    }
  }

  Future<void> _connect(CommitmentSuggestion commitment, FundHolding holding) async {
    setState(() {
      _busy.add(commitment.commitmentId);
      _error = null;
    });
    try {
      await ApiClient.instance.patch('/funds/holdings/${holding.id}', {'commitmentId': commitment.commitmentId});
      if (mounted) setState(() => _connected[commitment.commitmentId] = holding.id);
    } catch (error) {
      if (mounted) setState(() => _error = error is ApiException ? error.message : "Couldn't connect that SIP.");
    } finally {
      if (mounted) setState(() => _busy.remove(commitment.commitmentId));
    }
  }

  Future<void> _connectElsewhere(CommitmentSuggestion commitment) async {
    final free = widget.holdings.where((holding) => holding.commitmentId == null).toList();
    final picked = await pickHolding(context, holdings: free, title: 'Which fund is "${commitment.name}" for?');
    if (picked != null) await _connect(commitment, picked);
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final byHolding = <String, List<LinkSuggestion>>{};
    for (final suggestion in widget.links.suggestions) {
      byHolding.putIfAbsent(suggestion.holdingId, () => []).add(suggestion);
    }
    final changed = _linked.isNotEmpty || _connected.isNotEmpty;

    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.75,
      minChildSize: 0.4,
      maxChildSize: 0.95,
      builder: (context, scroll) => Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 8, 6),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    'Link SIP payments',
                    style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: c.ink),
                  ),
                ),
                TextButton(onPressed: () => Navigator.of(context).pop(changed), child: Text(changed ? 'Done' : 'Close')),
              ],
            ),
          ),
          Expanded(
            child: ListView(
              controller: scroll,
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 28),
              children: [
                Text(
                  'Debits SpendLog already has that look like SIP instalments. Linking one counts it towards the '
                  'fund at that day\'s NAV; the transaction itself, and your budget, stay as they are.',
                  style: TextStyle(fontSize: 12.5, height: 1.45, color: c.muted),
                ),
                if (_error != null) ...[
                  const SizedBox(height: 10),
                  Text(_error!, style: TextStyle(fontSize: 12.5, color: c.debit)),
                ],
                for (final entry in byHolding.entries) ...[
                  const SizedBox(height: 18),
                  FundSectionHeader(
                    title: shortSchemeName(_holding(entry.key)?.schemeName ?? entry.value.first.schemeName),
                    count: entry.value.length,
                  ),
                  const SizedBox(height: 8),
                  for (final suggestion in entry.value) ...[
                    DebitRow(
                      merchant: suggestion.merchant,
                      occurredAt: suggestion.occurredAt,
                      amountMinor: suggestion.amountMinor,
                      detail: suggestion.reasons.map(linkReasonLabel).join(' · '),
                      done: _linked.contains(suggestion.transactionId),
                      busy: _busy.contains(suggestion.transactionId),
                      actionLabel: 'Link',
                      onAction: () => _link(suggestion),
                    ),
                    const SizedBox(height: 8),
                  ],
                ],
                if (widget.links.commitments.isNotEmpty) ...[
                  const SizedBox(height: 18),
                  const FundSectionHeader(title: 'SIP commitments to connect'),
                  const SizedBox(height: 6),
                  Text(
                    'Monthly SIPs set up under fixed costs. Connect one to its fund and every debit matched to it '
                    'counts as an instalment from now on.',
                    style: TextStyle(fontSize: 12, height: 1.45, color: c.muted),
                  ),
                  const SizedBox(height: 8),
                  for (final commitment in widget.links.commitments) ...[
                    _CommitmentRow(
                      commitment: commitment,
                      suggested: _holding(commitment.suggestedHoldingId),
                      connectedTo: _holding(_connected[commitment.commitmentId]),
                      busy: _busy.contains(commitment.commitmentId),
                      onConnect: (holding) => _connect(commitment, holding),
                      onPickOther: () => _connectElsewhere(commitment),
                    ),
                    const SizedBox(height: 8),
                  ],
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// A debit: who, when, how much, and a Link (or Unlink) button.
class DebitRow extends StatelessWidget {
  const DebitRow({
    super.key,
    required this.merchant,
    required this.occurredAt,
    required this.amountMinor,
    this.detail,
    this.done = false,
    this.busy = false,
    required this.actionLabel,
    this.onAction,
  });

  final String? merchant;
  final DateTime? occurredAt;
  final int amountMinor;
  final String? detail;
  final bool done;
  final bool busy;
  final String actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return FundCard(
      padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  merchant ?? 'Debit',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700, color: c.ink),
                ),
                Text(
                  [
                    if (occurredAt != null) formatShortDate(occurredAt!),
                    formatMoney(amountMinor),
                  ].join(' · '),
                  style: kNum.copyWith(fontSize: 12, color: c.ink70),
                ),
                if (detail != null && detail!.isNotEmpty)
                  Text(detail!, style: TextStyle(fontSize: 11.5, height: 1.35, color: c.muted)),
              ],
            ),
          ),
          const SizedBox(width: 8),
          if (done)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.check_circle, size: 16, color: c.credit),
                  const SizedBox(width: 4),
                  Text('Linked', style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: c.credit)),
                ],
              ),
            )
          else if (busy)
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: 16),
              child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)),
            )
          else
            TextButton(onPressed: onAction, child: Text(actionLabel)),
        ],
      ),
    );
  }
}

class _CommitmentRow extends StatelessWidget {
  const _CommitmentRow({
    required this.commitment,
    required this.suggested,
    required this.connectedTo,
    required this.busy,
    required this.onConnect,
    required this.onPickOther,
  });

  final CommitmentSuggestion commitment;
  final FundHolding? suggested;
  final FundHolding? connectedTo;
  final bool busy;
  final ValueChanged<FundHolding> onConnect;
  final VoidCallback onPickOther;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final day = commitment.dayOfMonth;
    return FundCard(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(commitment.name, style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700, color: c.ink)),
          Text(
            [
              formatMoneyShort(commitment.amountMinor) + (day == null ? '' : ' on ${ordinalDay(day)}'),
              '${commitment.matchedDebits} ${commitment.matchedDebits == 1 ? 'debit' : 'debits'} matched',
              if (!commitment.isActive) 'paused',
            ].join(' · '),
            style: TextStyle(fontSize: 12, color: c.ink70),
          ),
          const SizedBox(height: 8),
          if (connectedTo != null)
            Row(
              children: [
                Icon(Icons.check_circle, size: 16, color: c.credit),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    'Connected to ${shortSchemeName(connectedTo!.schemeName)}',
                    style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: c.credit),
                  ),
                ),
              ],
            )
          else if (busy)
            const Align(
              alignment: Alignment.centerLeft,
              child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)),
            )
          else
            Wrap(
              spacing: 8,
              runSpacing: 6,
              children: [
                if (suggested != null)
                  FilledButton.tonal(
                    onPressed: () => onConnect(suggested!),
                    child: Text(
                      'Connect to ${shortSchemeName(suggested!.schemeName)}',
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                OutlinedButton(
                  onPressed: onPickOther,
                  child: Text(suggested == null ? 'Pick its fund' : 'Another fund'),
                ),
              ],
            ),
        ],
      ),
    );
  }
}

/// A list of holdings to pick one from.
Future<FundHolding?> pickHolding(
  BuildContext context, {
  required List<FundHolding> holdings,
  required String title,
}) {
  return showModalBottomSheet<FundHolding>(
    context: context,
    useSafeArea: true,
    backgroundColor: context.c.surface,
    builder: (context) {
      final c = context.c;
      return ListView(
        shrinkWrap: true,
        padding: const EdgeInsets.fromLTRB(0, 14, 0, 20),
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: Text(title, style: TextStyle(fontSize: 15, fontWeight: FontWeight.w800, color: c.ink)),
          ),
          if (holdings.isEmpty)
            Padding(
              padding: const EdgeInsets.all(16),
              child: Text(
                'Every fund already has a SIP connected.',
                style: TextStyle(fontSize: 13, color: c.muted),
              ),
            ),
          for (final holding in holdings)
            ListTile(
              title: Text(shortSchemeName(holding.schemeName)),
              subtitle: Text(holding.categoryLabel),
              onTap: () => Navigator.of(context).pop(holding),
            ),
        ],
      );
    },
  );
}

/// Any recent debit, searchable - for a SIP instalment the suggestions
/// missed. Returns the one picked.
Future<Transaction?> pickRecentDebit(BuildContext context) {
  return showModalBottomSheet<Transaction>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: context.c.paper,
    shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(T.rLg))),
    builder: (_) => const _DebitPicker(),
  );
}

class _DebitPicker extends StatefulWidget {
  const _DebitPicker();

  @override
  State<_DebitPicker> createState() => _DebitPickerState();
}

class _DebitPickerState extends State<_DebitPicker> {
  final _query = TextEditingController();
  Timer? _debounce;
  List<Transaction>? _rows;
  String? _error;
  int _serial = 0;

  @override
  void initState() {
    super.initState();
    _load('');
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _query.dispose();
    super.dispose();
  }

  Future<void> _load(String q) async {
    final serial = ++_serial;
    final search = q.trim().isEmpty ? '' : '&q=${Uri.encodeQueryComponent(q.trim())}';
    try {
      final json = await ApiClient.instance.get('/transactions?type=DEBIT&pageSize=60$search');
      if (!mounted || serial != _serial) return;
      final items = json is Map && json['items'] is List ? json['items'] as List : const [];
      setState(() {
        _rows = [for (final row in items.whereType<Map<String, dynamic>>()) Transaction.fromJson(row)];
        _error = null;
      });
    } catch (error) {
      if (mounted && serial == _serial) {
        setState(() => _error = error is ApiException ? error.message : "Couldn't load your payments.");
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final rows = _rows;
    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.8,
      maxChildSize: 0.95,
      builder: (context, scroll) => Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 8),
            child: TextField(
              controller: _query,
              onChanged: (text) {
                _debounce?.cancel();
                _debounce = Timer(const Duration(milliseconds: 300), () => _load(text));
              },
              decoration: InputDecoration(
                hintText: 'Search payments',
                prefixIcon: const Icon(Icons.search),
                filled: true,
                fillColor: c.surface,
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(T.rSm)),
              ),
            ),
          ),
          Expanded(
            child: _error != null
                ? Center(child: Text(_error!, style: TextStyle(color: c.warn)))
                : rows == null
                    ? const Center(child: CircularProgressIndicator())
                    : rows.isEmpty
                        ? Center(child: Text('No payments match.', style: TextStyle(color: c.muted)))
                        : ListView.separated(
                            controller: scroll,
                            padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
                            itemCount: rows.length,
                            separatorBuilder: (_, __) => const SizedBox(height: 8),
                            itemBuilder: (context, i) {
                              final row = rows[i];
                              return DebitRow(
                                merchant: row.merchant,
                                occurredAt: row.occurredAt,
                                amountMinor: row.amountMinor,
                                actionLabel: 'Link',
                                onAction: () => Navigator.of(context).pop(row),
                              );
                            },
                          ),
          ),
        ],
      ),
    );
  }
}
