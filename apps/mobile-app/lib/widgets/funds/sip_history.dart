import 'package:flutter/material.dart';
import '../../models/fund_models.dart';
import '../../theme.dart';
import '../../utils/format.dart';
import 'fund_form.dart';
import 'fund_text.dart';
import 'fund_widgets.dart';

/// A holding's SIP month by month: the history in one line, the actions
/// that change it, and a timeline of what each month was meant to be and
/// what became of it.
///
/// Only draws and reports taps; the holding's page makes the calls and
/// reloads the figures.
class SipHistoryCard extends StatefulWidget {
  const SipHistoryCard({
    super.key,
    required this.sip,
    required this.plan,
    required this.paused,
    required this.onChangeAmount,
    required this.onPause,
    required this.onResume,
    required this.onTapMonth,
    this.busy = const {},
  });

  final FundSip sip;

  /// Oldest first, as the server sends it.
  final List<SipPlanMonth> plan;

  /// Paused this month, or from a month still to come.
  final bool paused;
  final VoidCallback onChangeAmount;
  final VoidCallback onPause;
  final VoidCallback onResume;
  final ValueChanged<SipPlanMonth> onTapMonth;

  /// Keys of calls in flight: 'month-YYYY-MM', 'sip-change', 'sip-pause'.
  final Set<String> busy;

  /// Months shown before "Show all".
  static const shortList = 12;

  @override
  State<SipHistoryCard> createState() => _SipHistoryCardState();
}

class _SipHistoryCardState extends State<SipHistoryCard> {
  bool _all = false;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final months = widget.plan.reversed.toList();
    final shown = _all ? months : months.take(SipHistoryCard.shortList).toList();
    final pauseBusy = widget.busy.contains('sip-pause');
    return FundCard(
      padding: EdgeInsets.zero,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 0),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  sipHistoryLine(widget.sip),
                  style: TextStyle(fontSize: 13, height: 1.4, fontWeight: FontWeight.w700, color: c.ink),
                ),
                const SizedBox(height: 10),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    OutlinedButton.icon(
                      onPressed: widget.busy.contains('sip-change') ? null : widget.onChangeAmount,
                      icon: const Icon(Icons.trending_up, size: 17),
                      label: const Text('Change amount'),
                    ),
                    OutlinedButton.icon(
                      onPressed: pauseBusy ? null : (widget.paused ? widget.onResume : widget.onPause),
                      icon: Icon(widget.paused ? Icons.play_circle_outline : Icons.pause_circle_outline, size: 17),
                      label: Text(widget.paused ? 'Resume' : 'Pause'),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Text(
                  'Tap a month to mark it skipped, or to take the skip back.',
                  style: TextStyle(fontSize: 11.5, height: 1.4, color: c.muted),
                ),
                const SizedBox(height: 6),
              ],
            ),
          ),
          if (months.isEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 6, 14, 14),
              child: Text(
                'No instalments in the last two years or the next three months.',
                style: TextStyle(fontSize: 12.5, height: 1.4, color: c.muted),
              ),
            ),
          for (final month in shown) ...[
            Divider(height: 1, color: c.line),
            SipMonthRow(
              month: month,
              busy: widget.busy.contains('month-${month.month}'),
              onTap: () => widget.onTapMonth(month),
            ),
          ],
          if (months.length > SipHistoryCard.shortList) ...[
            Divider(height: 1, color: c.line),
            TextButton(
              onPressed: () => setState(() => _all = !_all),
              child: Text(_all ? 'Show fewer' : 'Show all ${months.length} months'),
            ),
          ],
        ],
      ),
    );
  }
}

/// One month of the timeline.
class SipMonthRow extends StatelessWidget {
  const SipMonthRow({super.key, required this.month, required this.onTap, this.busy = false});

  final SipPlanMonth month;
  final VoidCallback onTap;
  final bool busy;

