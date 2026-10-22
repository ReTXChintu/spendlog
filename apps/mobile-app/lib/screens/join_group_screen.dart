import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import '../services/api_client.dart';
import '../widgets/ds/ds.dart';

/// Joins a group by scanning the owner's code, or typing it.
///
/// The camera is the quick path and the text field is the one that always
/// works — a code read out over the phone, or a camera someone would
/// rather not turn on.
class JoinGroupScreen extends StatefulWidget {
  const JoinGroupScreen({super.key});

  @override
  State<JoinGroupScreen> createState() => _JoinGroupScreenState();
}

class _JoinGroupScreenState extends State<JoinGroupScreen> {
  final _controller = TextEditingController();
  final _scanner = MobileScannerController(detectionSpeed: DetectionSpeed.noDuplicates);

  bool _joining = false;
  String? _error;

  @override
  void dispose() {
    _controller.dispose();
    _scanner.dispose();
    super.dispose();
  }

  Future<void> _join(String code) async {
    final trimmed = code.trim();
    if (trimmed.isEmpty || _joining) return;

    setState(() {
      _joining = true;
      _error = null;
    });

    final navigator = Navigator.of(context);
    try {
      final result = await ApiClient.instance.post('/groups/join', {'code': trimmed})
          as Map<String, dynamic>;
      navigator.pop(result['name'] as String? ?? 'the group');
    } catch (e) {
      setState(() {
        _error = e is ApiException ? e.message : "Couldn't join that group.";
        _joining = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: const Text('Join a group')),
      body: ListView(
        padding: kPagePad,
        children: [
          Container(
            height: 280,
            decoration: BoxDecoration(
              border: Border.all(color: c.ln),
              borderRadius: BorderRadius.circular(Ds.rXl),
            ),
            clipBehavior: Clip.antiAlias,
            child: Stack(
              fit: StackFit.expand,
              children: [
                MobileScanner(
                  controller: _scanner,
                  onDetect: (capture) {
                    final code = capture.barcodes.firstOrNull?.rawValue;
                    if (code != null) _join(code);
                  },
                  errorBuilder: (context, error) => Container(
                    color: c.sunk,
                    padding: const EdgeInsets.all(20),
                    alignment: Alignment.center,
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const DsIconTile(DsIcons.alertTriangle, tone: DsTone.neutral, onTinted: true),
                        const SizedBox(height: 8),
                        Text(
                          'The camera is not available. Type the code instead.',
                          textAlign: TextAlign.center,
                          style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2),
                        ),
                      ],
                    ),
                  ),
                ),
                if (_joining)
                  Container(
                    color: c.scrim,
                    alignment: Alignment.center,
                    child: const DsSpinner(),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 8),
          Text(
            'Point it at the code on their phone.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
          ),
          const SizedBox(height: 24),
          const DsLabel('Or type it', padding: EdgeInsets.only(bottom: 6)),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: TextField(
                  controller: _controller,
                  autocorrect: false,
                  textCapitalization: TextCapitalization.characters,
                  // A join code is a machine string: Plex Mono, wide tracking.
                  style: kMono.copyWith(fontSize: 18, letterSpacing: 18 * 0.12, color: c.tx),
                  decoration: InputDecoration(
                    hintText: 'ABC123',
                    hintStyle: kMono.copyWith(fontSize: 18, letterSpacing: 18 * 0.12, color: c.tx3),
                    errorText: _error == null ? null : '',
                    errorStyle: const TextStyle(height: 0, fontSize: 0),
                  ),
                  onSubmitted: _join,
                ),
              ),
              const SizedBox(width: 8),
              SizedBox(
                height: 54,
                child: FilledButton(
                  onPressed: _joining ? null : () => _join(_controller.text),
                  child: const Text('Join'),
                ),
              ),
            ],
          ),
          if (_error != null) ...[
            const SizedBox(height: 12),
            DsCallout(title: _error!, tone: DsTone.crit),
          ],
          const SizedBox(height: 16),
          Text(
            'Joining lets you see and add to this group. Nothing of yours goes in by itself - you '
            'choose which payments to put in it.',
            style: TextStyle(fontSize: 12, height: 17 / 12, color: c.tx3),
          ),
        ],
      ),
    );
  }
}
