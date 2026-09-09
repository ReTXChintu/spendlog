import 'package:flutter/material.dart';
import '../theme.dart';
import 'analytics_screen.dart';
import 'settings_screen.dart';
import 'today_screen.dart';
import 'transactions_screen.dart';

class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _index = 0;
  // Rebuilt when the nudge on Today sends the user to review uncategorized
  // transactions, so the filter is applied on arrival.
  Key _transactionsKey = UniqueKey();
  bool _startUncategorized = false;

  static const _titles = ['Today', 'Transactions', 'Analytics', 'Settings'];

  void _reviewUncategorized() {
    setState(() {
      _startUncategorized = true;
      _transactionsKey = UniqueKey();
      _index = 1;
    });
  }

  @override
  Widget build(BuildContext context) {
    final screens = [
      TodayScreen(
        onReviewUncategorized: _reviewUncategorized,
        onOpenSettings: () => setState(() => _index = 3),
      ),
      TransactionsScreen(key: _transactionsKey, startUncategorized: _startUncategorized),
      const AnalyticsScreen(),
      const SettingsScreen(),
    ];

    return Scaffold(
      appBar: AppBar(
        title: Row(
          children: [
            ClipRRect(
              borderRadius: BorderRadius.circular(7),
              child: Image.asset('assets/app_icon.png', width: 26, height: 26),
            ),
            const SizedBox(width: 10),
            Text(
              _titles[_index],
              style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18, color: T.ink),
            ),
          ],
        ),
        shape: const Border(bottom: BorderSide(color: T.line)),
      ),
      body: IndexedStack(index: _index, children: screens),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() {
          if (i != 1) _startUncategorized = false;
          _index = i;
        }),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.today_outlined), selectedIcon: Icon(Icons.today), label: 'Today'),
          NavigationDestination(
            icon: Icon(Icons.receipt_long_outlined),
            selectedIcon: Icon(Icons.receipt_long),
            label: 'Transactions',
          ),
          NavigationDestination(
            icon: Icon(Icons.trending_up_outlined),
            selectedIcon: Icon(Icons.trending_up),
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
