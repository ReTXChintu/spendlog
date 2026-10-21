import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// What to show where a widget threw while building.
///
/// Flutter replaces a widget that throws with an ErrorWidget. In a debug
/// build that is the red screen; in a release build it is a plain grey
/// box, which is why a broken panel read as "the screen goes blank" —
/// there was nothing on it to report and no way to tell a crash from an
/// empty page.
///
/// This says what broke and offers to copy it, which is the difference
/// between a bug that can be reported and one that can only be described.
/// Installed in main() so it covers every screen rather than the one that
/// happened to break first.
class CrashCard extends StatelessWidget {
  const CrashCard(this.details, {super.key});

  final FlutterErrorDetails details;

  @override
  Widget build(BuildContext context) {
    // Deliberately not using the app's own theme extension. Whatever broke
    // may be the theme, and a fallback that needs the thing it is
    // reporting on is no fallback at all.
    final scheme = Theme.of(context).colorScheme;
    final message = details.exceptionAsString();

    return Material(
      color: scheme.surface,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.error_outline, size: 20, color: scheme.error),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    'This part stopped working',
                    style: TextStyle(
                      fontSize: 15,
                      height: 20 / 15,
                      fontWeight: FontWeight.w600,
                      color: scheme.onSurface,
                    ),
                  ),
                ),
                IconButton(
                  tooltip: 'Copy the error',
                  icon: const Icon(Icons.copy_outlined, size: 18),
                  onPressed: () => Clipboard.setData(ClipboardData(text: message)),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              'Nothing has been changed or lost — it is the screen that broke, not your data.',
              style: TextStyle(fontSize: 13, height: 18 / 13, color: scheme.onSurfaceVariant),
            ),
            const SizedBox(height: 12),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: scheme.errorContainer,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Text(
                message,
                style: TextStyle(
                  fontSize: 12,
                  height: 18 / 12,
                  fontFamily: 'IBM Plex Mono',
                  fontFamilyFallback: const ['monospace'],
                  color: scheme.onSurface,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
