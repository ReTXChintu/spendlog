import 'package:flutter/material.dart';
import '../widgets/ds/ds.dart';
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
        // The two halves as a segmented control (the system's only tab
        // style). It follows the swipe, so the pages still slide.
        Container(
          color: c.bg,
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
          child: AnimatedBuilder(
            animation: _tabs.animation ?? _tabs,
            builder: (context, _) {
              final at = (_tabs.animation?.value ?? _tabs.index.toDouble()).round();
              return DsSegmented<int>(
                segments: const [(0, 'Dashboard'), (1, 'Analytics')],
                selected: at,
                height: 36,
                onChanged: (i) => _tabs.animateTo(i),
              );
            },
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
                onOpenAiSettings: widget.onOpenAiSettings,
              ),
              AnalyticsScreen(key: _analytics, onOpenSettings: widget.onOpenAiSettings),
            ],
          ),
        ),
      ],
    );
  }
}
