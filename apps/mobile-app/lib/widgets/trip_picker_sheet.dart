import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import 'ds/ds.dart';
import '../utils/format.dart';

/// Picks one of the user's trips, for a payment that belongs to it but fell
/// outside its dates - the tickets booked weeks before, the hotel's advance.
/// The running trip first, since that is nearly always the answer, then the
/// rest newest first. Null when dismissed.
Future<Trip?> showTripPickerSheet(BuildContext context) {
  return showModalBottomSheet<Trip>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: context.c.sf,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(Ds.r3xl)),
    ),
    builder: (_) => const _TripPicker(),
  );
}

/// Running first, then by when each started, newest first.
List<Trip> orderTripsForPicking(List<Trip> trips) {
  final ordered = [...trips];
  ordered.sort((a, b) {
    if (a.isActive != b.isActive) return a.isActive ? -1 : 1;
    return b.startedAt.compareTo(a.startedAt);
  });
  return ordered;
}

class _TripPicker extends StatefulWidget {
  const _TripPicker();

  @override
  State<_TripPicker> createState() => _TripPickerState();
}

class _TripPickerState extends State<_TripPicker> {
  List<Trip>? _trips;
  bool _error = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = false);
    try {
      final result = await ApiClient.instance.get('/trips') as List<dynamic>;
      if (!mounted) return;
      setState(() {
        _trips = orderTripsForPicking(
          result.map((t) => Trip.fromJson(t as Map<String, dynamic>)).toList(),
        );
      });
    } catch (_) {
      if (mounted) setState(() => _error = true);
    }
  }

  String _dates(Trip trip) {
    final from = formatShortDate(trip.startedAt);
    return trip.endedAt == null ? 'Since $from' : '$from – ${formatShortDate(trip.endedAt!)}';
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final trips = _trips;

    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.7),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const DsDragHandle(),
          const Padding(
            padding: EdgeInsets.fromLTRB(16, 0, 16, 12),
            child: DsSheetHeader(
              icon: DsIcons.briefcase,
              title: 'Add to a trip',
              subtitle: 'Whatever its date - a ticket booked weeks before still belongs to the trip.',
            ),
          ),
          Divider(height: 1, color: c.ln),
          if (_error)
            Padding(
              padding: const EdgeInsets.all(16),
              child: Container(
                padding: const EdgeInsets.fromLTRB(14, 6, 6, 6),
                decoration: BoxDecoration(color: c.sunk, borderRadius: BorderRadius.circular(Ds.rLg)),
                child: Row(
                  children: [
                    DsIcon(DsIcons.alertTriangle, size: 20, color: c.tx2),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        "Couldn't load your trips.",
                        style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2),
                      ),
                    ),
                    OutlinedButton(
                      onPressed: _load,
                      style: OutlinedButton.styleFrom(
                        minimumSize: const Size(0, 36),
                        padding: const EdgeInsets.symmetric(horizontal: 14),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Ds.rMd)),
                        textStyle: const TextStyle(fontFamily: Ds.sans, fontSize: 13, fontWeight: FontWeight.w600),
                      ),
                      child: const Text('Retry'),
                    ),
                  ],
                ),
              ),
            )
          else if (trips == null)
            const Padding(
              padding: EdgeInsets.all(16),
              child: DsSkeletonRows(count: 3),
            )
          else if (trips.isEmpty)
            const Padding(
              padding: EdgeInsets.fromLTRB(16, 16, 16, 24),
              child: DsEmpty(
                icon: DsIcons.briefcase,
                message: 'No trips yet. Start one from Trips, then add this to it.',
              ),
            )
          else
            Flexible(
              child: ListView(
                shrinkWrap: true,
                padding: const EdgeInsets.only(bottom: 16),
                children: [
                  for (final trip in trips)
                    InkWell(
                      onTap: () => Navigator.of(context).pop(trip),
                      child: Container(
                        constraints: const BoxConstraints(minHeight: 64),
                        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                        decoration: BoxDecoration(border: Border(bottom: BorderSide(color: c.ln))),
                        child: Row(
                          children: [
                            DsIconTile(
                              DsIcons.briefcase,
                              tone: trip.isActive ? DsTone.ac : DsTone.neutral,
                            ),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Row(
                                    children: [
                                      Flexible(
                                        child: Text(
                                          trip.name,
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                          style: TextStyle(
                                            fontSize: 15,
                                            height: 20 / 15,
                                            fontWeight: FontWeight.w600,
                                            color: c.tx,
                                          ),
                                        ),
                                      ),
                                      if (trip.isActive) ...[
                                        const SizedBox(width: 8),
                                        const DsBadge('Running', tone: DsTone.ac),
                                      ],
                                    ],
                                  ),
                                  const SizedBox(height: 2),
                                  Text(
                                    '${_dates(trip)} · ${formatMoneyShort(trip.totalMinor)}',
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: TextStyle(
                                      fontSize: 13,
                                      height: 18 / 13,
                                      color: c.tx3,
                                      fontFeatures: Ds.tabular,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                            const SizedBox(width: 8),
                            DsIcon(DsIcons.chevronRight, size: 18, color: c.tx3),
                          ],
                        ),
                      ),
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
