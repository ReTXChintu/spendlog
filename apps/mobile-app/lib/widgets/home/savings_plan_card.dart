import 'dart:async';
import 'package:flutter/material.dart';
import '../../models/models.dart';
import '../../services/api_client.dart';
import '../ds/ds.dart';
import '../../utils/format.dart';
import 'ai_insights_card.dart';

/// The AI-written savings plan: a short summary, a monthly target, and a
/// handful of rules, each checked against this month's spending.
///
/// Writing one takes the server 10-30 seconds, so the wait says what it is
/// doing in turn rather than sitting on a bare spinner.
class SavingsPlanCard extends StatefulWidget {
  const SavingsPlanCard({super.key, this.onOpenSettings});

  final VoidCallback? onOpenSettings;

  @override
  State<SavingsPlanCard> createState() => SavingsPlanCardState();
}

class SavingsPlanCardState extends State<SavingsPlanCard> {
  SavingsPlan? _plan;
  bool _loading = true;
  bool _writing = false;
  bool _noKey = false;
  String? _error;

  Timer? _ticker;
  int _step = 0;

  static const _steps = [
    'Looking back over the last few months…',
    'Finding where the money goes each month…',
    'Working out what can be saved…',
    'Writing the rules…',
  ];

  @override
  void initState() {
    super.initState();
    load();
  }

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  Future<void> load() async {
    try {
      final json = await ApiClient.instance.get('/ai/plan') as Map<String, dynamic>;
      if (!mounted) return;
      final plan = json['plan'];
      setState(() {
        _plan = plan is Map<String, dynamic> ? SavingsPlan.fromJson(plan) : null;
        _error = null;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        if (error is ApiException && error.statusCode == 409) {
          _noKey = true;
        } else {
          _error = error is ApiException ? error.message : "Couldn't reach the server just now.";
        }
      });
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _write() async {
    setState(() {
      _writing = true;
      _error = null;
      _step = 0;
    });
    _ticker = Timer.periodic(const Duration(seconds: 6), (_) {
      if (mounted && _step < _steps.length - 1) setState(() => _step++);
    });
    try {
      final json = await ApiClient.instance.post('/ai/plan') as Map<String, dynamic>;
      if (!mounted) return;
      final plan = json['plan'];
      setState(() => _plan = plan is Map<String, dynamic> ? SavingsPlan.fromJson(plan) : _plan);
    } catch (error) {
      if (!mounted) return;
      setState(() {
        if (error is ApiException && error.statusCode == 409) {
          _noKey = true;
        } else {
          _error = error is ApiException ? error.message : "That didn't work just now. Try again in a moment.";
        }
      });
    } finally {
      _ticker?.cancel();
      if (mounted) setState(() => _writing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final plan = _plan;

    final Widget body;
    if (_loading) {
      body = const AiWaiting(text: 'Fetching your plan…');
    } else if (_writing) {
      body = AiWaiting(text: '${_steps[_step]} This takes about 20 seconds.');
    } else if (_noKey) {
      body = AiNeedsKey(what: 'write you a savings plan and warn you when you drift', onOpenSettings: widget.onOpenSettings);
    } else if (plan == null) {
      body = Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Let the assistant look at your recent spending and write a few plain rules for saving '
            'more - a cap per category, a target for the month. Home warns you when one slips.',
            style: TextStyle(fontSize: 14, height: 20 / 14, color: c.tx2),
          ),
          if (_error != null) ...[
            const SizedBox(height: 6),
            Text(_error!, style: TextStyle(fontSize: 12, height: 16 / 12, color: c.crit)),
          ],
          const SizedBox(height: 12),
          FilledButton.icon(
            onPressed: _write,
            icon: const DsIcon(DsIcons.sparkles, size: 18),
            label: const Text('Make my savings plan'),
          ),
        ],
      );
    } else {
      body = _PlanBody(plan: plan, error: _error, onRewrite: _write);
    }

    return AiCardFrame(title: 'Savings plan', icon: DsIcons.piggyBank, child: body);
  }
}

class _PlanBody extends StatelessWidget {
  const _PlanBody({required this.plan, required this.error, required this.onRewrite});

  final SavingsPlan plan;
  final String? error;
  final VoidCallback onRewrite;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final slipping = plan.rules.where((r) => r.state != 'ok').length;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (plan.monthlyTargetMinor != null)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            decoration: BoxDecoration(color: c.goodSoft, borderRadius: BorderRadius.circular(Ds.rLg)),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                DsLabel('Save each month', color: c.good),
                const SizedBox(height: 2),
                Text(
                  formatMoney(plan.monthlyTargetMinor!),
                  style: kNum.copyWith(fontSize: 22, height: 28 / 22, fontWeight: FontWeight.w600, color: c.good),
                ),
              ],
            ),
          ),
        const SizedBox(height: 12),
        Text(plan.summary, style: TextStyle(fontSize: 15, height: 22 / 15, color: c.tx2)),
        const SizedBox(height: 16),
        DsLabel(
          slipping == 0 ? 'The rules · all on track' : 'The rules · $slipping slipping',
          color: slipping == 0 ? c.tx2 : c.warn,
        ),
        const SizedBox(height: 10),
        for (final rule in plan.rules) _RuleRow(rule: rule),
        if (error != null) Text(error!, style: TextStyle(fontSize: 12, height: 16 / 12, color: c.crit)),
        const SizedBox(height: 4),
        Row(
          children: [
            Expanded(
              child: Text(
                'Written ${madeWhen(plan.updatedAt)}',
                style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
              ),
            ),
            TextButton.icon(
              onPressed: onRewrite,
              icon: const DsIcon(DsIcons.pencil, size: 16),
              label: const Text('Rewrite plan'),
            ),
          ],
        ),
      ],
    );
  }
}

class _RuleRow extends StatelessWidget {
  const _RuleRow({required this.rule});

  final PlanRule rule;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final (label, tone, fill) = switch (rule.state) {
      'over' => ('Over', DsTone.crit, c.critFill),
      'watch' => ('Watch', DsTone.warn, c.warnFill),
      _ => ('On track', DsTone.good, c.good),
    };
    final cap = rule.monthlyCapMinor;
    final spent = rule.spentMinor;
    final expected = rule.expectedSoFarMinor;

    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Text(
                  rule.text,
                  style: TextStyle(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w500, color: c.tx),
                ),
              ),
              const SizedBox(width: 8),
              DsBadge(label, tone: tone),
            ],
          ),
          if (cap != null && cap > 0 && spent != null) ...[
            const SizedBox(height: 7),
            // The bar is the cap; the tick is where spending should be by
            // today, so "ahead of pace" can be seen, not just read.
            DsMeter(
              value: (spent / cap).clamp(0.0, 1.0),
              height: 10,
              color: fill,
              today: expected == null ? null : (expected / cap).clamp(0.0, 1.0),
            ),
            const SizedBox(height: 4),
            Text(
              [
                '${formatMoneyShort(spent)} of ${formatMoneyShort(cap)}',
                if (expected != null) '${formatMoneyShort(expected)} expected by now',
              ].join(' · '),
              style: kNum.copyWith(fontSize: 12, height: 16 / 12, color: c.tx3),
            ),
          ],
        ],
      ),
    );
  }
}
