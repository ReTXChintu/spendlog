import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../theme.dart';
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
    backgroundColor: context.c.surface,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(T.rLg)),
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
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 18, 16, 4),
            child: Text(
              'Add to a trip',
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800, color: c.ink),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: Text(
              'Whatever its date - a ticket booked weeks before still belongs to the trip.',
              style: TextStyle(fontSize: 12, height: 1.4, color: c.muted),
            ),
          ),
          if (_error)
            Padding(
              padding: const EdgeInsets.all(16),
              child: Row(
                children: [
                  Expanded(
                    child: Text("Couldn't load your trips.", style: TextStyle(fontSize: 13, color: c.ink70)),
                  ),
                  TextButton(onPressed: _load, child: const Text('Retry')),
                ],
              ),
            )
          else if (trips == null)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 28),
              child: Center(child: CircularProgressIndicator()),
            )
          else if (trips.isEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
              child: Text(
                'No trips yet. Start one from Trips, then add this to it.',
                style: TextStyle(fontSize: 13, color: c.ink70),
              ),
            )
          else
            Flexible(
              child: ListView(
                shrinkWrap: true,
                padding: const EdgeInsets.only(bottom: 16),
                children: [
                  for (final trip in trips)
                    ListTile(
                      onTap: () => Navigator.of(context).pop(trip),
                      contentPadding: const EdgeInsets.symmetric(horizontal: 16),
                      leading: Icon(Icons.luggage_outlined, color: trip.isActive ? c.brandDark : c.muted),
                      title: Row(
                        children: [
                          Flexible(
                            child: Text(
                              trip.name,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: c.ink),
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
                      subtitle: Text(
                        '${_dates(trip)} · ${formatMoneyShort(trip.totalMinor)}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 12, color: c.muted),
                      ),
                      trailing: Icon(Icons.chevron_right, size: 18, color: c.mutedLight),
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
