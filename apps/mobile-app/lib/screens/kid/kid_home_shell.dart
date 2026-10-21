import 'package:flutter/material.dart';
import '../../services/api_client.dart';
import '../../widgets/ds/ds.dart';
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
            const DsLogoMark(size: 28),
            const SizedBox(width: 10),
            Text(_titles[_index]),
          ],
        ),
        actions: [
          if (_index < 2)
            IconButton(
              tooltip: 'Check for new transactions',
              icon: DsIcon(DsIcons.refresh, color: c.tx2),
              onPressed: _refresh,
            ),
          const SizedBox(width: 4),
        ],
      ),
      body: IndexedStack(
        index: _index,
        children: [
          KidMoneyScreen(key: _money),
          KidAnalyticsScreen(key: _analytics),
          KidSettingsScreen(onSignedOut: _toLogin),
        ],
      ),
      // sf with a top ln hairline; the selected tab is ac on an acSoft pill.
      bottomNavigationBar: DecoratedBox(
        decoration: BoxDecoration(border: Border(top: BorderSide(color: c.ln))),
        child: NavigationBar(
          selectedIndex: _index,
          onDestinationSelected: (i) {
            setState(() => _index = i);
            // Analytics is cheap to reload, and an add on Money changes it.
            if (i == 1) _analytics.currentState?.load();
          },
          destinations: const [
            NavigationDestination(icon: DsIcon(DsIcons.piggyBank), label: 'Money'),
            NavigationDestination(icon: DsIcon(DsIcons.barChart), label: 'Analytics'),
            NavigationDestination(icon: DsIcon(DsIcons.sliders), label: 'Settings'),
          ],
        ),
      ),
    );
  }
}
