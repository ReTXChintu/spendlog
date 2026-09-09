import 'package:flutter/material.dart';
import '../services/sms_service.dart';
import '../theme.dart';

/// Shown before Android's own SMS permission dialog.
///
/// Reading someone's text messages is an alarming thing to ask for, and the
/// system dialog gives no context. A denial is effectively permanent — most
/// people never revisit it — so the explanation has to come first.
class PermissionScreen extends StatelessWidget {
  const PermissionScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('SMS access')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(24, 12, 24, 32),
        children: [
          Container(
            width: 52,
            height: 52,
            decoration: BoxDecoration(color: context.c.brand50, borderRadius: BorderRadius.circular(14)),
            child: Icon(Icons.sms_outlined, size: 26, color: context.c.brand),
          ),
          const SizedBox(height: 20),
          Text(
            'Before we ask for SMS access',
            style: TextStyle(fontSize: 21, fontWeight: FontWeight.w800, color: context.c.ink, height: 1.2),
          ),
          const SizedBox(height: 8),
          Text(
            "Android's next screen won't explain this, so here's exactly what happens.",
            style: TextStyle(fontSize: 13.8, color: context.c.ink70, height: 1.5),
          ),
          const SizedBox(height: 26),
          _Point(
            icon: Icons.visibility_outlined,
            tint: context.c.brand50,
            iconColor: context.c.brand,
            title: 'What we read',
            body: 'Incoming messages from banks and UPI apps, plus a one-time scan of existing messages so '
                "nothing's missed.",
          ),
          _Point(
            icon: Icons.visibility_off_outlined,
            tint: context.c.debit50,
            iconColor: context.c.debit,
            title: 'What we never read',
            body: 'Messages from people you know, OTPs, or anything that isn\'t a transaction alert — those '
                'are discarded immediately.',
          ),
          _Point(
            icon: Icons.receipt_long_outlined,
            tint: context.c.credit50,
            iconColor: context.c.credit,
            title: 'What you get',
            body: 'Each message becomes one line in your ledger — amount, merchant, account. Nothing else '
                'leaves the message.',
          ),
          const SizedBox(height: 12),
          FilledButton(
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
          const SizedBox(height: 8),
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            style: TextButton.styleFrom(foregroundColor: context.c.muted),
            child: const Text('Not now'),
          ),
        ],
      ),
    );
  }
}

class _Point extends StatelessWidget {
  final IconData icon;
  final Color tint;
  final Color iconColor;
  final String title;
  final String body;

  const _Point({
    required this.icon,
    required this.tint,
    required this.iconColor,
    required this.title,
    required this.body,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 20),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 34,
            height: 34,
            decoration: BoxDecoration(color: tint, borderRadius: BorderRadius.circular(9)),
            child: Icon(icon, size: 17, color: iconColor),
          ),
          const SizedBox(width: 13),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: context.c.ink)),
                const SizedBox(height: 3),
                Text(body, style: TextStyle(fontSize: 13, height: 1.5, color: context.c.ink70)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
