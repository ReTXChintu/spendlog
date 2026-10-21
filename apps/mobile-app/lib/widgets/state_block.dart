import 'package:flutter/material.dart';
import 'ds/ds.dart';

/// The full-page empty/error state (§7.11, proposed): a 48 icon tile, a
/// plain title, one sentence of explanation and at most one action. One of
/// the few centred elements in the system.
class StateBlock extends StatelessWidget {
  /// A [DsGlyph] or a Material [IconData].
  final Object icon;
  final String title;
  final String body;
  final String? actionLabel;
  final VoidCallback? onAction;
  final bool warn;

  const StateBlock({
    super.key,
    required this.icon,
    required this.title,
    required this.body,
    this.actionLabel,
    this.onAction,
    this.warn = false,
  });

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            DsIconTile(
              icon,
              tone: warn ? DsTone.warn : DsTone.neutral,
              color: warn ? null : c.tx3,
              size: 48,
              iconSize: 24,
            ),
            const SizedBox(height: 16),
            Text(
              title,
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 17, height: 24 / 17, fontWeight: FontWeight.w600, color: c.tx),
            ),
            const SizedBox(height: 6),
            Text(
              body,
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 15, height: 22 / 15, color: c.tx2),
            ),
            if (actionLabel != null) ...[
              const SizedBox(height: 20),
              FilledButton(onPressed: onAction, child: Text(actionLabel!)),
            ],
          ],
        ),
      ),
    );
  }
}
