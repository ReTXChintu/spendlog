import 'dart:async';
import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../theme.dart';
import '../utils/format.dart';
import '../widgets/state_block.dart';

/// How far before a trip's start the list reaches, one step per "go back
/// further". Tickets are booked weeks out, sometimes months.
const tripLookbackSteps = [60, 180, 365];

/// "Added 3 payments to Goa".
String addedToTripMessage(int added, String tripName) =>
    'Added $added ${added == 1 ? 'payment' : 'payments'} to $tripName';

/// Picks payments from before a trip started - tickets, a hotel's advance -
/// and puts them on it. Its dates never would: the trip only takes in what
/// was spent while it ran.
///
/// Pops with how many were added, or null when nothing was.
class TripAddPaymentsScreen extends StatefulWidget {
  final Trip trip;

  const TripAddPaymentsScreen({super.key, required this.trip});

  @override
  State<TripAddPaymentsScreen> createState() => _TripAddPaymentsScreenState();
}

class _TripAddPaymentsScreenState extends State<TripAddPaymentsScreen> {
  final _search = TextEditingController();
  Timer? _debounce;

  int _step = 0;
  List<TripCandidate>? _rows;
  bool _error = false;
  bool _saving = false;

  /// Picked rows, kept by id across searches and a longer look back, so
  /// the total on the button never forgets one that scrolled out of view.
  final Map<String, TripCandidate> _picked = {};

  /// Which load is the latest, so a slow answer to an older search cannot
  /// replace a newer one.
  int _loadToken = 0;

