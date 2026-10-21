import 'dart:async';
import 'package:flutter/material.dart';
import '../../models/fund_models.dart';
import '../../models/models.dart' show Transaction;
import '../../services/api_client.dart';
import '../../widgets/ds/ds.dart';
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
          const DsDragHandle(),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 8, 8),
            child: DsSheetHeader(
              title: 'Link SIP payments',
              icon: DsIcons.link,
              trailing: TextButton(
                onPressed: () => Navigator.of(context).pop(changed),
                child: Text(changed ? 'Done' : 'Close'),
              ),
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
                  style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2),
                ),
                if (_error != null) ...[
                  const SizedBox(height: 12),
                  DsCallout(tone: DsTone.crit, title: _error!),
                ],
                for (final entry in byHolding.entries) ...[
                  const SizedBox(height: 20),
                  FundSectionHeader(
                    title: shortSchemeName(_holding(entry.key)?.schemeName ?? entry.value.first.schemeName),
                    count: entry.value.length,
                  ),
                  const SizedBox(height: 10),
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
                  const SizedBox(height: 20),
                  const FundSectionHeader(title: 'SIP commitments to connect'),
                  const SizedBox(height: 4),
                  Text(
                    'Monthly SIPs set up under fixed costs. Connect one to its fund and every debit matched to it '
                    'counts as an instalment from now on.',
                    style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3),
                  ),
                  const SizedBox(height: 10),
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
    final name = merchant ?? 'Debit';
    return FundCard(
      padding: const EdgeInsets.fromLTRB(12, 12, 8, 12),
      child: Row(
        children: [
          DsMonogram(name, size: 36),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w500, color: c.tx),
                ),
                Text(
                  [
                    if (occurredAt != null) formatShortDate(occurredAt!),
                    formatMoney(amountMinor),
                  ].join(' · '),
                  style: kNum.copyWith(fontSize: 13, height: 18 / 13, color: c.tx2),
                ),
                if (detail != null && detail!.isNotEmpty)
                  Text(detail!, style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3)),
              ],
            ),
          ),
          const SizedBox(width: 8),
          if (done)
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: 8),
              child: DsBadge('Linked', tone: DsTone.good, icon: DsIcons.check),
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
    const small = Size(0, 40);
    return FundCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const DsIconTile(DsIcons.repeat, tone: DsTone.ac),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      commitment.name,
                      style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
                    ),
                    Text(
                      [
                        formatMoneyShort(commitment.amountMinor) + (day == null ? '' : ' on ${ordinalDay(day)}'),
                        '${commitment.matchedDebits} ${commitment.matchedDebits == 1 ? 'debit' : 'debits'} matched',
                        if (!commitment.isActive) 'paused',
                      ].join(' · '),
                      style: kNum.copyWith(fontSize: 13, height: 18 / 13, color: c.tx3),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          if (connectedTo != null)
            Row(
              children: [
                DsIcon(DsIcons.check, size: 16, color: c.good),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    'Connected to ${shortSchemeName(connectedTo!.schemeName)}',
                    style: TextStyle(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w600, color: c.good),
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
              runSpacing: 8,
              children: [
                if (suggested != null)
                  FilledButton(
                    style: FilledButton.styleFrom(
                      minimumSize: small,
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      textStyle: const TextStyle(fontFamily: Ds.sans, fontSize: 14, fontWeight: FontWeight.w600),
                    ),
                    onPressed: () => onConnect(suggested!),
                    child: Text(
                      'Connect to ${shortSchemeName(suggested!.schemeName)}',
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                OutlinedButton(
                  style: OutlinedButton.styleFrom(minimumSize: small),
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
    builder: (context) {
      return ListView(
        shrinkWrap: true,
        padding: const EdgeInsets.fromLTRB(0, 0, 0, 16),
        children: [
          const DsDragHandle(),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: DsSheetHeader(title: title),
          ),
          if (holdings.isEmpty)
            const Padding(
              padding: EdgeInsets.all(16),
              child: DsEmpty(icon: DsIcons.check, message: 'Every fund already has a SIP connected.'),
            ),
          for (final holding in holdings)
            ListTile(
              contentPadding: const EdgeInsets.symmetric(horizontal: 16),
              leading: DsMonogram(shortSchemeName(holding.schemeName), size: 36),
              title: Text(shortSchemeName(holding.schemeName)),
              subtitle: Text(holding.categoryLabel),
              trailing: DsIcon(DsIcons.chevronRight, size: 18, color: context.c.tx3),
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
          const DsDragHandle(),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
            child: TextField(
              controller: _query,
              onChanged: (text) {
                _debounce?.cancel();
                _debounce = Timer(const Duration(milliseconds: 300), () => _load(text));
              },
              style: TextStyle(fontSize: 14, color: c.tx),
              decoration: InputDecoration(
                hintText: 'Search payments',
                hintStyle: TextStyle(fontSize: 14, color: c.tx3),
                isDense: true,
                contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                prefixIcon: Padding(
                  padding: const EdgeInsets.only(left: 12, right: 8),
                  child: DsIcon(DsIcons.search, size: 20, color: c.tx3),
                ),
                prefixIconConstraints: const BoxConstraints(minWidth: 40, minHeight: 44),
              ),
            ),
          ),
          Expanded(
            child: _error != null
                ? Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    child: Align(alignment: Alignment.topCenter, child: DsCallout(tone: DsTone.warn, title: _error!)),
                  )
                : rows == null
                    ? const Center(child: DsSpinner())
                    : rows.isEmpty
                        ? const Padding(
                            padding: EdgeInsets.symmetric(horizontal: 16),
                            child: Align(
                              alignment: Alignment.topCenter,
                              child: DsEmpty(icon: DsIcons.search, message: 'No payments match.'),
                            ),
                          )
                        : ListView.separated(
                            controller: scroll,
                            padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
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
