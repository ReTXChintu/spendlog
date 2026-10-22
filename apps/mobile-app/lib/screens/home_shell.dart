import 'dart:io' show Platform;
import 'package:flutter/material.dart';
import '../services/api_client.dart';
import '../services/push_service.dart';
import '../services/sms_service.dart';
import '../widgets/ds/ds.dart';
import 'ask_screen.dart';
import 'dashboard_screen.dart';
import 'home_screen.dart';
import 'ipos_screen.dart';
import 'settings_screen.dart';
import 'transactions_screen.dart';
import 'groups_screen.dart';

class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _index = 0;

  // Analytics is a tab inside Home now, beside the Dashboard.
  static const _titles = ['Home', 'Transactions', 'Groups', 'Settings'];
  static const _settingsIndex = 3;

  // The dashboard reloads when you come back to it, since half of what
  // it shows is a count of jobs the other tabs are where you do.
  final _dashboard = GlobalKey<DashboardScreenState>();

  // So the Ask screen can send somebody straight to the assistant's card.
  final _settings = GlobalKey<SettingsScreenState>();

  // Whether the server can show IPOs (it has an IPO Guru key). Asked once
  // per start; until it says yes, the button stays hidden.
  bool _iposAvailable = false;

  @override
  void initState() {
    super.initState();
    _resumeSmsCapture();
    // Here rather than at sign-in: this screen opens for the owner both on
    // launch and right after signing in, and never for a kid.
    PushService.instance.registerIfOwner();
    _checkIpos();
  }

  /// One call, and the server answers it from its cache. Any failure leaves
  /// the button hidden until the next start.
  Future<void> _checkIpos() async {
    // A kid never reaches this shell, and the server refuses a kid's token
    // here anyway; this just makes sure a kid's phone never asks.
    if (await ApiClient.isKidSession()) return;
    try {
      final json = await ApiClient.instance.get('/ipos');
      final available = json is Map && json['available'] == true;
      if (available && mounted) setState(() => _iposAvailable = true);
    } catch (_) {
      // Hidden it stays.
    }
  }

  Future<void> _openIpos() async {
    await Navigator.of(context).push(MaterialPageRoute(builder: (_) => const IposScreen()));
  }

  /// The plugin only delivers a foreground SMS to a channel registered in
  /// the running process, and that registration does not survive a restart.
  /// Without this, a message arriving while the app was open was dropped —
  /// and since the backfill runs only once, nothing went back for it.
  Future<void> _resumeSmsCapture() async {
    if (!Platform.isAndroid) return;
    if (await SmsService.instance.hasPermission()) {
      SmsService.instance.startListening();
    }
  }

  /// The assistant, pushed over the tabs rather than made a sixth one: it
  /// is something you go to with a question, not somewhere you check.
  Future<void> _openAsk() async {
    await Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => AskScreen(
          onOpenSettings: _openAssistantSettings,
        ),
      ),
    );
  }

  /// Settings, at the assistant's card: where a Gemini key is added.
  void _openAssistantSettings() {
    setState(() => _index = _settingsIndex);
    _settings.currentState?.showAssistant();
  }

  @override
  Widget build(BuildContext context) {
    final screens = [
      HomeScreen(
        dashboardKey: _dashboard,
        onOpenTransactions: () => setState(() => _index = 1),
        onOpenSettings: () => setState(() => _index = _settingsIndex),
        onOpenAiSettings: _openAssistantSettings,
      ),
      TransactionsScreen(onOpenSettings: () => setState(() => _index = _settingsIndex)),
      const GroupsScreen(),
      SettingsScreen(key: _settings),
    ];

    final c = context.c;
    return Scaffold(
      appBar: AppBar(
        title: Row(
          children: [
            const DsLogoMark(size: 28),
            const SizedBox(width: 12),
            Flexible(
              child: Text(
                _titles[_index],
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 22, height: 28 / 22, fontWeight: FontWeight.w600, color: c.tx),
              ),
            ),
          ],
        ),
        actions: [
          if (_index == 0 && _iposAvailable)
            IconButton(
              tooltip: 'IPOs',
              onPressed: _openIpos,
              icon: DsIcon(DsIcons.trendingUp, size: 22, color: c.tx2),
            ),
          if (_index == 0)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: TextButton.icon(
                onPressed: _openAsk,
                icon: DsIcon(DsIcons.sparkles, size: 18, color: c.ac),
                label: Text(
                  'Ask AI',
                  style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: c.ac),
                ),
              ),
            ),
        ],
        shape: Border(bottom: BorderSide(color: c.ln)),
      ),
      body: IndexedStack(index: _index, children: screens),
      bottomNavigationBar: DecoratedBox(
        // The bar sits on the surface with a hairline above it (§6.3).
        decoration: BoxDecoration(border: Border(top: BorderSide(color: c.ln))),
        child: NavigationBar(
          selectedIndex: _index,
          onDestinationSelected: (i) {
            setState(() => _index = i);
            if (i == 0) _dashboard.currentState?.load();
          },
          destinations: const [
            NavigationDestination(icon: DsIcon(DsIcons.home), label: 'Home'),
            NavigationDestination(icon: DsIcon(DsIcons.list), label: 'Transactions'),
            NavigationDestination(icon: DsIcon(DsIcons.users), label: 'Groups'),
            NavigationDestination(icon: DsIcon(DsIcons.sliders), label: 'Settings'),
          ],
        ),
      ),
    );
  }
}
