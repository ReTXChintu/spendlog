import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../widgets/ds/ds.dart';
import '../utils/format.dart';
import '../widgets/state_block.dart';
import 'join_trip_screen.dart';
import 'trip_add_payments_screen.dart';
import 'trip_members_screen.dart';
import 'trip_payments_screen.dart';

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
    await _loadDetail(trip);
  }

  /// The open trip's summary and settlement.
  Future<void> _loadDetail(Trip trip) async {
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

  /// The list's totals, and the open trip's figures, after payments were
  /// put on a trip or taken off it somewhere else.
  Future<void> _refresh(Trip trip) async {
    await _load();
    if (mounted && _openId == trip.id) await _loadDetail(trip);
  }

  Future<void> _addEarlier(Trip trip) async {
    final added = await Navigator.of(context).push<int>(
      MaterialPageRoute(builder: (_) => TripAddPaymentsScreen(trip: trip)),
    );
    if (added == null || added == 0 || !mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(addedToTripMessage(added, trip.name))),
    );
    await _refresh(trip);
  }

  Future<void> _openPayments(Trip trip) async {
    final changed = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (_) => TripPaymentsScreen(trip: trip)),
    );
    if (changed == true && mounted) await _refresh(trip);
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
      backgroundColor: c.bg,
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: kPagePad,
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
            const SizedBox(height: 20),
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
                child: Center(child: DsSpinner()),
              )
            else if (_trips!.isEmpty)
              const StateBlock(
                icon: Icons.luggage_outlined,
                title: 'No trips yet',
                body: 'Start one when you set off. Everything spent until you end it gets totalled '
                    'together, so you can see what the whole thing cost rather than picking it out '
                    'of a month.',
              )
            else ...[
              const DsLabel('Your trips', padding: EdgeInsets.only(left: 2, bottom: 8)),
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
                  onAddEarlier: () => _addEarlier(trip),
                  onPayments: () => _openPayments(trip),
                  onDelete: () => _run(
                    () => ApiClient.instance.delete('/trips/${trip.id}'),
                    done: 'Trip deleted. Every payment kept.',
                  ),
                ),
            ],
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

    return DsCard(
      color: running ? c.acSoft : c.sf,
      borderColor: running ? c.acLine : c.ln,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              DsIconTile(DsIcons.briefcase, tone: running ? DsTone.ac : DsTone.neutral, onTinted: running),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    DsLabel(
                      running ? 'Trip mode is on' : 'Trip mode is off',
                      color: running ? c.ac : c.tx3,
                    ),
                    const SizedBox(height: 2),
                    if (running) ...[
                      Text(
                        active!.name,
                        style: TextStyle(fontSize: 17, height: 24 / 17, fontWeight: FontWeight.w600, color: c.tx),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        'Since ${formatDateTime(active!.startedAt)} · '
                        '${formatMoney(active!.totalMinor)} so far',
                        style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2, fontFeatures: Ds.tabular),
                      ),
                    ] else
                      Text(
                        'Start one and everything spent from now on goes onto it, until you end it.',
                        style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2),
                      ),
                  ],
                ),
              ),
            ],
          ),
          if (running && (active!.source?.linked ?? false)) ...[
            const SizedBox(height: 12),
            Text(
              "Planned in Trippin, so it runs on Trippin's dates. Ending it here works, "
              "but Trippin's next change to the trip puts its dates back.",
              style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
            ),
          ],
          const SizedBox(height: 16),
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
              const SizedBox(width: 8),
              OutlinedButton(
                onPressed: busy ? null : onJoin,
                style: OutlinedButton.styleFrom(minimumSize: const Size(64, 48)),
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

  /// Tickets and bookings paid before the trip started, which its dates
  /// never take in. Offered on an ended trip too: the flights get booked
  /// before, and remembered after.
  final VoidCallback onAddEarlier;
  final VoidCallback onPayments;

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
    required this.onAddEarlier,
    required this.onPayments,
  });

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    // The open trip is the selected list item: an accent tint and ring.
    final selected = isOpen;

    return Container(
      margin: const EdgeInsets.only(bottom: kCardGap),
      decoration: BoxDecoration(
        color: c.sf,
        border: Border.all(color: selected ? c.acLine : c.ln),
        borderRadius: BorderRadius.circular(Ds.rXl),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        children: [
          Material(
            color: selected ? c.acSoft : Colors.transparent,
            child: InkWell(
              onTap: onTap,
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    DsMonogram(
                      trip.name,
                      tone: trip.isActive ? DsTone.ac : DsTone.neutral,
                      onTinted: selected,
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            trip.name,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontWeight: FontWeight.w600,
                              fontSize: 15,
                              height: 20 / 15,
                              color: c.tx,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            '${formatDayLabel(istDayOf(trip.startedAt))}'
                            '${trip.endedAt != null ? ' – ${formatDayLabel(istDayOf(trip.endedAt!))}' : ' – now'}'
                            ' · ${trip.transactionCount} '
                            '${trip.transactionCount == 1 ? 'payment' : 'payments'}',
                            style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3),
                          ),
                          if (trip.isActive) ...[
                            const SizedBox(height: 6),
                            DsBadge('Running', tone: DsTone.ac, onTinted: selected),
                          ],
                        ],
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      formatMoney(trip.totalMinor),
                      style: kNum.copyWith(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
                    ),
                    const SizedBox(width: 4),
                    DsIcon(isOpen ? DsIcons.chevronUp : DsIcons.chevronRight, size: 18, color: c.tx3),
                  ],
                ),
              ),
            ),
          ),
          if (trip.source != null) _TripSourceRow(source: trip.source!, tinted: selected),
          if (isOpen)
            Container(
              decoration: BoxDecoration(border: Border(top: BorderSide(color: c.ln))),
              padding: const EdgeInsets.all(16),
              child: summary == null
                  ? const Padding(
                      padding: EdgeInsets.symmetric(vertical: 16),
                      child: Center(child: DsSpinner()),
                    )
                  : Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Expanded(
                              child: _Figure(label: 'Total', value: formatMoneyShort(summary!.totalMinor)),
                            ),
                            const SizedBox(width: 8),
                            Expanded(child: _Figure(label: 'Days', value: '${summary!.dayCount}')),
                            const SizedBox(width: 8),
                            Expanded(
                              child: _Figure(
                                label: 'Per day',
                                value: formatMoneyShort(summary!.perDayMinor),
                              ),
                            ),
                          ],
                        ),
                        if (summary!.byMember.length > 1) ...[
                          const SizedBox(height: 16),
                          const DsLabel('Who paid'),
                          const SizedBox(height: 4),
                          for (final member in summary!.byMember)
                            _AmountRow(label: '${member.name} paid', amount: formatMoneyShort(member.spentMinor)),
                        ],
                        if (summary!.byCategory.isNotEmpty) ...[
                          const SizedBox(height: 16),
                          const DsLabel('By category'),
                          const SizedBox(height: 4),
                          for (final entry in summary!.byCategory)
                            _AmountRow(label: entry.name, amount: formatMoneyShort(entry.amountMinor)),
                        ],
                        if (settlement != null && settlement!.balances.length > 1) ...[
                          const SizedBox(height: 16),
                          Container(
                            width: double.infinity,
                            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                            decoration: BoxDecoration(
                              color: c.goodSoft,
                              borderRadius: BorderRadius.circular(Ds.rLg),
                            ),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  'Settle up',
                                  style: TextStyle(
                                    fontSize: 15,
                                    height: 20 / 15,
                                    fontWeight: FontWeight.w600,
                                    color: c.tx,
                                  ),
                                ),
                                const SizedBox(height: 8),
                                if (settlement!.transfers.isEmpty)
                                  Text(
                                    'Everyone is square — nobody owes anybody anything.',
                                    style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2),
                                  )
                                else
                                  for (final transfer in settlement!.transfers)
                                    Padding(
                                      padding: const EdgeInsets.symmetric(vertical: 4),
                                      child: Row(
                                        children: [
                                          DsAvatar(transfer.fromName, size: 28, tone: DsTone.good),
                                          const SizedBox(width: 8),
                                          Expanded(
                                            child: Text(
                                              '${transfer.fromName} → ${transfer.toName}',
                                              maxLines: 1,
                                              overflow: TextOverflow.ellipsis,
                                              style: TextStyle(fontSize: 14, height: 20 / 14, color: c.tx),
                                            ),
                                          ),
                                          const SizedBox(width: 8),
                                          Text(
                                            formatMoney(transfer.amountMinor),
                                            style: kNum.copyWith(
                                              fontSize: 14,
                                              fontWeight: FontWeight.w600,
                                              color: c.good,
                                            ),
                                          ),
                                        ],
                                      ),
                                    ),
                              ],
                            ),
                          ),
                        ],
                        const SizedBox(height: 16),
                        // Stacked full width: side by side, "Add earlier
                        // payments" was cut short on a 360 px phone.
                        Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            OutlinedButton.icon(
                              onPressed: busy ? null : onAddEarlier,
                              icon: const DsIcon(DsIcons.plus, size: 18),
                              label: const Text(
                                'Add earlier payments',
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                            const SizedBox(height: 8),
                            OutlinedButton(
                              onPressed: busy ? null : onPayments,
                              child: const Text(
                                'Payments',
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 4),
                        Row(
                          children: [
                            // Wraps rather than running under Delete on a
                            // narrow phone with large text.
                            Expanded(
                              child: Wrap(
                                children: [
                                  TextButton.icon(
                                    onPressed: busy ? null : onMembers,
                                    icon: const DsIcon(DsIcons.users, size: 18),
                                    label: const Text('People'),
                                  ),
                                  TextButton.icon(
                                    onPressed: busy ? null : onRescan,
                                    icon: const DsIcon(DsIcons.refresh, size: 18),
                                    label: const Text('Re-scan'),
                                  ),
                                ],
                              ),
                            ),
                            TextButton.icon(
                              onPressed: busy ? null : onDelete,
                              style: TextButton.styleFrom(foregroundColor: c.crit),
                              icon: const DsIcon(DsIcons.trash, size: 18),
                              label: const Text('Delete'),
                            ),
                          ],
                        ),
                        Text(
                          'Deleting a trip keeps every payment — only the label goes.',
                          style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
                        ),
                      ],
                    ),
            ),
        ],
      ),
    );
  }
}

