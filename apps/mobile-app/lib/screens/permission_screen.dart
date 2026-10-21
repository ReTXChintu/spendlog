import 'package:flutter/material.dart';
import '../services/sms_service.dart';
import '../widgets/ds/ds.dart';

/// Shown before Android's own SMS permission dialog.
///
/// Reading someone's text messages is an alarming thing to ask for, and the
/// system dialog gives no context. A denial is effectively permanent — most
/// people never revisit it — so the explanation has to come first.
class PermissionScreen extends StatelessWidget {
  const PermissionScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Scaffold(
      appBar: AppBar(title: const Text('SMS access')),
      body: ListView(
        padding: kPagePad,
        children: [
          // The onboarding step card (§6.2): one question, said plainly.
          DsCard(
            padding: const EdgeInsets.all(20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const DsIconTile(DsIcons.message, tone: DsTone.ac),
                const SizedBox(height: 16),
                Text(
                  'Before we ask for SMS access',
                  style: TextStyle(fontSize: 22, height: 28 / 22, fontWeight: FontWeight.w600, color: c.tx),
                ),
                const SizedBox(height: 8),
                Text(
                  "Android's next screen won't explain this, so here's exactly what happens.",
                  style: TextStyle(fontSize: 15, height: 22 / 15, color: c.tx2),
                ),
                const SizedBox(height: 20),
                const _Point(
                  icon: DsIcons.eye,
                  tone: DsTone.ac,
                  title: 'What we read',
                  body: 'Incoming messages from banks and UPI apps, plus a one-time scan of existing messages so '
                      "nothing's missed.",
                ),
                const _Point(
                  icon: DsIcons.eyeOff,
                  tone: DsTone.neutral,
                  title: 'What we never read',
                  body: 'Messages from people you know, OTPs, or anything that isn\'t a transaction alert — those '
                      'are discarded immediately.',
                ),
                const _Point(
                  icon: DsIcons.list,
                  tone: DsTone.good,
                  title: 'What you get',
                  body: 'Each message becomes one line in your ledger — amount, merchant, account. Nothing else '
                      'leaves the message.',
                  last: true,
                ),
                const SizedBox(height: 20),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    style: FilledButton.styleFrom(minimumSize: const Size(64, 52)),
                    onPressed: () async {
                      final granted = await SmsService.instance.requestPermissions();
                      if (granted) {
                        SmsService.instance.startListening();
                        SmsService.instance.runBackfillIfNeeded();
                      }
                      if (context.mounted) Navigator.of(context).pop(granted);
                    },
                    child: const Text('Continue'),
                  ),
                ),
                const SizedBox(height: 8),
                SizedBox(
                  width: double.infinity,
                  child: TextButton(
                    onPressed: () => Navigator.of(context).pop(false),
                    style: TextButton.styleFrom(foregroundColor: c.tx2, minimumSize: const Size(64, 48)),
                    child: const Text('Not now'),
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

/// A benefit row: a 36 icon tile, a 15/20 title and a 13/18 line.
class _Point extends StatelessWidget {
  final DsGlyph icon;
  final DsTone tone;
  final String title;
  final String body;
  final bool last;

  const _Point({
    required this.icon,
    required this.tone,
    required this.title,
    required this.body,
    this.last = false,
  });

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Padding(
      padding: EdgeInsets.only(bottom: last ? 0 : 16),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          DsIconTile(icon, tone: tone, size: 36),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
                ),
                const SizedBox(height: 2),
                Text(body, style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
