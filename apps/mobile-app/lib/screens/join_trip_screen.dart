import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import '../services/api_client.dart';
import '../theme.dart';

/// Joins a trip by scanning the owner's code, or typing it.
///
/// The camera is the quick path and the text field is the one that always
/// works — a code read out over the phone, or a camera someone would
/// rather not turn on.
class JoinTripScreen extends StatefulWidget {
  const JoinTripScreen({super.key});

  @override
  State<JoinTripScreen> createState() => _JoinTripScreenState();
}

class _JoinTripScreenState extends State<JoinTripScreen> {
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
      final result = await ApiClient.instance.post('/trips/join', {'code': trimmed})
          as Map<String, dynamic>;
      navigator.pop(result['name'] as String? ?? 'the trip');
    } catch (e) {
      setState(() {
        _error = e is ApiException ? e.message : "Couldn't join that trip.";
        _joining = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    return Scaffold(
      backgroundColor: c.paper,
      appBar: AppBar(
        title: Text(
          'Join a trip',
          style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18, color: c.ink),
        ),
        shape: Border(bottom: BorderSide(color: c.line)),
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 28),
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(T.rMd),
            child: SizedBox(
              height: 280,
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
                      color: c.chipNeutral,
                      padding: const EdgeInsets.all(20),
                      alignment: Alignment.center,
                      child: Text(
                        'The camera is not available. Type the code instead.',
                        textAlign: TextAlign.center,
                        style: TextStyle(fontSize: 12.5, color: c.muted),
                      ),
                    ),
                  ),
                  if (_joining)
                    Container(
                      color: Colors.black54,
                      alignment: Alignment.center,
                      child: const CircularProgressIndicator(),
                    ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 10),
          Text(
            'Point it at the code on their phone.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12, color: c.muted),
          ),
          const SizedBox(height: 22),
          Text(
            'OR TYPE IT',
            style: TextStyle(
              fontSize: 10.5,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.5,
              color: c.muted,
            ),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _controller,
                  autocorrect: false,
                  textCapitalization: TextCapitalization.characters,
                  style: kNum.copyWith(fontSize: 18, letterSpacing: 3, color: c.ink),
                  decoration: InputDecoration(
                    hintText: 'ABC123',
                    hintStyle: TextStyle(color: c.mutedLight, letterSpacing: 3),
                    isDense: true,
                    filled: true,
                    fillColor: c.surface,
                    contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
                    enabledBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(T.rSm),
                      borderSide: BorderSide(color: c.lineStrong),
                    ),
                    focusedBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(T.rSm),
                      borderSide: BorderSide(color: c.brand),
                    ),
                  ),
                  onSubmitted: _join,
                ),
              ),
              const SizedBox(width: 10),
              FilledButton(
                onPressed: _joining ? null : () => _join(_controller.text),
                child: const Text('Join'),
              ),
            ],
          ),
          if (_error != null) ...[
            const SizedBox(height: 14),
            Text(_error!, style: TextStyle(fontSize: 12.5, color: c.debit)),
          ],
          const SizedBox(height: 18),
          Text(
            'Joining shares this trip from now on. What you spent before it stays yours — you can '
            'add those payments afterwards if you want them counted.',
            style: TextStyle(fontSize: 11.8, height: 1.5, color: c.mutedLight),
          ),
        ],
      ),
    );
  }
}
