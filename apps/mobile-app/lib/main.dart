import 'package:flutter/material.dart';
import 'screens/home_shell.dart';
import 'screens/login_screen.dart';
import 'services/api_client.dart';
import 'services/theme_service.dart';
import 'services/update_service.dart';
import 'theme.dart';
import 'version.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  // Loaded before the first frame so a dark-mode user never sees a light flash.
  ThemeService.instance.load();
  runApp(const SpendLogApp());
}

class SpendLogApp extends StatelessWidget {
  const SpendLogApp({super.key});

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: ThemeService.instance,
      builder: (context, _) => MaterialApp(
        title: 'SpendLog',
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
  late final Future<String?> _token = ApiClient.getToken();

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
    return FutureBuilder<String?>(
      future: _token,
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Scaffold(body: Center(child: CircularProgressIndicator()));
        }
        return snapshot.data != null ? const HomeShell() : const LoginScreen();
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
