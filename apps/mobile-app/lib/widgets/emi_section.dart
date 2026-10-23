import 'package:flutter/material.dart';
import '../models/models.dart';
import '../screens/emi_plan_screen.dart';
import '../services/api_client.dart';
import '../utils/format.dart';
import 'ds/ds.dart';
import 'existing_emi_sheet.dart';

/// The EMIs running, each with where it stands, and the way to add one that
/// began before SpendLog.
///
/// On the Loans screen it lists every plan; on a credit card's page,
/// [accountId] narrows it to that card and picks the card in advance when
/// one is added.
class EmiSection extends StatefulWidget {
  const EmiSection({super.key, this.accountId, this.onChanged, this.title});

  final String? accountId;

  /// Told after anything about an EMI changed, so the page around it can
  /// reload what it shows.
  final VoidCallback? onChanged;

  /// Defaults to "EMIs", or "EMIs on this card" with [accountId].
  final String? title;

  @override
  State<EmiSection> createState() => _EmiSectionState();
}

class _EmiSectionState extends State<EmiSection> {
  List<EmiPlan>? _plans;
  bool _failed = false;
  bool _showClosed = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final rows = await ApiClient.instance.get('/emi') as List<dynamic>;
      if (!mounted) return;
      setState(() {
        _plans = rows
            .map((row) => EmiPlan.fromJson(row as Map<String, dynamic>))
            .where((plan) => widget.accountId == null || plan.accountId == widget.accountId)
            .toList();
        _failed = false;
      });
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
  }

  Future<void> _changed() async {
    await _load();
    widget.onChanged?.call();
  }

  Future<void> _add() async {
    if (await showExistingEmiSheet(context, accountId: widget.accountId)) await _changed();
  }

  Future<void> _open(EmiPlan plan) async {
    if (await EmiPlanScreen.open(context, plan)) await _changed();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final plans = _plans;
    final running = plans?.where((plan) => plan.isActive).toList() ?? const <EmiPlan>[];
    final closed = plans?.where((plan) => !plan.isActive).toList() ?? const <EmiPlan>[];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        DsLabel(
          widget.title ?? (widget.accountId == null ? 'EMIs' : 'EMIs on this card'),
          padding: const EdgeInsets.fromLTRB(2, 8, 2, 8),
        ),
        if (plans == null && !_failed)
          const Padding(padding: EdgeInsets.all(12), child: Center(child: DsSpinner()))
        else if (_failed)
          Text("Couldn't load EMIs.", style: TextStyle(fontSize: 13, color: c.tx3))
        else ...[
          if (running.isEmpty)
            Text(
              widget.accountId == null ? 'No EMIs running.' : 'No EMIs running on this card.',
              style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3),
            ),
          for (final plan in running) ...[
            EmiPlanTile(plan: plan, showAccount: widget.accountId == null, onTap: () => _open(plan)),
            const SizedBox(height: 8),
          ],
          if (closed.isNotEmpty)
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                key: const ValueKey('emi-show-closed'),
                onPressed: () => setState(() => _showClosed = !_showClosed),
                icon: DsIcon(_showClosed ? DsIcons.chevronUp : DsIcons.chevronDown, size: 16),
                label: Text('${_showClosed ? 'Hide' : 'Show'} ${closed.length} closed'),
              ),
            ),
          if (_showClosed)
            for (final plan in closed) ...[
              EmiPlanTile(plan: plan, showAccount: widget.accountId == null, onTap: () => _open(plan)),
              const SizedBox(height: 8),
            ],
        ],
        const SizedBox(height: 4),
        Align(
          alignment: Alignment.centerLeft,
          child: OutlinedButton.icon(
            key: const ValueKey('emi-add-existing'),
            onPressed: _add,
            icon: const DsIcon(DsIcons.plus, size: 18),
            label: const Text('Add an EMI you already have'),
          ),
        ),
      ],
    );
  }
}

/// One EMI: its name, card, how far along, and the next instalment.
class EmiPlanTile extends StatelessWidget {
  const EmiPlanTile({super.key, required this.plan, required this.onTap, this.showAccount = true});

  final EmiPlan plan;
  final VoidCallback onTap;
  final bool showAccount;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final next = plan.nextDue;
    final share = plan.months == 0 ? 0.0 : plan.paidCount / plan.months;
    final details = [
      if (showAccount && plan.accountLabel != null) plan.accountLabel!,
      '${plan.paidCount} of ${plan.months} paid',
      if (plan.isActive) '${formatMoneyShort(plan.remainingMinor)} left' else 'Closed',
    ].join(' · ');

    return DsCard(
      key: ValueKey('emi-plan-${plan.id}'),
      onTap: onTap,
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              DsMonogram(plan.name),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      plan.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
                    ),
                    const SizedBox(height: 2),
                    Text(details, style: kNum.copyWith(fontSize: 12, height: 16 / 12, color: c.tx3)),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text(
                    formatMoney(next?.amountMinor ?? plan.monthlyAmountMinor),
                    style: kNum.copyWith(fontSize: 15, fontWeight: FontWeight.w600, color: c.tx),
                  ),
                  if (next != null && plan.isActive)
                    Text('due ${formatShortDate(next.dueDate)}', style: kNum.copyWith(fontSize: 12, color: c.tx3)),
                ],
              ),
            ],
          ),
          const SizedBox(height: 10),
          DsMeter(value: share.clamp(0.0, 1.0), height: 6),
        ],
      ),
    );
  }
}
