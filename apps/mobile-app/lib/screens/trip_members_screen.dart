import 'package:flutter/material.dart';
import 'package:qr_flutter/qr_flutter.dart';
import '../services/api_client.dart';
import '../widgets/ds/ds.dart';
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
      backgroundColor: c.bg,
      appBar: AppBar(
        title: Text(widget.tripName, maxLines: 1, overflow: TextOverflow.ellipsis),
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
              ? const Center(child: DsSpinner())
              : ListView(
                  padding: kPagePad,
                  children: [
                    DsCard(
                      padding: const EdgeInsets.all(20),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          const DsSectionHeader('Show this to add someone'),
                          const SizedBox(height: 16),
                          Center(
                            // White behind it whatever the theme: a QR has to
                            // stay readable to another phone's camera.
                            child: Container(
                              padding: const EdgeInsets.all(12),
                              decoration: BoxDecoration(
                                color: Colors.white,
                                border: Border.all(color: c.ln),
                                borderRadius: BorderRadius.circular(Ds.rLg),
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
                          ),
                          const SizedBox(height: 16),
                          const DsLabel('Join code', padding: EdgeInsets.only(bottom: 6)),
                          // The code reads as a machine string: Plex Mono on a
                          // read-only field.
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                            decoration: BoxDecoration(
                              color: c.sf2,
                              border: Border.all(color: c.ln2),
                              borderRadius: BorderRadius.circular(Ds.rMd),
                            ),
                            child: Center(
                              child: SelectableText(
                                joinCode,
                                style: kMono.copyWith(
                                  fontSize: 26,
                                  height: 32 / 26,
                                  fontWeight: FontWeight.w500,
                                  letterSpacing: 26 * 0.12,
                                  color: c.tx,
                                ),
                              ),
                            ),
                          ),
                          const SizedBox(height: 8),
                          Text(
                            'They can scan this, or type the code in themselves.',
                            style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
                          ),
                          const SizedBox(height: 4),
                          Align(
                            alignment: Alignment.centerLeft,
                            child: TextButton.icon(
                              style: TextButton.styleFrom(padding: EdgeInsets.zero),
                              onPressed: _busy
                                  ? null
                                  : () => _run(
                                        () => ApiClient.instance
                                            .post('/trips/${widget.tripId}/rotate-code')
                                            .then((_) {}),
                                        'New code. The old one no longer works.',
                                      ),
                              icon: const DsIcon(DsIcons.refresh, size: 18),
                              label: const Text('New code'),
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: kCardGap),
                    DsCard(
                      padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          DsSectionHeader(
                            'On this trip',
                            trailing: _AvatarStack(
                              names: [for (final m in members) m['name'] as String? ?? 'Someone'],
                            ),
                          ),
                          const SizedBox(height: 4),
                          for (var i = 0; i < members.length; i++)
                            Container(
                              constraints: const BoxConstraints(minHeight: 56),
                              padding: const EdgeInsets.symmetric(vertical: 8),
                              decoration: BoxDecoration(
                                border: i == members.length - 1 ? null : Border(bottom: BorderSide(color: c.ln)),
                              ),
                              child: Row(
                                children: [
                                  DsAvatar(members[i]['name'] as String? ?? 'Someone', tone: _toneFor(i)),
                                  const SizedBox(width: 12),
                                  Expanded(
                                    child: Text(
                                      members[i]['name'] as String? ?? 'Someone',
                                      style: TextStyle(
                                        fontSize: 15,
                                        height: 20 / 15,
                                        fontWeight: FontWeight.w500,
                                        color: c.tx,
                                      ),
                                    ),
                                  ),
                                  if (members[i]['isOwner'] == true)
                                    const DsBadge('Started it')
                                  else
                                    TextButton(
                                      onPressed: _busy
                                          ? null
                                          : () => _run(
                                                () => ApiClient.instance.delete(
                                                  '/trips/${widget.tripId}/members/${members[i]['userId']}',
                                                ),
                                                'Removed. What they spent stays on the trip.',
                                              ),
                                      style: TextButton.styleFrom(foregroundColor: c.crit),
                                      child: const Text('Remove'),
                                    ),
                                ],
                              ),
                            ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 12),
                    Text(
                      'Everyone here sees what was spent on this trip, and nothing else of yours. '
                      'Someone who joins shares from that moment on — what they spent before stays '
                      'theirs unless they add it.',
                      style: TextStyle(fontSize: 12, height: 17 / 12, color: c.tx3),
                    ),
                  ],
                ),
    );
  }
}

DsTone _toneFor(int i) => const [DsTone.ac, DsTone.good, DsTone.warn, DsTone.neutral][i % 4];

/// Overlapping avatars, each ringed in the page colour.
class _AvatarStack extends StatelessWidget {
  final List<String> names;

  const _AvatarStack({required this.names});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final shown = names.take(4).toList();
    if (shown.isEmpty) return const SizedBox.shrink();
    const size = 28.0;
    return SizedBox(
      height: size + 4,
      width: (size + 4) + (shown.length - 1) * (size + 4 - 8),
      child: Stack(
        children: [
          for (var i = 0; i < shown.length; i++)
            Positioned(
              left: i * (size + 4 - 8),
              child: Container(
                padding: const EdgeInsets.all(2),
                decoration: BoxDecoration(color: c.sf, shape: BoxShape.circle),
                child: DsAvatar(shown[i], size: size, tone: _toneFor(i)),
              ),
            ),
        ],
      ),
    );
  }
}
