import 'package:flutter/material.dart';
import '../../models/fund_models.dart';
import '../ds/ds.dart';
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
    final buttonStyle = OutlinedButton.styleFrom(
      minimumSize: const Size(0, 40),
      padding: const EdgeInsets.symmetric(horizontal: 14),
      textStyle: const TextStyle(fontFamily: Ds.sans, fontSize: 14, fontWeight: FontWeight.w600),
    );
    return FundCard(
      padding: EdgeInsets.zero,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  sipHistoryLine(widget.sip),
                  style: kNum.copyWith(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
                ),
                const SizedBox(height: 12),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    OutlinedButton.icon(
                      style: buttonStyle,
                      onPressed: widget.busy.contains('sip-change') ? null : widget.onChangeAmount,
                      icon: const DsIcon(DsIcons.pencil, size: 18),
                      label: const Text('Change amount'),
                    ),
                    OutlinedButton.icon(
                      style: buttonStyle,
                      onPressed: pauseBusy ? null : (widget.paused ? widget.onResume : widget.onPause),
                      icon: Icon(widget.paused ? Icons.play_arrow_rounded : Icons.pause_rounded, size: 18),
                      label: Text(widget.paused ? 'Resume' : 'Pause'),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                Text(
                  'Tap a month to mark it skipped, or to take the skip back.',
                  style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
                ),
                const SizedBox(height: 8),
              ],
            ),
          ),
          if (months.isEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
              child: Text(
                'No instalments in the last two years or the next three months.',
                style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3),
              ),
            ),
          for (final (i, month) in shown.indexed)
            SipMonthRow(
              month: month,
              busy: widget.busy.contains('month-${month.month}'),
              onTap: () => widget.onTapMonth(month),
              first: i == 0,
              last: i == shown.length - 1,
            ),
          if (months.length > SipHistoryCard.shortList) ...[
            Divider(height: 1, color: c.ln),
            TextButton(
              onPressed: () => setState(() => _all = !_all),
              child: Text(_all ? 'Show fewer' : 'Show all ${months.length} months'),
            ),
          ] else if (months.isNotEmpty)
            const SizedBox(height: 8),
        ],
      ),
    );
  }
}

/// One month of the timeline: a 10 px dot on an `ln2` connector (§7.8),
/// filled `ac` once invested, a dashed `ac` ring while still to come.
class SipMonthRow extends StatelessWidget {
  const SipMonthRow({
    super.key,
    required this.month,
    required this.onTap,
    this.busy = false,
    this.first = false,
    this.last = false,
  });

  final SipPlanMonth month;
  final VoidCallback onTap;
  final bool busy;

