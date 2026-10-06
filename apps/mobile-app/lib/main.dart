import 'package:flutter/material.dart';
import 'screens/start_screen.dart';
import 'services/perk_import_watcher.dart';
import 'services/reminder_service.dart';
import 'services/theme_service.dart';
import 'services/update_service.dart';
import 'theme.dart';
import 'widgets/crash_card.dart';
import 'version.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();

  // A widget that throws while building is replaced by an ErrorWidget. In
  // a release build the stock one is a plain grey box with nothing on it,
  // which is why a broken panel reads as "the screen goes blank" - no
  // message, and no way to tell a crash from an empty page. This puts the
  // error on screen where it can be read and copied.
  ErrorWidget.builder = (details) => CrashCard(details);
  // Loaded before the first frame so a dark-mode user never sees a light flash.
  ThemeService.instance.load();
  _ownerStartup();
  runApp(const SpendLogApp());
}

/// Start-up work that belongs to the owner's phone only. A kid's phone
/// must never schedule reminders or background tasks, so the role is
/// read first and a kid skips all of it.
Future<void> _ownerStartup() async {
  if (!runsOwnerStartup(await currentRole())) return;
  // Wired up on every launch, not only when a reminder is switched on: the
  // background task that checks yesterday needs a registered callback to
  // call back into, and it can fire long before anyone opens Settings.
  ReminderService.instance.init().catchError((_) {});
  // Routes the "coupons ready" tap, and keeps watching a screenshot import
  // that was still being read when the app was last closed.
  PerkImportWatcher.instance.resume().catchError((_) {});
}

class SpendLogApp extends StatelessWidget {
  const SpendLogApp({super.key});

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: ThemeService.instance,
      builder: (context, _) => MaterialApp(
        title: 'SpendLog',
        navigatorKey: appNavigatorKey,
        // Tokens from the approved design; see lib/theme.dart.
        theme: buildTheme(Brightness.light),
        darkTheme: buildTheme(Brightness.dark),
        themeMode: ThemeService.instance.mode,
        home: const _StartupGate(),
      ),
    );
  }
}

class _StartupGate extends StatefulWidget {
  const _StartupGate();

  @override
  State<_StartupGate> createState() => _StartupGateState();
}

class _StartupGateState extends State<_StartupGate> {
  late final Future<AppRole> _role = currentRole();

  @override
  void initState() {
    super.initState();
    // After the first frame, so a slow or unreachable server never delays
    // the app opening. A failed check just does nothing.
    WidgetsBinding.instance.addPostFrameCallback((_) => _checkForUpdate());
  }

  Future<void> _checkForUpdate() async {
    final latest = await UpdateService.instance.checkForUpdate();
    if (latest == null || !mounted) return;
    await _showUpdateDialog(context, latest);
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<AppRole>(
      future: _role,
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Scaffold(body: Center(child: CircularProgressIndicator()));
        }
        return startScreenFor(snapshot.data ?? AppRole.signedOut);
      },
    );
  }
}

/// The app is sideloaded, so nothing installs a new build on its own —
/// this is the only thing that tells someone they're out of date. It's
/// dismissible: an old build still works, it just may not match the server.
Future<void> _showUpdateDialog(BuildContext context, String latest) {
  return showDialog<void>(
    context: context,
    builder: (context) => AlertDialog(
      title: const Text('Update available'),
      content: Text(
        "You're on $appVersion and $latest is out. Downloading it opens the "
        'APK in your browser — install it over this one and your data stays '
        'where it is.',
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Not now'),
        ),
        FilledButton(
          onPressed: () {
            Navigator.of(context).pop();
            UpdateService.instance.openDownload();
          },
          child: const Text('Download'),
        ),
      ],
    ),
  );
}
