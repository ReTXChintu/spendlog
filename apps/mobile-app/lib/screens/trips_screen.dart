import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../theme.dart';
import '../utils/format.dart';
import '../widgets/state_block.dart';
import 'join_trip_screen.dart';
import 'trip_members_screen.dart';

/// Trips: a holiday totalled on its own.
///
/// Turning trip mode on files everything spent from that moment under the
/// trip, so "what did Goa cost" has an answer without anyone tagging
/// payments one at a time.
class TripsScreen extends StatefulWidget {
  const TripsScreen({super.key});

  @override
  State<TripsScreen> createState() => _TripsScreenState();
}

class _TripsScreenState extends State<TripsScreen> {
  List<Trip>? _trips;
  bool _error = false;
  bool _busy = false;

  String? _openId;
  TripSummary? _summary;
  TripSettlement? _settlement;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final result = await ApiClient.instance.get('/trips') as List<dynamic>;
      if (!mounted) return;
      setState(() {
        _trips = result.map((t) => Trip.fromJson(t as Map<String, dynamic>)).toList();
        _error = false;
      });
    } catch (_) {
      if (mounted) setState(() => _error = true);
    }
  }

  Future<void> _open(Trip trip) async {
    if (_openId == trip.id) {
      setState(() {
        _openId = null;
        _summary = null;
        _settlement = null;
      });
      return;
    }
    setState(() {
      _openId = trip.id;
      _summary = null;
      _settlement = null;
    });
    try {
      final results = await Future.wait([
        ApiClient.instance.get('/trips/${trip.id}/summary'),
        ApiClient.instance.get('/trips/${trip.id}/settlement'),
      ]);
      if (mounted && _openId == trip.id) {
        setState(() {
          _summary = TripSummary.fromJson(results[0] as Map<String, dynamic>);
          _settlement = TripSettlement.fromJson(results[1] as Map<String, dynamic>);
        });
      }
    } catch (_) {
      // The row stays open with its headline figures.
    }
  }

  Future<void> _run(Future<void> Function() action, {String? done}) async {
    setState(() => _busy = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      await action();
      await _load();
      if (done != null && mounted) {
        messenger.showSnackBar(SnackBar(content: Text(done)));
      }
    } catch (e) {
      if (mounted) {
        messenger.showSnackBar(
          SnackBar(content: Text(e is ApiException ? e.message : "That didn't work.")),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _rescan(Trip trip) async {
    final messenger = ScaffoldMessenger.of(context);
    await _run(() async {
      final result =
          await ApiClient.instance.post('/trips/${trip.id}/rescan') as Map<String, dynamic>;
      final claimed = result['claimedCount'] as int? ?? 0;
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            claimed == 0 ? 'Nothing else from those dates to add.' : 'Added $claimed more.',
          ),
        ),
      );
    });
  }

  Future<void> _joinTrip() async {
    final joined = await Navigator.of(context).push<String>(
      MaterialPageRoute(builder: (_) => const JoinTripScreen()),
    );
    if (joined == null || !mounted) return;

    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Joined $joined.')));
    await _load();
  }

  Future<void> _openMembers(Trip trip) async {
    await Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => TripMembersScreen(tripId: trip.id, tripName: trip.name),
      ),
    );
    await _load();
  }

  Future<void> _startTrip() async {
    final name = await showDialog<String>(
      context: context,
      builder: (context) => const _NameTripDialog(),
    );
    if (name == null || name.trim().isEmpty) return;

    if (!mounted) return;
    final messenger = ScaffoldMessenger.of(context);

    await _run(() async {
      final result =
          await ApiClient.instance.post('/trips', {'name': name.trim()}) as Map<String, dynamic>;
      final claimed = result['claimedCount'] as int? ?? 0;
      if (claimed > 0) {
        messenger.showSnackBar(
          SnackBar(
            content: Text(
              '$claimed ${claimed == 1 ? 'payment' : 'payments'} already made today went onto it.',
            ),
          ),
        );
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final active = _trips?.where((t) => t.isActive).firstOrNull;

    return Scaffold(
      backgroundColor: c.paper,
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 28),
          children: [
            _TripModeCard(
              active: active,
              busy: _busy,
              onStart: _startTrip,
              onJoin: _joinTrip,
              onEnd: active == null
                  ? null
                  : () => _run(
                        () => ApiClient.instance.patch('/trips/${active.id}', {
                          'endedAt': DateTime.now().toUtc().toIso8601String(),
                        }),
                        done: 'Trip ended.',
                      ),
            ),
            const SizedBox(height: 18),
            if (_error)
              StateBlock(
                icon: Icons.wifi_off,
                warn: true,
                title: "Couldn't load your trips",
                body: 'The connection failed. Check your internet and try again.',
                actionLabel: 'Retry',
                onAction: _load,
              )
            else if (_trips == null)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 40),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (_trips!.isEmpty)
              const StateBlock(
                icon: Icons.luggage_outlined,
                title: 'No trips yet',
                body: 'Start one when you set off. Everything spent until you end it gets totalled '
                    'together, so you can see what the whole thing cost rather than picking it out '
                    'of a month.',
              )
            else
              for (final trip in _trips!)
                _TripCard(
                  trip: trip,
                  isOpen: _openId == trip.id,
                  summary: _openId == trip.id ? _summary : null,
                  settlement: _openId == trip.id ? _settlement : null,
                  busy: _busy,
                  onTap: () => _open(trip),
                  onMembers: () => _openMembers(trip),
                  onRescan: () => _rescan(trip),
                  onDelete: () => _run(
                    () => ApiClient.instance.delete('/trips/${trip.id}'),
                    done: 'Trip deleted. Every payment kept.',
                  ),
                ),
          ],
        ),
      ),
    );
  }
}