  /// Where the connector stops, at the top and bottom of the timeline.
  final bool first;
  final bool last;

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
    final dot = switch (month.status) {
      SipMonthStatus.invested => _Dot(fill: month.covered ? c.tx3 : c.ac),
      SipMonthStatus.skipped => _Dot(ring: c.ln2),
      SipMonthStatus.paused => _Dot(ring: c.warnFill),
      SipMonthStatus.pendingNav => _Dot(fill: c.warnFill),
      _ => _Dot(ring: c.ac, dashed: true),
    };
    final skipped = month.isSkipped;
    final actual = month.actualMinor;
    final differs = actual != null && (actual - month.plannedMinor).abs() >= 100;
    return InkWell(
      key: ValueKey('plan-month-${month.month}'),
      onTap: busy ? null : onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16),
        child: IntrinsicHeight(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              SizedBox(
                width: 20,
                child: CustomPaint(
                  painter: _ConnectorPainter(color: c.ln2, top: !first, bottom: !last),
                  child: Center(
                    child: busy
                        ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
                        : dot,
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 10),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Text(
                        sipMonthLabel(month.month),
                        style: TextStyle(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w500, color: c.tx),
                      ),
                      Text(describe(month), style: kNum.copyWith(fontSize: 12, height: 16 / 12, color: c.tx3)),
                    ],
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(
                    formatMoneyShort(actual ?? month.plannedMinor),
                    style: kNum.copyWith(
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                      color: skipped || month.status == SipMonthStatus.upcoming ? c.tx3 : c.tx,
                      decoration: skipped ? TextDecoration.lineThrough : null,
                    ),
                  ),
                  if (differs)
                    Text(
                      'planned ${formatMoneyShort(month.plannedMinor)}',
                      style: kNum.copyWith(fontSize: 12, height: 16 / 12, color: c.tx3),
                    ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A 10 px timeline marker: filled, a ring, or a dashed ring.
class _Dot extends StatelessWidget {
  const _Dot({this.fill, this.ring, this.dashed = false});

  final Color? fill;
  final Color? ring;
  final bool dashed;

  @override
  Widget build(BuildContext context) => CustomPaint(
        size: const Size.square(10),
        painter: _DotPainter(fill: fill, ring: ring, dashed: dashed, background: context.c.sf),
      );
}

class _DotPainter extends CustomPainter {
  _DotPainter({this.fill, this.ring, required this.dashed, required this.background});

  final Color? fill;
  final Color? ring;
  final bool dashed;
  final Color background;

  @override
  void paint(Canvas canvas, Size size) {
    final centre = size.center(Offset.zero);
    final r = size.width / 2;
    // Covers the connector behind a hollow marker.
    canvas.drawCircle(centre, r, Paint()..color = fill ?? background);
    if (ring == null) return;
    final paint = Paint()
      ..color = ring!
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5;
    final rect = Rect.fromCircle(center: centre, radius: r - 0.75);
    if (!dashed) {
      canvas.drawOval(rect, paint);
      return;
    }
    const segments = 8;
    const sweep = 2 * 3.141592653589793 / segments;
    for (var i = 0; i < segments; i++) {
      canvas.drawArc(rect, i * sweep, sweep * 0.55, false, paint);
    }
  }

  @override
  bool shouldRepaint(_DotPainter old) =>
      old.fill != fill || old.ring != ring || old.dashed != dashed || old.background != background;
}

/// The 1 px `ln2` line that joins the timeline's markers.
class _ConnectorPainter extends CustomPainter {
  _ConnectorPainter({required this.color, required this.top, required this.bottom});

  final Color color;
  final bool top;
  final bool bottom;

  @override
  void paint(Canvas canvas, Size size) {
    final x = size.width / 2;
    final mid = size.height / 2;
    final paint = Paint()
      ..color = color
      ..strokeWidth = 1;
    if (top) canvas.drawLine(Offset(x, 0), Offset(x, mid), paint);
    if (bottom) canvas.drawLine(Offset(x, mid), Offset(x, size.height), paint);
  }

  @override
  bool shouldRepaint(_ConnectorPainter old) => old.color != color || old.top != top || old.bottom != bottom;
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
              const SizedBox(height: 16),
              DsField(
                label: 'Each month from then',
                error: _error,
                help: 'A step-up or a step-down. It holds until the next change already there; '
                    'earlier months keep what they were.',
                child: TextField(
                  key: const ValueKey('sip-change-amount'),
                  controller: _amount,
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  style: kNum.copyWith(fontSize: 15, color: c.tx),
                  decoration: InputDecoration(
                    prefixText: '₹ ',
                    hintText: (widget.sip.currentAmountMinor ~/ 100).toString(),
                    enabledBorder: _error == null
                        ? null
                        : OutlineInputBorder(
                            borderRadius: BorderRadius.circular(Ds.rMd),
                            borderSide: BorderSide(color: c.crit, width: 2),
                          ),
                  ),
                ),
              ),
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
              const SizedBox(height: 16),
              DsField(
                label: 'Until (optional)',
                help: 'Paused months buy nothing and the monthly figure shows ₹0 while it lasts. '
                    'Instalments before it stay.',
                child: InkWell(
                  key: const ValueKey('sip-pause-to'),
                  onTap: () async {
                    final picked = await pickMonth(context, title: 'Paused until', initial: _to ?? _from, first: _from, last: _last);
                    if (picked != null) setState(() => _to = picked);
                  },
                  borderRadius: BorderRadius.circular(Ds.rMd),
                  child: InputDecorator(
                    decoration: InputDecoration(
                      suffixIcon: _to == null
                          ? DsIcon(DsIcons.chevronDown, size: 20, color: c.tx2)
                          : IconButton(
                              tooltip: 'Until I resume',
                              icon: DsIcon(DsIcons.x, size: 18, color: c.tx2),
                              onPressed: () => setState(() => _to = null),
                            ),
                    ),
                    child: Text(
                      _to == null ? 'Until I resume' : sipMonthLabel(_to!),
                      style: TextStyle(fontSize: 15, color: _to == null ? c.tx3 : c.tx),
                    ),
                  ),
                ),
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
