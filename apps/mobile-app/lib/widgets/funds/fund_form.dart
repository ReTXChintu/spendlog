import 'package:flutter/material.dart';
import '../../models/fund_models.dart';
import '../../theme.dart';
import '../../utils/format.dart';
import 'fund_text.dart';

/// What the add-fund form (and the SIP and opening editors) hold, as typed,
/// and the checks that turn it into a request body.
///
/// Kept as plain strings, apart from the widgets, so the checks can be
/// tested without a screen. They mirror the server's own (funds.routes.ts)
/// so a mistake is caught before the round trip, in words a person reads.
class FundFormData {
  final bool holdsUnits;
  final String units;
  final String invested;
  final String? asOf;
  final String? firstOn;

  final bool runsSip;
  final String sipAmount;
  final String sipDay;
  final String? sipStart;
  final String? sipEnd;
  final bool sipActive;

  final String folio;

  const FundFormData({
    this.holdsUnits = false,
    this.units = '',
    this.invested = '',
    this.asOf,
    this.firstOn,
    this.runsSip = false,
    this.sipAmount = '',
    this.sipDay = '',
    this.sipStart,
    this.sipEnd,
    this.sipActive = true,
    this.folio = '',
  });

  /// Neither section filled: the fund is added bare, to have debits linked.
  bool get isBare => !holdsUnits && !runsSip;

  /// The first problem, or the pieces of the body. [today] is the IST day.
  FundFormCheck check(String today) {
    Map<String, dynamic>? opening;
    Map<String, dynamic>? sip;

    if (holdsUnits) {
      final unitCount = double.tryParse(units.replaceAll(',', '').trim());
      if (unitCount == null || unitCount <= 0) return const FundFormCheck.error('Enter the units you hold.');
      final investedMinor = parseRupees(invested);
      if (investedMinor == null) return const FundFormCheck.error('Enter what those units cost you in all.');
      final day = asOf;
      if (day == null) return const FundFormCheck.error('Pick the date those units are as of.');
      if (day.compareTo(today) > 0) return const FundFormCheck.error("The units can't be as of a future date.");
      if (firstOn != null && firstOn!.compareTo(day) > 0) {
        return const FundFormCheck.error("The first investment can't be after the as-of date.");
      }
      opening = {'units': unitCount, 'investedMinor': investedMinor, 'asOf': day, 'firstOn': firstOn};
    }

    if (runsSip) {
      final amountMinor = parseRupees(sipAmount);
      if (amountMinor == null || amountMinor < 100) return const FundFormCheck.error('Enter the SIP amount.');
      final dayOfMonth = int.tryParse(sipDay.trim());
      if (dayOfMonth == null || dayOfMonth < 1 || dayOfMonth > 31) {
        return const FundFormCheck.error('The SIP day is a date of the month, 1 to 31.');
      }
      final start = sipStart;
      if (start == null) return const FundFormCheck.error('Pick when the SIP started.');
      if (sipEnd != null && sipEnd!.compareTo(start) < 0) {
        return const FundFormCheck.error("The SIP can't end before it starts.");
      }
      sip = {
        'amountMinor': amountMinor,
        'dayOfMonth': dayOfMonth,
        'startOn': start,
        'endOn': sipEnd,
        'active': sipActive,
      };
    }

    final folioText = folio.trim();
    if (folioText.length > 40) return const FundFormCheck.error('A folio number is at most 40 characters.');

    return FundFormCheck(opening: opening, sip: sip, folio: folioText.isEmpty ? null : folioText);
  }
}

class FundFormCheck {
  final String? error;
  final Map<String, dynamic>? opening;
  final Map<String, dynamic>? sip;
  final String? folio;

  const FundFormCheck({this.opening, this.sip, this.folio}) : error = null;
  const FundFormCheck.error(String this.error)
      : opening = null,
        sip = null,
        folio = null;

  bool get ok => error == null;

  /// `POST /funds/holdings`.
  Map<String, dynamic> createBody(int schemeCode) => {
        'schemeCode': schemeCode,
        if (folio != null) 'folio': folio,
        if (sip != null) 'sip': sip,
        if (opening != null) 'opening': opening,
      };
}

