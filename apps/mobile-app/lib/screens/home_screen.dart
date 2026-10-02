import 'package:flutter/material.dart';
import '../theme.dart';
import 'analytics_screen.dart';
import 'dashboard_screen.dart';

/// Home: the Dashboard and Analytics as two tabs of one place.
///
/// They answer the same question at two distances - "where do I stand
/// today" and "how is the month going" - so they sit side by side, a swipe
/// apart, instead of at opposite ends of the bottom bar.
class HomeScreen extends StatefulWidget {
  const HomeScreen({
    super.key,
    required this.dashboardKey,
    this.onOpenTransactions,
    this.onOpenSettings,
    this.onOpenAiSettings,
  });

  /// Held by the shell so it can reload the dashboard when Home is reopened.
  final GlobalKey<DashboardScreenState> dashboardKey;
  final VoidCallback? onOpenTransactions;
  final VoidCallback? onOpenSettings;

  /// Settings, opened at the assistant's card - where the Gemini key goes.
  final VoidCallback? onOpenAiSettings;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> with SingleTickerProviderStateMixin {
  late final TabController _tabs = TabController(length: 2, vsync: this);
  final _analytics = GlobalKey<AnalyticsScreenState>();

  @override
  void dispose() {
    _tabs.dispose();
    super.dispose();
  }

  void _openPlan() {
    _tabs.animateTo(1);
    // The Analytics page may not exist until the tab has slid in.
    Future.delayed(kTabScrollDuration + const Duration(milliseconds: 50), () {
      if (mounted) _analytics.currentState?.showPlan();
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Column(
      children: [
        Material(
          color: c.surface,
          child: TabBar(
            controller: _tabs,
            labelColor: c.brandDark,
            unselectedLabelColor: c.muted,
            indicatorColor: c.brand,
            indicatorSize: TabBarIndicatorSize.label,
            dividerColor: c.line,
            labelStyle: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700),
            unselectedLabelStyle: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600),
            tabs: const [Tab(text: 'Dashboard', height: 42), Tab(text: 'Analytics', height: 42)],
          ),
        ),
        Expanded(
          child: TabBarView(
            controller: _tabs,
            children: [
              DashboardScreen(
                key: widget.dashboardKey,
                onOpenTransactions: widget.onOpenTransactions,
                onOpenSettings: widget.onOpenSettings,
                onOpenPlan: _openPlan,
              ),
              AnalyticsScreen(key: _analytics, onOpenSettings: widget.onOpenAiSettings),
            ],
          ),
        ),
      ],
    );
  }
}
