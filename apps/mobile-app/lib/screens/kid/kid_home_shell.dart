import 'package:flutter/material.dart';
import '../../services/api_client.dart';
import '../../theme.dart';
import '../login_screen.dart';
import 'kid_analytics_screen.dart';
import 'kid_money_screen.dart';
import 'kid_settings_screen.dart';

/// The whole app for a kid's login: their pocket money, its analytics and
/// a small settings page. Nothing here starts SMS, Gmail, reminders or
/// notifications - those belong to the owner's phone.
class KidHomeShell extends StatefulWidget {
  const KidHomeShell({super.key});

  @override
  State<KidHomeShell> createState() => _KidHomeShellState();
}

class _KidHomeShellState extends State<KidHomeShell> {
  int _index = 0;

  static const _titles = ['Money', 'Analytics', 'Settings'];

  final _money = GlobalKey<KidMoneyScreenState>();
  final _analytics = GlobalKey<KidAnalyticsScreenState>();

  @override
  void initState() {
    super.initState();
    // The parent can reset the password or remove the login at any time;
    // the next refused request brings the kid back to sign-in.
    ApiClient.onKidSessionEnded = () => _toLogin('Signed out — sign in again.');
  }

  @override
  void dispose() {
    ApiClient.onKidSessionEnded = null;
    super.dispose();
  }

  void _toLogin([String? notice]) {
    if (!mounted) return;
    Navigator.of(context, rootNavigator: true).pushAndRemoveUntil(
      MaterialPageRoute(builder: (_) => LoginScreen(notice: notice)),
      (_) => false,
    );
  }

  /// Wakes the parent's phone (via Money's refresh) and reloads both tabs.
  Future<void> _refresh() async {
    await _money.currentState?.refresh();
    await _analytics.currentState?.load();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    return Scaffold(
      appBar: AppBar(
        title: Row(
          children: [
            ClipRRect(
              borderRadius: BorderRadius.circular(7),
              child: Image.asset('assets/app_icon.png', width: 26, height: 26),
            ),
            const SizedBox(width: 10),
            Text(_titles[_index], style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18, color: c.ink)),
          ],
        ),
        actions: [
          if (_index < 2)
            IconButton(
              tooltip: 'Check for new transactions',
              icon: Icon(Icons.refresh, color: c.ink70),
              onPressed: _refresh,
            ),
        ],
        shape: Border(bottom: BorderSide(color: c.line)),
      ),
      body: IndexedStack(
        index: _index,
        children: [
          KidMoneyScreen(key: _money),
          KidAnalyticsScreen(key: _analytics),
          KidSettingsScreen(onSignedOut: _toLogin),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) {
          setState(() => _index = i);
          // Analytics is cheap to reload, and an add on Money changes it.
          if (i == 1) _analytics.currentState?.load();
        },
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.account_balance_wallet_outlined),
            selectedIcon: Icon(Icons.account_balance_wallet),
            label: 'Money',
          ),
          NavigationDestination(
            icon: Icon(Icons.insights_outlined),
            selectedIcon: Icon(Icons.insights),
            label: 'Analytics',
          ),
          NavigationDestination(
            icon: Icon(Icons.settings_outlined),
            selectedIcon: Icon(Icons.settings),
            label: 'Settings',
          ),
        ],
      ),
    );
  }
}