/// The controllers behind the form's text fields, and its dates.
class FundFormFields {
  FundFormFields({FundSip? sip, FundOpening? opening, String? folio})
      : holdsUnits = opening != null,
        units = TextEditingController(text: opening == null ? '' : _plain(opening.units)),
        invested = TextEditingController(text: opening == null ? '' : _rupees(opening.investedMinor)),
        asOf = opening?.asOf ?? istToday(),
        firstOn = opening?.firstOn,
        runsSip = sip != null,
        sipAmount = TextEditingController(text: sip == null ? '' : _rupees(sip.amountMinor)),
        sipDay = TextEditingController(text: sip?.dayOfMonth.toString() ?? ''),
        sipStart = sip?.startOn,
        sipEnd = sip?.endOn,
        sipActive = sip?.active ?? true,
        folio = TextEditingController(text: folio ?? '');

  bool holdsUnits;
  final TextEditingController units;
  final TextEditingController invested;
  String? asOf;
  String? firstOn;

  bool runsSip;
  final TextEditingController sipAmount;
  final TextEditingController sipDay;
  String? sipStart;
  String? sipEnd;
  bool sipActive;

  final TextEditingController folio;

  static String _rupees(int minor) => minor % 100 == 0 ? (minor ~/ 100).toString() : (minor / 100).toStringAsFixed(2);
  static String _plain(double value) =>
      value == value.roundToDouble() ? value.toInt().toString() : value.toStringAsFixed(3).replaceFirst(RegExp(r'0+$'), '');

  FundFormData get data => FundFormData(
        holdsUnits: holdsUnits,
        units: units.text,
        invested: invested.text,
        asOf: asOf,
        firstOn: firstOn,
        runsSip: runsSip,
        sipAmount: sipAmount.text,
        sipDay: sipDay.text,
        sipStart: sipStart,
        sipEnd: sipEnd,
        sipActive: sipActive,
        folio: folio.text,
      );

  void dispose() {
    units.dispose();
    invested.dispose();
    sipAmount.dispose();
    sipDay.dispose();
    folio.dispose();
  }
}

/// A date picker over plain YYYY-MM-DD days.
Future<String?> pickIsoDate(
  BuildContext context, {
  String? initial,
  required DateTime first,
  required DateTime last,
}) async {
  final start = DateTime.tryParse(initial ?? '') ?? DateTime.parse(istToday());
  final clamped = start.isBefore(first) ? first : (start.isAfter(last) ? last : start);
  final picked = await showDatePicker(context: context, initialDate: clamped, firstDate: first, lastDate: last);
  return picked == null ? null : isoDay(picked);
}

DateTime get _todayDate => DateTime.parse(istToday());

/// A row that shows a date and opens the picker, with an optional clear.
class DateField extends StatelessWidget {
  const DateField({
    super.key,
    required this.label,
    required this.value,
    required this.onPick,
    this.onClear,
    this.placeholder = 'Pick a date',
  });

  final String label;
  final String? value;
  final VoidCallback onPick;
  final VoidCallback? onClear;
  final String placeholder;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return InkWell(
      onTap: onPick,
      borderRadius: BorderRadius.circular(T.rSm),
      child: InputDecorator(
        decoration: InputDecoration(
          labelText: label,
          suffixIcon: value != null && onClear != null
              ? IconButton(tooltip: 'Clear', icon: const Icon(Icons.close, size: 18), onPressed: onClear)
              : const Icon(Icons.calendar_today_outlined, size: 18),
        ),
        child: Text(
          value == null ? placeholder : formatIsoLongDate(value!),
          style: TextStyle(fontSize: 15, color: value == null ? c.mutedLight : c.ink),
        ),
      ),
    );
  }
}

/// A section of the form with a switch on its header: "I run a SIP".
class ToggleSection extends StatelessWidget {
  const ToggleSection({
    super.key,
    required this.title,
    required this.subtitle,
    required this.on,
    required this.onChanged,
    required this.child,
    this.icon,
  });

  final String title;
  final String subtitle;
  final bool on;

  /// Null keeps it on - an editor for just this one section.
  final ValueChanged<bool>? onChanged;
  final Widget child;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Container(
      decoration: BoxDecoration(
        color: c.surface,
        border: Border.all(color: on ? c.brand100 : c.line),
        borderRadius: BorderRadius.circular(T.rMd),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InkWell(
            onTap: onChanged == null ? null : () => onChanged!(!on),
            borderRadius: BorderRadius.circular(T.rMd),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(14, 12, 8, 12),
              child: Row(
                children: [
                  if (icon != null) ...[
                    Icon(icon, size: 20, color: on ? c.brand : c.muted),
                    const SizedBox(width: 12),
                  ],
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(title, style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w800, color: c.ink)),
                        const SizedBox(height: 2),
                        Text(subtitle, style: TextStyle(fontSize: 12, height: 1.35, color: c.muted)),
                      ],
                    ),
                  ),
                  if (onChanged != null) Switch(value: on, onChanged: onChanged),
                ],
              ),
            ),
          ),
          if (on) Padding(padding: const EdgeInsets.fromLTRB(14, 0, 14, 14), child: child),
        ],
      ),
    );
  }
}