  int get _days => tripLookbackSteps[_step];

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _search.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final token = ++_loadToken;
    setState(() {
      _rows = null;
      _error = false;
    });
    final q = _search.text.trim();
    try {
      final result = await ApiClient.instance.get(
        '/trips/${widget.trip.id}/candidates?days=$_days'
        '${q.isEmpty ? '' : '&q=${Uri.encodeQueryComponent(q)}'}',
      ) as List<dynamic>;
      if (!mounted || token != _loadToken) return;
      setState(() => _rows = result.map((r) => TripCandidate.fromJson(r as Map<String, dynamic>)).toList());
    } catch (_) {
      if (mounted && token == _loadToken) setState(() => _error = true);
    }
  }

  void _onSearch(String _) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 350), _load);
  }

  void _goBackFurther() {
    if (_step >= tripLookbackSteps.length - 1) return;
    setState(() => _step += 1);
    _load();
  }

  void _toggle(TripCandidate row) {
    setState(() {
      if (_picked.remove(row.id) == null) _picked[row.id] = row;
    });
  }

  Future<void> _add() async {
    if (_picked.isEmpty) return;
    setState(() => _saving = true);
    final navigator = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    try {
      final result = await ApiClient.instance.post(
        '/trips/${widget.trip.id}/add',
        {'transactionIds': _picked.keys.toList()},
      ) as Map<String, dynamic>;
      navigator.pop(result['added'] as int? ?? _picked.length);
    } catch (e) {
      if (!mounted) return;
      setState(() => _saving = false);
      messenger.showSnackBar(
        SnackBar(content: Text(e is ApiException ? e.message : "Couldn't add those. Try again.")),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final rows = _rows;
    final travel = rows?.where((r) => r.likelyTravel).toList() ?? const <TripCandidate>[];
    final rest = rows?.where((r) => !r.likelyTravel).toList() ?? const <TripCandidate>[];
    final from = widget.trip.startedAt.subtract(Duration(days: _days));
    final count = _picked.length;
    final totalMinor = _picked.values.fold<int>(0, (sum, row) => sum + row.amountMinor);

    return Scaffold(
      backgroundColor: c.paper,
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Add earlier payments'),
            Text(
              widget.trip.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 12, fontWeight: FontWeight.w500, color: c.muted),
            ),
          ],
        ),
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 6),
            child: TextField(
              controller: _search,
              onChanged: _onSearch,
              textInputAction: TextInputAction.search,
              decoration: InputDecoration(
                hintText: 'Search merchant or note',
                prefixIcon: const Icon(Icons.search, size: 20),
                isDense: true,
                filled: true,
                fillColor: c.surface,
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(T.rSm)),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(T.rSm),
                  borderSide: BorderSide(color: c.lineStrong),
                ),
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 8, 0),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    'Your payments since ${formatShortDate(from)}, on no trip yet',
                    maxLines: 2,
                    style: TextStyle(fontSize: 12, color: c.muted),
                  ),
                ),
                if (_step < tripLookbackSteps.length - 1)
                  TextButton.icon(
                    onPressed: _goBackFurther,
                    icon: const Icon(Icons.history, size: 16),
                    label: const Text('Go back further'),
                  ),
              ],
            ),
          ),
          Expanded(
            child: _error
                ? StateBlock(
                    icon: Icons.wifi_off,
                    warn: true,
                    title: "Couldn't load your payments",
                    body: 'The connection failed. Check your internet and try again.',
                    actionLabel: 'Retry',
                    onAction: _load,
                  )
                : rows == null
                    ? const Center(child: CircularProgressIndicator())
                    : rows.isEmpty
                        ? StateBlock(
                            icon: Icons.receipt_long_outlined,
                            title: 'Nothing to add',
                            body: _search.text.trim().isNotEmpty
                                ? 'No payment matches that search.'
                                : 'Every payment since ${formatShortDate(from)} is already on a trip, '
                                    'or there were none.',
                            actionLabel: _step < tripLookbackSteps.length - 1 ? 'Go back further' : null,
                            onAction: _step < tripLookbackSteps.length - 1 ? _goBackFurther : null,
                          )
                        : ListView(
                            padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
                            children: [
                              if (travel.isNotEmpty) ...[
                                const _GroupLabel('LOOKS LIKE TRAVEL'),
                                for (final row in travel)
                                  _CandidateRow(
                                    row: row,
                                    picked: _picked.containsKey(row.id),
                                    onTap: () => _toggle(row),
                                  ),
                              ],
                              if (rest.isNotEmpty) ...[
                                _GroupLabel(travel.isEmpty ? 'YOUR PAYMENTS' : 'EVERYTHING ELSE'),
                                for (final row in rest)
                                  _CandidateRow(
                                    row: row,
                                    picked: _picked.containsKey(row.id),
                                    onTap: () => _toggle(row),
                                  ),
                              ],
                            ],
                          ),
          ),
        ],
      ),
      bottomNavigationBar: SafeArea(
        child: Container(
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
          decoration: BoxDecoration(
            color: c.surface,
            border: Border(top: BorderSide(color: c.line)),
          ),
          child: SizedBox(
            width: double.infinity,
            child: FilledButton(
              onPressed: count == 0 || _saving ? null : _add,
              child: Text(
                count == 0
                    ? 'Pick the payments to add'
                    : 'Add $count ${count == 1 ? 'payment' : 'payments'} (${formatMoney(totalMinor)})',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _GroupLabel extends StatelessWidget {
  final String text;
  const _GroupLabel(this.text);

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Padding(
      padding: const EdgeInsets.fromLTRB(2, 14, 2, 6),
      child: Text(
        text,
        style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w700, letterSpacing: 0.5, color: c.muted),
      ),
    );
  }
}

class _CandidateRow extends StatelessWidget {
  final TripCandidate row;
  final bool picked;
  final VoidCallback onTap;

  const _CandidateRow({required this.row, required this.picked, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final meta = [
      formatShortDate(row.occurredAt),
      if (row.accountLabel != null) row.accountLabel!,
      if (row.categoryName != null) row.categoryName!,
    ].join(' · ');

    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      decoration: BoxDecoration(
        color: picked ? c.brand50 : c.surface,
        border: Border.all(color: picked ? c.brand : c.line),
        borderRadius: BorderRadius.circular(T.rMd),
      ),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(T.rMd),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(4, 8, 14, 8),
          child: Row(
            children: [
              Checkbox(value: picked, onChanged: (_) => onTap()),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      row.merchant ?? 'Payment',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700, color: c.ink),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      meta,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 11.5, color: c.muted),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 10),
              Text(
                formatMoney(row.amountMinor),
                style: kNum.copyWith(fontSize: 13.5, fontWeight: FontWeight.w700, color: c.ink),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