/// A label and an amount on one divided row.
class _AmountRow extends StatelessWidget {
  final String label;
  final String amount;

  const _AmountRow({required this.label, required this.amount});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Container(
      constraints: const BoxConstraints(minHeight: 40),
      decoration: BoxDecoration(border: Border(bottom: BorderSide(color: c.ln))),
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        children: [
          Expanded(
            child: Text(label, style: TextStyle(fontSize: 14, height: 20 / 14, color: c.tx2)),
          ),
          const SizedBox(width: 8),
          Text(
            amount,
            style: kNum.copyWith(fontSize: 14, fontWeight: FontWeight.w600, color: c.tx),
          ),
        ],
      ),
    );
  }
}

/// Where a trip planned in Trippin says so: a chip back to it while
/// linked, and a note of where it came from once tracking was switched off
/// there.
class _TripSourceRow extends StatelessWidget {
  final TripSource source;
  final bool tinted;

  const _TripSourceRow({required this.source, this.tinted = false});

  Future<void> _open() async {
    final url = source.url;
    if (url == null || url.isEmpty) return;
    await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final linked = source.linked;
    final hasUrl = source.url != null && source.url!.isNotEmpty;
    final fg = linked ? c.ac : c.tx2;

    return Container(
      width: double.infinity,
      color: tinted ? c.acSoft : null,
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // An accent badge while linked (neutral once it isn't), which
          // opens the trip in Trippin.
          Material(
            color: linked ? (tinted ? c.sf : c.acSoft) : c.sunk,
            borderRadius: BorderRadius.circular(Ds.rSm),
            child: InkWell(
              borderRadius: BorderRadius.circular(Ds.rSm),
              onTap: hasUrl ? _open : null,
              child: Container(
                constraints: const BoxConstraints(minHeight: 28),
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    DsIcon(DsIcons.link, size: 14, color: fg),
                    const SizedBox(width: 6),
                    Text(
                      linked ? 'Planned in Trippin' : 'Was linked to Trippin',
                      style: TextStyle(
                        fontSize: 12,
                        height: 16 / 12,
                        fontWeight: FontWeight.w600,
                        color: fg,
                      ),
                    ),
                    if (hasUrl) ...[
                      const SizedBox(width: 4),
                      DsIcon(DsIcons.arrowUpRight, size: 14, color: fg),
                    ],
                  ],
                ),
              ),
            ),
          ),
          const SizedBox(height: 6),
          Text(
            linked
                ? "Its name, dates and people follow Trippin. You can still change them here, "
                    "but Trippin's next change overwrites yours."
                : "Tracking was switched off in Trippin. Everything on it stayed, and it's an "
                    'ordinary trip now.',
            style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
          ),
        ],
      ),
    );
  }
}

/// A stat tile in miniature: label over a tabular figure, on `sf2`.
class _Figure extends StatelessWidget {
  final String label;
  final String value;

  const _Figure({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: c.sf2,
        border: Border.all(color: c.ln),
        borderRadius: BorderRadius.circular(Ds.rLg),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          DsLabel(label),
          const SizedBox(height: 2),
          // A lakh-sized trip on a narrow phone shrinks a little rather than
          // losing digits.
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(
              value,
              style: kNum.copyWith(fontSize: 17, height: 24 / 17, fontWeight: FontWeight.w600, color: c.tx),
            ),
          ),
        ],
      ),
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