/// Units held, what they cost, as of when, and since when.
class OpeningFields extends StatelessWidget {
  const OpeningFields({super.key, required this.fields, required this.onChanged});

  final FundFormFields fields;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: TextField(
                key: const ValueKey('opening-units'),
                controller: fields.units,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                decoration: const InputDecoration(labelText: 'Units', hintText: '1234.567'),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: TextField(
                key: const ValueKey('opening-invested'),
                controller: fields.invested,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                decoration: const InputDecoration(labelText: 'Amount invested', prefixText: '₹ '),
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        DateField(
          label: 'As of',
          value: fields.asOf,
          onPick: () async {
            final picked = await pickIsoDate(context, initial: fields.asOf, first: DateTime(1990), last: _todayDate);
            if (picked != null) {
              fields.asOf = picked;
              onChanged();
            }
          },
        ),
        const SizedBox(height: 10),
        DateField(
          label: 'First invested on (optional)',
          value: fields.firstOn,
          placeholder: 'Not sure? Leave it',
          onClear: () {
            fields.firstOn = null;
            onChanged();
          },
          onPick: () async {
            final last = DateTime.tryParse(fields.asOf ?? '') ?? _todayDate;
            final picked = await pickIsoDate(context, initial: fields.firstOn ?? fields.asOf, first: DateTime(1990), last: last);
            if (picked != null) {
              fields.firstOn = picked;
              onChanged();
            }
          },
        ),
        const SizedBox(height: 8),
        Text(
          'Copy these off your statement or the fund app. The first date makes the yearly return (XIRR) '
          'honest about how long the money has been in.',
          style: TextStyle(fontSize: 11.5, height: 1.4, color: c.muted),
        ),
      ],
    );
  }
}

/// A SIP: how much, which day, since when, until when.
class SipFields extends StatelessWidget {
  const SipFields({super.key, required this.fields, required this.onChanged, this.showActive = false});

  final FundFormFields fields;
  final VoidCallback onChanged;

  /// Editing one that exists: it can be stopped.
  final bool showActive;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              flex: 3,
              child: TextField(
                key: const ValueKey('sip-amount'),
                controller: fields.sipAmount,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                decoration: const InputDecoration(labelText: 'Each month', prefixText: '₹ ', hintText: '5000'),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              flex: 2,
              child: TextField(
                key: const ValueKey('sip-day'),
                controller: fields.sipDay,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(labelText: 'On day', hintText: '5'),
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        DateField(
          label: 'Started on',
          value: fields.sipStart,
          onPick: () async {
            final today = _todayDate;
            final picked = await pickIsoDate(
              context,
              initial: fields.sipStart,
              first: DateTime(1990),
              last: DateTime(today.year + 1, today.month, today.day),
            );
            if (picked != null) {
              fields.sipStart = picked;
              onChanged();
            }
          },
        ),
        const SizedBox(height: 10),
        DateField(
          label: 'Ends on (optional)',
          value: fields.sipEnd,
          placeholder: 'Runs until you stop it',
          onClear: () {
            fields.sipEnd = null;
            onChanged();
          },
          onPick: () async {
            final first = DateTime.tryParse(fields.sipStart ?? '') ?? DateTime(1990);
            final picked = await pickIsoDate(context, initial: fields.sipEnd, first: first, last: DateTime(2100));
            if (picked != null) {
              fields.sipEnd = picked;
              onChanged();
            }
          },
        ),
        if (showActive) ...[
          const SizedBox(height: 4),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            value: fields.sipActive,
            onChanged: (value) {
              fields.sipActive = value;
              onChanged();
            },
            title: Text('Still running', style: TextStyle(fontSize: 14, color: c.ink)),
            subtitle: Text(
              'Turn off when you stop the SIP. Instalments up to today stay.',
              style: TextStyle(fontSize: 12, color: c.muted),
            ),
          ),
        ],
        const SizedBox(height: 8),
        Text(
          "Each month's instalment is bought at that day's NAV. Link the bank debits too, and they replace the "
          'scheduled ones, so a skipped month shows.',
          style: TextStyle(fontSize: 11.5, height: 1.4, color: c.muted),
        ),
      ],
    );
  }
}
