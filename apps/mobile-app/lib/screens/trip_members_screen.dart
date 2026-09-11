import 'package:flutter/material.dart';
import 'package:qr_flutter/qr_flutter.dart';
import '../services/api_client.dart';
import '../theme.dart';
import '../widgets/state_block.dart';

/// Who is on a trip, and how to get someone else onto it.
///
/// The code is shown large enough to read across a table and as a QR for
/// the other phone to scan. It carries the code and nothing else: no link,
/// no deep link handling, and nothing that works outside the app.
class TripMembersScreen extends StatefulWidget {
  final String tripId;
  final String tripName;

  const TripMembersScreen({super.key, required this.tripId, required this.tripName});

  @override
  State<TripMembersScreen> createState() => _TripMembersScreenState();
}

class _TripMembersScreenState extends State<TripMembersScreen> {
  Map<String, dynamic>? _trip;
  bool _error = false;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final result = await ApiClient.instance.get('/trips/${widget.tripId}') as Map<String, dynamic>;
      if (!mounted) return;
      setState(() {
        _trip = result;
        _error = false;
      });
    } catch (_) {
      if (mounted) setState(() => _error = true);
    }
  }

  Future<void> _run(Future<void> Function() action, String done) async {
    setState(() => _busy = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      await action();
      await _load();
      messenger.showSnackBar(SnackBar(content: Text(done)));
    } catch (e) {
      messenger.showSnackBar(
        SnackBar(content: Text(e is ApiException ? e.message : "That didn't work.")),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final members = (_trip?['members'] as List<dynamic>? ?? []).cast<Map<String, dynamic>>();
    final joinCode = _trip?['joinCode'] as String? ?? '';

    return Scaffold(
      backgroundColor: c.paper,
      appBar: AppBar(
        title: Text(
          widget.tripName,
          style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18, color: c.ink),
        ),
        shape: Border(bottom: BorderSide(color: c.line)),
      ),
      body: _error
          ? StateBlock(
              icon: Icons.wifi_off,
              warn: true,
              title: "Couldn't load the trip",
              body: 'The connection failed. Check your internet and try again.',
              actionLabel: 'Retry',
              onAction: _load,
            )
          : _trip == null
              ? const Center(child: CircularProgressIndicator())
              : ListView(
                  padding: const EdgeInsets.fromLTRB(16, 16, 16, 28),
                  children: [
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(20),
                      decoration: BoxDecoration(
                        color: c.surface,
                        border: Border.all(color: c.line),
                        borderRadius: BorderRadius.circular(T.rMd),
                      ),
                      child: Column(
                        children: [
                          Text(
                            'SHOW THIS TO ADD SOMEONE',
                            style: TextStyle(
                              fontSize: 10.5,
                              fontWeight: FontWeight.w700,
                              letterSpacing: 0.5,
                              color: c.muted,
                            ),
                          ),
                          const SizedBox(height: 16),
                          // White behind it whatever the theme: a QR has to
                          // stay readable to another phone's camera.
                          Container(
                            padding: const EdgeInsets.all(12),
                            decoration: BoxDecoration(
                              color: Colors.white,
                              borderRadius: BorderRadius.circular(T.rSm),
                            ),
                            child: QrImageView(
                              data: joinCode,
                              size: 180,
                              backgroundColor: Colors.white,
                              // No point drawing something unscannable.
                              errorStateBuilder: (context, _) => const SizedBox(
                                width: 180,
                                height: 180,
                                child: Center(child: Text('Could not draw the code')),
                              ),
                            ),
                          ),
                          const SizedBox(height: 16),
                          SelectableText(
                            joinCode,
                            style: kNum.copyWith(
                              fontSize: 26,
                              fontWeight: FontWeight.w800,
                              letterSpacing: 4,
                              color: c.ink,
                            ),
                          ),
                          const SizedBox(height: 6),
                          Text(
                            'They can scan this, or type the code in themselves.',
                            textAlign: TextAlign.center,
                            style: TextStyle(fontSize: 12, color: c.muted),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 10),
                    Align(
                      alignment: Alignment.centerRight,
                      child: TextButton.icon(
                        onPressed: _busy
                            ? null
                            : () => _run(
                                  () => ApiClient.instance
                                      .post('/trips/${widget.tripId}/rotate-code')
                                      .then((_) {}),
                                  'New code. The old one no longer works.',
                                ),
                        icon: const Icon(Icons.refresh, size: 16),
                        label: const Text('New code'),
                      ),
                    ),
                    const SizedBox(height: 12),
                    Text(
                      'ON THIS TRIP',
                      style: TextStyle(
                        fontSize: 10.5,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 0.5,
                        color: c.muted,
                      ),
                    ),
                    const SizedBox(height: 10),
                    for (final member in members)
                      Container(
                        margin: const EdgeInsets.only(bottom: 8),
                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                        decoration: BoxDecoration(
                          color: c.surface,
                          border: Border.all(color: c.line),
                          borderRadius: BorderRadius.circular(T.rMd),
                        ),
                        child: Row(
                          children: [
                            Expanded(
                              child: Text(
                                member['name'] as String? ?? 'Someone',
                                style: TextStyle(
                                  fontSize: 13.8,
                                  fontWeight: FontWeight.w700,
                                  color: c.ink,
                                ),
                              ),
                            ),
                            if (member['isOwner'] == true)
                              Text(
                                'Started it',
                                style: TextStyle(fontSize: 11.5, color: c.muted),
                              )
                            else
                              TextButton(
                                onPressed: _busy
                                    ? null
                                    : () => _run(
                                          () => ApiClient.instance.delete(
                                            '/trips/${widget.tripId}/members/${member['userId']}',
                                          ),
                                          'Removed. What they spent stays on the trip.',
                                        ),
                                style: TextButton.styleFrom(foregroundColor: c.debit),
                                child: const Text('Remove'),
                              ),
                          ],
                        ),
                      ),
                    const SizedBox(height: 8),
                    Text(
                      'Everyone here sees what was spent on this trip, and nothing else of yours. '
                      'Someone who joins shares from that moment on — what they spent before stays '
                      'theirs unless they add it.',
                      style: TextStyle(fontSize: 11.8, height: 1.5, color: c.mutedLight),
                    ),
                  ],
                ),
    );
  }
}
