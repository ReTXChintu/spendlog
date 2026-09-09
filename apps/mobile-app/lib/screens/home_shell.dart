import 'package:flutter/material.dart';
import '../theme.dart';
import 'analytics_screen.dart';
import 'settings_screen.dart';
import 'transactions_screen.dart';

class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _index = 0;

  static const _titles = ['Transactions', 'Analytics', 'Settings'];

  @override
  Widget build(BuildContext context) {
    final screens = [
      TransactionsScreen(onOpenSettings: () => setState(() => _index = 2)),
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
              style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18, color: context.c.ink),
            ),
          ],
        ),
        shape: Border(bottom: BorderSide(color: context.c.line)),
      ),
      body: IndexedStack(index: _index, children: screens),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() => _index = i),
        destinations: const [
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