  /// "Invested · 10.234 units at ₹97.1234", "Skipped", "Upcoming · due 10 Nov".
  static String describe(SipPlanMonth month) {
    final units = month.units;
    final nav = month.nav;
    return switch (month.status) {
      SipMonthStatus.invested when month.covered => 'In the opening balance',
      SipMonthStatus.invested => [
          'Invested',
          if (units != null && nav != null) '${units.toStringAsFixed(3)} units at ₹${nav.toStringAsFixed(2)}',
          if (month.markedSkipped) 'paid though marked skipped',
        ].join(' · '),
      SipMonthStatus.skipped => 'Skipped',
      SipMonthStatus.paused => 'Paused',
      SipMonthStatus.pendingNav => 'Waiting for NAV · due ${formatIsoShortDate(month.due)}',
      _ => 'Upcoming · due ${formatIsoShortDate(month.due)}',
    };
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final (icon, colour) = switch (month.status) {
      SipMonthStatus.invested => (Icons.check_circle_outline, month.covered ? c.muted : c.credit),
      SipMonthStatus.skipped => (Icons.remove_circle_outline, c.muted),
      SipMonthStatus.paused => (Icons.pause_circle_outline, c.warn),
      SipMonthStatus.pendingNav => (Icons.schedule, c.warn),
      _ => (Icons.event_outlined, c.mutedLight),
    };
    final skipped = month.isSkipped;
    final actual = month.actualMinor;
    final differs = actual != null && (actual - month.plannedMinor).abs() >= 100;
    return InkWell(
      key: ValueKey('plan-month-${month.month}'),
      onTap: busy ? null : onTap,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 9, 14, 9),
        child: Row(
          children: [
            SizedBox(
              width: 20,
              child: busy
                  ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                  : Icon(icon, size: 18, color: colour),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(sipMonthLabel(month.month), style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: c.ink)),
                  Text(describe(month), style: TextStyle(fontSize: 11.5, height: 1.35, color: c.muted)),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text(
                  formatMoneyShort(actual ?? month.plannedMinor),
                  style: kNum.copyWith(
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                    color: skipped || month.status == SipMonthStatus.upcoming ? c.muted : c.ink,
                    decoration: skipped ? TextDecoration.lineThrough : null,
                  ),
                ),
                if (differs)
                  Text('planned ${formatMoneyShort(month.plannedMinor)}', style: TextStyle(fontSize: 11, color: c.muted)),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// "Change amount": from which month, and the new amount. Pops the body
/// for `POST /funds/holdings/:id/sip/change`.
class SipChangeDialog extends StatefulWidget {
  const SipChangeDialog({super.key, required this.sip});

  final FundSip sip;

  @override
  State<SipChangeDialog> createState() => _SipChangeDialogState();
}

class _SipChangeDialogState extends State<SipChangeDialog> {
  late String _month = _clampMonth(istToday().substring(0, 7));
  final _amount = TextEditingController();
  String? _error;

  String get _first => widget.sip.startOn.substring(0, 7);
  String get _last => widget.sip.endOn?.substring(0, 7) ?? shiftSipMonth(istToday().substring(0, 7), 12);

  String _clampMonth(String month) =>
      month.compareTo(_first) < 0 ? _first : (month.compareTo(_last) > 0 ? _last : month);

  @override
  void dispose() {
    _amount.dispose();
    super.dispose();
  }

  void _save() {
    final amountMinor = parseRupees(_amount.text);
    if (amountMinor == null || amountMinor < 100) {
      setState(() => _error = 'Enter the new monthly amount.');
      return;
    }
    Navigator.of(context).pop({'fromOn': '$_month-01', 'amountMinor': amountMinor});
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return AlertDialog(
      insetPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 24),
      title: const Text('Change the SIP amount'),
      content: SizedBox(
        width: double.maxFinite,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              MonthField(
                key: const ValueKey('sip-change-from'),
                label: 'From',
                month: _month,
                onPick: () async {
                  final picked = await pickMonth(context, title: 'Changed from', initial: _month, first: _first, last: _last);
                  if (picked != null) setState(() => _month = picked);
                },
              ),
              const SizedBox(height: 10),
              TextField(
                key: const ValueKey('sip-change-amount'),
                controller: _amount,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                decoration: InputDecoration(
                  labelText: 'Each month from then',
                  prefixText: '₹ ',
                  hintText: (widget.sip.currentAmountMinor ~/ 100).toString(),
                ),
              ),
              const SizedBox(height: 8),
              Text(
                'A step-up or a step-down. It holds until the next change already there; '
                'earlier months keep what they were.',
                style: TextStyle(fontSize: 11.5, height: 1.4, color: c.muted),
              ),
              if (_error != null) ...[
                const SizedBox(height: 8),
                Text(_error!, style: TextStyle(fontSize: 12, height: 1.4, color: c.debit)),
              ],
            ],
          ),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
        FilledButton(onPressed: _save, child: const Text('Save')),
      ],
    );
  }
}

/// "Pause": from which month, and until when (or until resumed). Pops the
/// body for `POST /funds/holdings/:id/sip/pause`.
class SipPauseDialog extends StatefulWidget {
  const SipPauseDialog({super.key, required this.sip});