class _TripModeCard extends StatelessWidget {
  final Trip? active;
  final bool busy;
  final VoidCallback onStart;
  final VoidCallback? onEnd;
  final VoidCallback onJoin;

  const _TripModeCard({
    required this.active,
    required this.busy,
    required this.onStart,
    required this.onEnd,
    required this.onJoin,
  });

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final running = active != null;

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: c.surface,
        border: Border.all(color: running ? c.brand : c.line),
        borderRadius: BorderRadius.circular(T.rMd),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            running ? 'TRIP MODE IS ON' : 'TRIP MODE IS OFF',
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.5,
              color: running ? c.brandDark : c.muted,
            ),
          ),
          const SizedBox(height: 4),
          if (running) ...[
            Text(
              active!.name,
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800, color: c.ink),
            ),
            const SizedBox(height: 3),
            Text(
              'Since ${formatDateTime(active!.startedAt)} · '
              '${formatMoney(active!.totalMinor)} so far',
              style: TextStyle(fontSize: 12.5, color: c.muted),
            ),
          ] else
            Text(
              'Start one and everything spent from now on goes onto it, until you end it.',
              style: TextStyle(fontSize: 12.5, height: 1.45, color: c.muted),
            ),
          const SizedBox(height: 14),
          Row(
            children: [
              Expanded(
                child: running
                    ? FilledButton(onPressed: busy ? null : onEnd, child: const Text('End trip'))
                    : FilledButton(
                        onPressed: busy ? null : onStart,
                        child: const Text('Start a trip'),
                      ),
              ),
              const SizedBox(width: 10),
              OutlinedButton(
                onPressed: busy ? null : onJoin,
                child: const Text('Join one'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _TripCard extends StatelessWidget {
  final Trip trip;
  final bool isOpen;
  final TripSummary? summary;
  final TripSettlement? settlement;
  final bool busy;
  final VoidCallback onTap;
  final VoidCallback onMembers;
  final VoidCallback onRescan;
  final VoidCallback onDelete;

  const _TripCard({
    required this.trip,
    required this.isOpen,
    required this.summary,
    required this.settlement,
    required this.busy,
    required this.onTap,
    required this.onMembers,
    required this.onRescan,
    required this.onDelete,
  });

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      decoration: BoxDecoration(
        color: c.surface,
        border: Border.all(color: trip.isActive ? c.brand : c.line),
        borderRadius: BorderRadius.circular(T.rMd),
      ),
      child: Column(
        children: [
          GestureDetector(
            onTap: onTap,
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Row(
                          children: [
                            Flexible(
                              child: Text(
                                trip.name,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  fontWeight: FontWeight.w800,
                                  fontSize: 14.5,
                                  color: c.ink,
                                ),
                              ),
                            ),
                            if (trip.isActive) ...[
                              const SizedBox(width: 8),
                              Container(
                                padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                                decoration: BoxDecoration(
                                  color: c.brand50,
                                  borderRadius: BorderRadius.circular(100),
                                ),
                                child: Text(
                                  'RUNNING',
                                  style: TextStyle(
                                    fontSize: 9.5,
                                    fontWeight: FontWeight.w700,
                                    letterSpacing: 0.4,
                                    color: c.brandDark,
                                  ),
                                ),
                              ),
                            ],
                          ],
                        ),
                        const SizedBox(height: 3),
                        Text(
                          '${formatDayLabel(trip.startedAt.toIso8601String().substring(0, 10))}'
                          '${trip.endedAt != null ? ' – ${formatDayLabel(trip.endedAt!.toIso8601String().substring(0, 10))}' : ' – now'}'
                          ' · ${trip.transactionCount} '
                          '${trip.transactionCount == 1 ? 'payment' : 'payments'}',
                          style: TextStyle(fontSize: 12, color: c.muted),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 10),
                  Text(
                    formatMoney(trip.totalMinor),
                    style: kNum.copyWith(fontSize: 15, fontWeight: FontWeight.w800, color: c.ink),
                  ),
                  Icon(isOpen ? Icons.expand_less : Icons.chevron_right, size: 18, color: c.muted),
                ],
              ),
            ),
          ),
          if (isOpen)
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
              child: summary == null
                  ? const Padding(
                      padding: EdgeInsets.symmetric(vertical: 16),
                      child: Center(child: CircularProgressIndicator()),
                    )
                  : Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                          decoration: BoxDecoration(
                            color: c.brand50,
                            borderRadius: BorderRadius.circular(T.rMd),
                          ),
                          child: Row(
                            mainAxisAlignment: MainAxisAlignment.spaceBetween,
                            children: [
                              _Figure(label: 'Total', value: formatMoneyShort(summary!.totalMinor)),
                              _Figure(label: 'Days', value: '${summary!.dayCount}'),
                              _Figure(
                                label: 'Per day',
                                value: formatMoneyShort(summary!.perDayMinor),
                              ),
                            ],
                          ),
                        ),
                        if (summary!.byMember.length > 1) ...[
                          const SizedBox(height: 12),
                          for (final member in summary!.byMember)
                            Padding(
                              padding: const EdgeInsets.only(bottom: 6),
                              child: Row(
                                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                children: [
                                  Text('${member.name} paid',
                                      style: TextStyle(fontSize: 12.8, color: c.ink70)),
                                  Text(
                                    formatMoneyShort(member.spentMinor),
                                    style: kNum.copyWith(
                                      fontSize: 12.8,
                                      fontWeight: FontWeight.w700,
                                      color: c.ink70,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          Divider(color: c.line, height: 18),
                        ],
                        if (summary!.byCategory.isNotEmpty) ...[
                          const SizedBox(height: 12),
                          for (final entry in summary!.byCategory)
                            Padding(
                              padding: const EdgeInsets.only(bottom: 6),
                              child: Row(
                                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                children: [
                                  Text(entry.name,
                                      style: TextStyle(fontSize: 12.8, color: c.ink70)),
                                  Text(
                                    formatMoneyShort(entry.amountMinor),
                                    style: kNum.copyWith(fontSize: 12.8, color: c.ink70),
                                  ),
                                ],
                              ),
                            ),
                        ],
                        if (settlement != null && settlement!.balances.length > 1) ...[
                          const SizedBox(height: 12),
                          Container(
                            width: double.infinity,
                            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                            decoration: BoxDecoration(
                              color: c.credit50,
                              borderRadius: BorderRadius.circular(T.rMd),
                            ),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  'SETTLING UP',
                                  style: TextStyle(
                                    fontSize: 10.5,
                                    fontWeight: FontWeight.w700,
                                    letterSpacing: 0.5,
                                    color: c.muted,
                                  ),
                                ),
                                const SizedBox(height: 8),
                                if (settlement!.transfers.isEmpty)
                                  Text(
                                    'Everyone is square — nobody owes anybody anything.',
                                    style: TextStyle(fontSize: 12.8, color: c.muted),
                                  )
                                else
                                  for (final transfer in settlement!.transfers)
                                    Padding(
                                      padding: const EdgeInsets.only(bottom: 5),
                                      child: Row(
                                        children: [
                                          Expanded(
                                            child: Text(
                                              '${transfer.fromName} → ${transfer.toName}',
                                              maxLines: 1,
                                              overflow: TextOverflow.ellipsis,
                                              style: TextStyle(fontSize: 13, color: c.ink),
                                            ),
                                          ),
                                          Text(
                                            formatMoney(transfer.amountMinor),
                                            style: kNum.copyWith(
                                              fontSize: 13,
                                              fontWeight: FontWeight.w700,
                                              color: c.ink,
                                            ),
                                          ),
                                        ],
                                      ),
                                    ),
                              ],
                            ),
                          ),
                        ],
                        const SizedBox(height: 10),
                        Row(
                          children: [
                            TextButton.icon(
                              onPressed: busy ? null : onMembers,
                              icon: const Icon(Icons.group_outlined, size: 16),
                              label: const Text('People'),
                            ),
                            TextButton.icon(
                              onPressed: busy ? null : onRescan,
                              icon: const Icon(Icons.sync, size: 15),
                              label: const Text('Re-scan'),
                            ),
                            const Spacer(),
                            TextButton(
                              onPressed: busy ? null : onDelete,
                              style: TextButton.styleFrom(foregroundColor: c.debit),
                              child: const Text('Delete'),
                            ),
                          ],
                        ),
                        Text(
                          'Deleting a trip keeps every payment — only the label goes.',
                          style: TextStyle(fontSize: 11.5, color: c.mutedLight),
                        ),
                      ],
                    ),
            ),
        ],
      ),
    );
  }
}

class _Figure extends StatelessWidget {
  final String label;
  final String value;

  const _Figure({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: c.muted)),
        const SizedBox(height: 2),
        Text(value, style: kNum.copyWith(fontSize: 15, fontWeight: FontWeight.w800, color: c.ink)),
      ],
    );
  }
}

class _NameTripDialog extends StatefulWidget {
  const _NameTripDialog();

  @override
  State<_NameTripDialog> createState() => _NameTripDialogState();
}

class _NameTripDialogState extends State<_NameTripDialog> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Start a trip'),
      content: TextField(
        controller: _controller,
        autofocus: true,
        decoration: const InputDecoration(hintText: 'Goa, Dec'),
        onSubmitted: (value) => Navigator.of(context).pop(value),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(_controller.text),
          child: const Text('Start'),
        ),
      ],
    );
  }
}
