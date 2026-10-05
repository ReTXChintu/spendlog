import 'package:flutter/material.dart';
import '../models/models.dart';
import '../theme.dart';
import '../utils/format.dart';

/// "Rahul's pocket money" - or "James' pocket money" for a name ending in s.
String pocketTitle(String holder) {
  final name = holder.trim().isEmpty ? 'Someone' : holder.trim();
  return name.toLowerCase().endsWith('s') ? "$name' pocket money" : "$name's pocket money";
}

/// "renews on 1 Nov", from the server's plain date; the day of the month
/// when an older server sent no date.
String pocketRenews(PocketStatus status) {
  final label = formatIsoShortDate(status.renewsOn);
  return label.isEmpty ? 'renews on the ${ordinalDay(status.renewDay)}' : 'renews on $label';
}

/// Spent against the monthly limit, with a bar and what is left.
class PocketMeter extends StatelessWidget {
  const PocketMeter({super.key, required this.status, this.compact = false});

  final PocketStatus status;

  /// Smaller type for a half-width Home tile.
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final limit = status.limitMinor;
    final used = limit > 0 ? (status.spentMinor / limit).clamp(0.0, 1.0) : 0.0;
    final over = status.over;
    final close = !over && used >= 0.8;
    final tint = over ? c.debit : (close ? c.warn : c.brand);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        FittedBox(
          fit: BoxFit.scaleDown,
          alignment: Alignment.centerLeft,
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Text(
                compact ? formatMoneyShort(status.spentMinor) : formatMoney(status.spentMinor),
                style: kNum.copyWith(fontSize: compact ? 19 : 21, fontWeight: FontWeight.w800, color: c.ink),
              ),
              const SizedBox(width: 6),
              Text(
                'of ${formatMoneyShort(limit)}',
                style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: c.muted),
              ),
            ],
          ),
        ),
        const SizedBox(height: 8),
        ClipRRect(
          borderRadius: BorderRadius.circular(100),
          child: LinearProgressIndicator(
            value: used,
            minHeight: 6,
            backgroundColor: c.track,
            valueColor: AlwaysStoppedAnimation(tint),
          ),
        ),
        const SizedBox(height: 6),
        Text(
          over
              ? '${formatMoney(status.spentMinor - limit)} over the limit'
              : '${formatMoney(status.leftMinor)} left',
          style: TextStyle(
            fontSize: 11.5,
            fontWeight: over ? FontWeight.w700 : FontWeight.w500,
            color: over || close ? tint : c.muted,
          ),
        ),
      ],
    );
  }
}

/// Ask whose pocket money this is, how much a month, and which day it
/// renews. Null when cancelled.
Future<PocketMoney?> showPocketMoneyDialog(BuildContext context, {PocketMoney? current}) {
  return showDialog<PocketMoney>(
    context: context,
    builder: (_) => _PocketMoneyDialog(current: current),
  );
}

class _PocketMoneyDialog extends StatefulWidget {
  const _PocketMoneyDialog({this.current});

  final PocketMoney? current;

  @override
  State<_PocketMoneyDialog> createState() => _PocketMoneyDialogState();
}

class _PocketMoneyDialogState extends State<_PocketMoneyDialog> {
  late final TextEditingController _holder;
  late final TextEditingController _limit;
  late int _day;
  String? _problem;

  @override
  void initState() {
    super.initState();
    final current = widget.current;
    _holder = TextEditingController(text: current?.holder ?? '');
    _limit = TextEditingController(
      text: current == null ? '' : (current.limitMinor ~/ 100).toString(),
    );
    _day = current?.renewDay ?? 1;
  }

  @override
  void dispose() {
    _holder.dispose();
    _limit.dispose();
    super.dispose();
  }

  void _save() {
    final holder = _holder.text.trim();
    final limit = parseRupees(_limit.text);
    if (holder.isEmpty) {
      setState(() => _problem = 'Say whose pocket money it is.');
      return;
    }
    if (limit == null || limit <= 0) {
      setState(() => _problem = 'Enter the monthly limit in rupees.');
      return;
    }
    Navigator.of(context).pop(PocketMoney(holder: holder, limitMinor: limit, renewDay: _day));
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    return AlertDialog(
      title: Text(widget.current == null ? 'Make this pocket money' : 'Change pocket money'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            TextField(
              controller: _holder,
              autofocus: widget.current == null,
              maxLength: 40,
              textCapitalization: TextCapitalization.words,
              decoration: const InputDecoration(labelText: 'Whose is it?', hintText: 'Rahul', counterText: ''),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _limit,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              decoration: const InputDecoration(labelText: 'Monthly limit', prefixText: '₹ ', hintText: '2000'),
            ),
            const SizedBox(height: 14),
            Row(
              children: [
                Expanded(
                  child: Text('Renews on day', style: TextStyle(fontSize: 13.5, color: c.ink70)),
                ),
                DropdownButton<int>(
                  value: _day,
                  items: [
                    for (var day = 1; day <= 31; day++)
                      DropdownMenuItem(value: day, child: Text(ordinalDay(day))),
                  ],
                  onChanged: (day) => setState(() => _day = day ?? _day),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              'On that day, top the account up by whatever was spent the month before. '
              'A short month renews on its last day.',
              style: TextStyle(fontSize: 11.5, height: 1.4, color: c.muted),
            ),
            if (_problem != null) ...[
              const SizedBox(height: 8),
              Text(_problem!, style: TextStyle(fontSize: 12, color: c.debit)),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
        FilledButton(onPressed: _save, child: const Text('Save')),
      ],
    );
  }
}
