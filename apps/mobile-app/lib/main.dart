import 'package:flutter/material.dart';
import 'screens/home_shell.dart';
import 'screens/login_screen.dart';
import 'services/api_client.dart';

void main() {
  runApp(const SpendLogApp());
}

class SpendLogApp extends StatelessWidget {
  const SpendLogApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'SpendLog',
      // Seeded from the brand blue in the SpendLog logo.
      theme: ThemeData(colorSchemeSeed: const Color(0xFF3D6BF5), useMaterial3: true),
      home: const _StartupGate(),
    );
  }
}

class _StartupGate extends StatelessWidget {
  const _StartupGate();

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<String?>(
      future: ApiClient.getToken(),
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Scaffold(body: Center(child: CircularProgressIndicator()));
        }
        return snapshot.data != null ? const HomeShell() : const LoginScreen();
      },
    );
  }
}