  final FundSip sip;

  @override
  State<SipPauseDialog> createState() => _SipPauseDialogState();
}

class _SipPauseDialogState extends State<SipPauseDialog> {
  late String _from = _clampMonth(istToday().substring(0, 7));
  String? _to;

  String get _first => widget.sip.startOn.substring(0, 7);
  String get _last => widget.sip.endOn?.substring(0, 7) ?? shiftSipMonth(istToday().substring(0, 7), 24);

  String _clampMonth(String month) =>
      month.compareTo(_first) < 0 ? _first : (month.compareTo(_last) > 0 ? _last : month);

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return AlertDialog(
      insetPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 24),
      title: const Text('Pause the SIP'),
      content: SizedBox(
        width: double.maxFinite,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              MonthField(
                key: const ValueKey('sip-pause-from'),
                label: 'Nothing going in from',
                month: _from,
                onPick: () async {
                  final picked = await pickMonth(context, title: 'Paused from', initial: _from, first: _first, last: _last);
                  if (picked != null) {
                    setState(() {
                      _from = picked;
                      if (_to != null && _to!.compareTo(picked) < 0) _to = picked;
                    });
                  }
                },
              ),
              const SizedBox(height: 10),
              InkWell(
                key: const ValueKey('sip-pause-to'),
                onTap: () async {
                  final picked = await pickMonth(context, title: 'Paused until', initial: _to ?? _from, first: _from, last: _last);
                  if (picked != null) setState(() => _to = picked);
                },
                borderRadius: BorderRadius.circular(T.rSm),
                child: InputDecorator(
                  decoration: InputDecoration(
                    labelText: 'Until (optional)',
                    suffixIcon: _to == null
                        ? const Icon(Icons.expand_more, size: 18)
                        : IconButton(
                            tooltip: 'Until I resume',
                            icon: const Icon(Icons.close, size: 18),
                            onPressed: () => setState(() => _to = null),
                          ),
                  ),
                  child: Text(
                    _to == null ? 'Until I resume' : sipMonthLabel(_to!),
                    style: TextStyle(fontSize: 15, color: _to == null ? c.mutedLight : c.ink),
                  ),
                ),
              ),
              const SizedBox(height: 8),
              Text(
                'Paused months buy nothing and the monthly figure shows ₹0 while it lasts. '
                'Instalments before it stay.',
                style: TextStyle(fontSize: 11.5, height: 1.4, color: c.muted),
              ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
        FilledButton(
          onPressed: () => Navigator.of(context).pop({'fromOn': '$_from-01', if (_to != null) 'toOn': '$_to-01'}),
          child: const Text('Pause'),
        ),
      ],
    );
  }
}

/// Whether a SIP has a pause running now or still to come - one that
/// "Resume" would end.
bool sipHasPauseAhead(FundSip sip, String today) {
  final month = today.substring(0, 7);
  return sip.pauses.any((pause) => pause.toOn == null || pause.toOn!.substring(0, 7).compareTo(month) >= 0);
}
